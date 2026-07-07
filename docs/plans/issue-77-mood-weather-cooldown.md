# Implementation guide — issue #77: cross-session cooldown for mood-weather

## Summary

`rollMood()` is gated once per session by the `injectedSessions` inject-once cache, but nothing remembers that weather *landed* across consecutive sessions. With the documented "rare" chance (~0.05–0.10), a cluster of five short same-day sessions gets five independent rolls — silly → spiky → flat in one afternoon reads as broken, not moody. Fix: a module-scope, relationship-keyed timestamp of the last time weather actually landed, mirroring the two debounce patterns this codebase already uses (`STORE_DEBOUNCE_MS`/`lastStoreAt` in `hooks/emotional-state.ts`, `TRACE_DEBOUNCE_MS`/`lastTraceAt` in `hooks/auto-trace.ts`). Once weather lands, no new roll until the window elapses — regardless of session count.

**Touches the same code as issue #71** (mood-weather observability): both restructure the two return sites inside `buildEmotionalStateFetchHandler` where a rolled mood is handled. See the inline coordination note at the `if (mood && !priorMood)` block below — #71's `recordMoodRoll` call belongs inside that guard, not on a bare `if (mood)`, or a post-compaction replay would double-log one real roll. Whichever of #71/#77 is implemented second should check the other's actual landed code rather than assume this guide's snapshot.

## Design decisions (read before coding)

1. **`rollMood()` stays pure.** It's a tested pure function with injectable `rng`; its test suite (`hooks/mood-weather.test.ts`) relies on that. The cooldown is caller state, so it lives in `hooks/emotional-state.ts` next to its sibling `lastStoreAt` — the fetch handler gates the call. **No changes to `hooks/mood-weather.ts`.**

2. **Key by `relationshipId`, not session.** The whole point is cross-session memory; keying matches `lastStoreAt`'s `cfg.relationshipId ?? ""`. Unlike the session-keyed `lastTraceAt` (which needs `buildAutoTraceSessionCleanupHandler` to avoid unbounded growth), a relationship-keyed map is bounded (effectively one entry) — so **no new cleanup hook is needed**, same as `lastStoreAt` today.

3. **Only a *landed* roll starts the cooldown.** Misses must not burn the window, otherwise each cooldown window gets exactly one attempt and effective frequency collapses far below `moodWeatherChance` semantics. Suppress only *after* weather lands.

4. **Module-scope = per-process, resets on gateway restart.** Accepted; identical limitation to both existing debounces, and the issue explicitly asks for lightweight. Persisting to disk is out of scope (note it in the PR).

5. **Interaction with compaction (must handle, or the cooldown regresses an existing behavior).** Today `buildEmotionalStateCompactionHandler` clears `injectedSessions`, so the next turn re-fetches *and re-rolls* the mood — pre-existing oddity where a mood could change mid-session after compaction. With a naive cooldown, it gets worse in the other direction: a landed mood *silently vanishes* on post-compaction re-injection (the cooldown suppresses the re-roll), violating "It lasts only this session" — which implies the *whole* session. Fix both with a small session-keyed memo of the rolled mood, replayed on re-injection. This memo *does* need cleanup in the existing `session_end` handler.

6. **Interaction with the still-extracting path.** Today the mood is rolled *before* the "state(s) still extracting" early return and discarded when that path hits (the existing comment even says "We re-roll the mood then too"). If we recorded the cooldown at roll time without reordering, a discarded roll would burn the window without ever being injected. Move the roll *below* the extracting early-return so a roll only happens when injection is guaranteed, and delete the now-stale re-roll comment.

7. **Testability.** Add an optional `deps: { now?, rng? }` third parameter to `buildEmotionalStateFetchHandler`, mirroring `rollMood`'s injectable-`rng` pattern. Backward compatible — the single call site (`index.ts`) needs no change. `now` lets tests simulate days passing; `rng` lets tests force deterministic hits/misses (with `moodWeatherChance: 1`, `rng` is optional for hit-only tests since `Math.random() < 1` always).

## Code changes — `hooks/emotional-state.ts`

### 1. State + constant (place directly after `lastStoreAt`)

```ts
/**
 * Cross-session cooldown for mood weather: once weather actually LANDS, no new
 * roll for this long, no matter how many sessions start. "Rare per session"
 * isn't "rare" when sessions cluster — five short same-day sessions would
 * otherwise get five independent rolls and can whiplash silly → spiky → flat
 * in one afternoon. Weather changes on the scale of days, not sessions.
 * Misses do NOT start the cooldown — only landed weather does, so effective
 * frequency for uncluttered sessions still tracks moodWeatherChance.
 */
export const MOOD_WEATHER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** relationshipId → when weather last actually landed (ms). Module-scoped, per process (mirrors lastStoreAt). */
const lastMoodRollAt = new Map<string, number>();

/**
 * sessionKey → the mood that landed for that session. Post-compaction
 * re-injection must replay the SAME weather — not roll new dice (mood must
 * stay stable for a whole session) and not silently drop it (the cooldown
 * would otherwise suppress the re-roll mid-session).
 */
const sessionMoods = new Map<string, MoodSpec>();
```

Import `MoodSpec` alongside the existing mood-weather imports:

```ts
import { buildMoodWeatherContext, type MoodSpec, rollMood } from "./mood-weather.ts";
```

Default of 6h is a judgment call: long enough that a same-day cluster of sessions shares one weather, short enough that morning and evening can differ. Anything ≥ ~2h kills the whiplash case; 4h/8h/12h are all defensible — maintainer's pick.

### 2. Handler signature

```ts
export function buildEmotionalStateFetchHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	deps: { now?: () => number; rng?: () => number } = {},
) {
	const now = deps.now ?? Date.now;
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
```

### 3. Restructured body

Current order: roll mood → check `usable.length === 0` (extracting return, then blank-slate branch). New order: extracting return **first**, then roll, then blank-slate branch:

```ts
			if (usable.length === 0 && states.length > 0) {
				// State(s) exist but are all still extracting — don't cache, so a
				// later turn re-fetches once extraction completes. Runs BEFORE the
				// mood roll so a discarded turn can't land weather or burn the
				// cross-session cooldown.
				log.debug(
					"emotional-context: state(s) still extracting — skipping injection this turn",
				);
				return;
			}

			// Mood weather: an exogenous, uncaused session mood that OVERRIDES the
			// arc's tone for this session only. Lives purely in the injection path —
			// never written back via the store handler, so one random morning can't
			// calcify into the baseline. May clash with the room on purpose.
			// Rolled once per session (inject-once cache) AND at most once per
			// MOOD_WEATHER_COOLDOWN_MS across sessions (a landed roll suppresses new
			// rolls; post-compaction re-injection replays the same mood instead).
			const relId = cfg.relationshipId ?? "";
			const priorMood = sessionKey ? sessionMoods.get(sessionKey) : undefined;
			const cooledDown =
				now() - (lastMoodRollAt.get(relId) ?? 0) >= MOOD_WEATHER_COOLDOWN_MS;
			const mood =
				priorMood ??
				(cfg.moodWeatherChance > 0 && cooledDown
					? rollMood(cfg.moodWeatherChance, deps.rng)
					: null);
			if (mood && !priorMood) {
				lastMoodRollAt.set(relId, now());
				if (sessionKey) sessionMoods.set(sessionKey, mood);
				log.info(`mood-weather: rolled "${mood.id}" this session`);
				// Coordination with issue #71 (mood-weather observability): if #71's
				// recordMoodRoll(client, mood, {...}) has landed, its call belongs
				// HERE — inside this `!priorMood` guard — not on a bare `if (mood)`
				// at the two return sites below. A priorMood replay (post-compaction
				// re-injection of an already-rolled mood) is not a new roll; calling
				// recordMoodRoll on replay would log the same event twice.
			}
			const moodBlock = mood ? buildMoodWeatherContext(mood) : "";

			if (usable.length === 0) {
				// No arc yet — but weather can still land on a blank slate.
				log.debug("emotional-context: no prior emotional state found");
				if (sessionKey) injectedSessions.add(sessionKey);
				return moodBlock ? { prependContext: moodBlock } : undefined;
			}
```

Everything from `log.debug(\`emotional-context: injecting …\`)` onward is unchanged. Note `rollMood(chance, deps.rng)` — passing `undefined` falls through to the `Math.random` default parameter, so no signature change to `rollMood`.

Edge case (document in a comment or the PR, no code needed): when `sessionKey` is missing the handler already fetches every call (existing "fallback" behavior, tested); the cooldown now additionally caps weather at once per window even there — strictly less whiplash than today.

### 4. Session cleanup — add the memo delete

```ts
export function buildEmotionalStateSessionCleanupHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey) {
			injectedSessions.delete(sessionKey);
			sessionMoods.delete(sessionKey);
		}
	};
}
```

**Do not** touch `lastMoodRollAt` here — the cooldown surviving session end is the entire point. **Do not** touch `sessionMoods` in `buildEmotionalStateCompactionHandler` — surviving compaction is what makes the same mood replay.

### 5. Doc comment touch-up — `config.ts`

`moodWeatherChance`'s docstring currently promises a per-session probability. Append one sentence, e.g.:

> Once weather lands, a cross-session cooldown (~6h) suppresses new rolls so a cluster of same-day sessions shares one weather.

`README.md` has no mood-weather section, so no README change (unless #72's README addition has already landed, in which case add the same sentence there).

## Tests — `hooks/emotional-state.test.ts`

Repo convention: `node:test` + `strict assert`, unique `relationshipId` per test to avoid module-scope map bleed between tests. Import `MOOD_WEATHER_COOLDOWN_MS` from `./emotional-state.ts` and `MOOD_TABLE` from `./mood-weather.ts`. Suggested section, after the arc tests:

```ts
// ---- mood weather: cross-session cooldown (issue #77) ----------------------

const moodCfg = (relationshipId: string, chance = 1) =>
	({ relationshipId, moodWeatherChance: chance }) as unknown as Parameters<
		typeof buildEmotionalStateFetchHandler
	>[1];

const hasMood = (out: unknown) =>
	String((out as { prependContext?: string })?.prependContext ?? "").includes(
		"<hyperspell-mood-weather>",
	);
```

1. **Cluster suppression (the headline test).** `makeClient("Warm and steady.")`, `moodCfg("rel-mood-cluster")`, `let t = 1_000_000`, handler built with `{ now: () => t, rng: () => 0 }`. Session `mood-s1` → assert `hasMood(first)`. Advance `t += 10 * 60 * 1000`, session `mood-s2` → assert `!hasMood(second)` **and** `prependContext` still matches `/Warm and steady/` (arc injection unaffected — only the weather is suppressed). Advance another hour, session `mood-s3` → still no mood.

2. **Rolls again after the window.** Same shape, `"rel-mood-elapse"`: first session rolls; `t += MOOD_WEATHER_COOLDOWN_MS + 1`; new sessionKey → `hasMood` true again. (This is the "sessions spread across days" case from the issue.)

3. **A miss does not start the cooldown.** `moodCfg("rel-mood-miss", 0.5)` with `let rngValue = 0.999; rng: () => rngValue`. Session 1: gate misses (`0.999 >= 0.5`) → no mood. Set `rngValue = 0`; session 2 immediately after (same `now`) → `hasMood` true, proving the miss didn't burn the window.

4. **Post-compaction re-injection replays the same mood, no new dice.** `moodCfg("rel-mood-compact")`, rng fed from a sequence: `[0, 0]` for the first roll (gate hit, picks `MOOD_TABLE[0]`), then `[0, 0.999999]` if a second roll ever happened (would pick the *last* mood). Inject session; run `buildEmotionalStateCompactionHandler()`; call handler again with the same sessionKey; assert `prependContext` includes `MOOD_TABLE[0].note` and not `MOOD_TABLE[MOOD_TABLE.length - 1].note`.

5. **Still-extracting turn doesn't consume the roll.** Mutable client: `getEmotionalState` returns the pending placeholder (`"user: hi\nassistant: hey"`) on call 1, a real summary on call 2. `moodCfg("rel-mood-pending")`, fixed `now`. First handler call → `undefined` (no injection); second call same session → injected **with** mood. Guards the reordering against regression.

6. **Existing tests need no edits.** They omit `moodWeatherChance` (→ `undefined`, so `cfg.moodWeatherChance > 0` is `false`) and the new third parameter is optional. `hooks/mood-weather.test.ts` is untouched — `rollMood` stays pure.

Run: `npm test`.

## Relationship to issue #79 (hardcoded debounce windows)

#79 proposes making `STORE_DEBOUNCE_MS` and `TRACE_DEBOUNCE_MS` configurable with the current 3-minute values as defaults. `MOOD_WEATHER_COOLDOWN_MS` is the same shape (hardcoded real-time window, module scope) but a slightly different animal: it's a product-design guardrail enforcing the "RARE… weather, not a gimmick" contract, not an ops-rhythm tuning knob — an operator who wants more weather already has `moodWeatherChance`.

**Recommendation:** land this PR with the fixed, exported constant (keeps the diff focused and #77 unblocked), and explicitly enroll it in whatever config mechanism #79 settles on — e.g. if #79 adds optional `storeDebounceMs` / `traceDebounceMs` keys (or a grouped `timings` block), add `moodWeatherCooldownMs` alongside them in that PR, default `6h`, clamped to `>= 0` (with `0` meaning "no cross-session cooldown", the pre-#77 behavior — which conveniently gives #79 a test hook). If #79 lands first, wire the cooldown through its mechanism directly in this PR instead of the constant. Either way the two should share one pattern; please cross-link both issues in the PRs.

## Out of scope (state in the PR)

- Persisting `lastMoodRollAt` across gateway restarts (same per-process limitation as `lastStoreAt` / `lastTraceAt`; a restart can re-open the weather window once).
- Making the window configurable now (deferred to #79's mechanism, above).

## Files touched

- `hooks/emotional-state.ts` — cooldown constant + `lastMoodRollAt` / `sessionMoods` maps; `MoodSpec` type import; optional `deps: { now?, rng? }` param on `buildEmotionalStateFetchHandler`; reorder extracting-check before the mood roll; gate + record at the call site; replay memo in session cleanup handler.
- `hooks/emotional-state.test.ts` — 5 new tests under a `mood weather: cross-session cooldown (issue #77)` section.
- `config.ts` — one-sentence doc-comment addition on `moodWeatherChance`.
- `hooks/mood-weather.ts`, `hooks/mood-weather.test.ts`, `index.ts` — **no changes** (documented deliberately: `rollMood` stays pure; handler param is optional).
