# Implementation guide: salience-weighted emotional-state arc selection (issue #68)

## Problem recap

The injected emotional arc is the last `EMOTIONAL_ARC_LIMIT = 3` registers (`hooks/emotional-state.ts:10`), selected by **pure recency** via `getRecentEmotionalStates` (`client.ts:653`). The store side already refuses to let automation write the register (`NON_CONVERSATIONAL_TRIGGERS`, `hooks/emotional-state.ts:26`), but every *real* conversation that clears the minimal gates (`MIN_MESSAGES = 3`, `MIN_CONVERSATION_LENGTH = 100` chars) writes an equal-weight register. Three quick check-ins in an afternoon evict a two-hour heart-to-heart from yesterday.

No signal about conversational substance is stored today: `storeEmotionalState(transcript, { relationshipId, metadata: { source: "openclaw_agent_end" } })` (`hooks/emotional-state.ts:324`) discards `messages.length` and `transcript.length` even though both are already computed in the handler.

## Design decision: where does salience live?

Three options were considered:

| Option | Backend change? | Verdict |
|---|---|---|
| **A. Backend ranks** — send a depth score at store time, `/emotional-state/recent` orders by it | Yes (ranking logic) | Most invasive; couples plugin release to backend deploy; rejected for v1 |
| **B. Client-side re-rank over a larger fetched pool** — store depth signals in the existing `metadata` field, fetch `limit × 3` candidates, re-rank locally | Only metadata **echo** on GET (may already work) | **Chosen** |
| **C. Purely local salience cache** — remember depth per resourceId in plugin memory | No | Rejected: module-scoped state dies on gateway restart; registers live server-side |

Option B is the same shape as the plugin's existing retrieval ranking (`lib/ranking.ts` — `candidateMultiplier` over-fetch + composite re-rank + recency-preserving output), so it follows an established pattern in this codebase.

**Key enabler, no client signature change needed:** `storeEmotionalState` already accepts `metadata?: Record<string, string | number | boolean>` (`client.ts:569-575`) and already forwards it into the POST body (`client.ts:585`). The only genuinely new API surface is *reading* `metadata` back on `GET /emotional-state/recent`.

**Backend verification gate (do this first):** live-verify that `POST /emotional-state` persists `metadata` and that `GET /emotional-state/recent` echoes it in each item. The store path already sends `metadata.source`, so persistence is likely; the echo is unverified — the client mapping (`client.ts:679-685`) currently drops everything except the five known fields, so we can't tell from client code alone. If the echo is missing, add it to `docs/hyperspell-backend-followups.md` as a one-line backend ask ("echo stored `metadata` in emotional-state GET responses"). Crucially, the design below **degrades gracefully to today's pure-recency behavior** when metadata is absent, so the plugin change can ship ahead of the backend echo.

**⚠️ Coordination with issue #74 (channel-tag the register) — read before implementing either.** #74 also edits the exact `storeEmotionalState` metadata literal at `hooks/emotional-state.ts:324-327`, adding `...(channelId ? { channelId } : {})`. These are compatible, not conflicting, if merged into one object rather than landed as two competing literals:

```ts
const result = await client.storeEmotionalState(transcript, {
	relationshipId: cfg.relationshipId,
	metadata: {
		source: "openclaw_agent_end",
		turn_count: userTurns,
		transcript_chars: transcript.length,
		depth_score: depthScore,
		...(channelId ? { channelId } : {}),
	},
});
```

Whichever of #68/#74 lands second must merge into the other's actual landed object rather than overwrite it. **Also fix #74's own test:** its guide's `assert.deepEqual(stores[0].opts.metadata, { source: "openclaw_agent_end", channelId: "chan-42" })` is an exact-object match that breaks the moment this guide's `turn_count`/`transcript_chars`/`depth_score` fields exist — that assertion should become per-key (`assert.equal(stores[0].opts.metadata?.channelId, "chan-42")`) regardless of landing order, not just when #68 lands first.

**⚠️ Coordination with issue #77 (mood-weather cross-session cooldown) — read before implementing either.** #77 also restructures `buildEmotionalStateFetchHandler`'s body around the `usable.length === 0` guard(s), splitting the single existing guard into an early "still extracting" return followed later by a "blank slate" branch, with mood-roll/cooldown logic sandwiched between them. This guide replaces `usable` with a re-ranked/deduped `arc` for the guard and for `buildEmotionalContext`. Reconciled merge order (safe because `selectArc` on empty input returns empty, so `arc.length === 0 ⟺ usable.length === 0` always — the two guides' guards stay equivalent):

1. Fetch `states`, compute `usable` (unchanged).
2. **Extracting early-return** (#77's first split, unchanged): `if (usable.length === 0 && states.length > 0) { ...; return; }` — keep this keyed on `usable`, not `arc`; it doesn't need the arc computed yet and firing before that work is strictly cheaper.
3. **Mood roll + cross-session cooldown** (#77's logic, unchanged) — independent of `usable`/`arc`.
4. **Compute the arc** (this guide's `selectArc`): `const arc = selectArc(usable, EMOTIONAL_ARC_LIMIT, cfg.emotionalArcDepthWeight);` — placed here, after the extracting check, since a still-extracting turn already returned above and never needs it.
5. **Blank-slate branch** (#77's second split): change its guard from `usable.length === 0` to `arc.length === 0`, per this guide's intent.
6. **Main path:** `buildEmotionalContext(arc)` (this guide) inside #77's mood-block-append logic (unchanged otherwise).

Whichever of #68/#77 lands second should apply this merged shape directly rather than re-deriving the interleaving from scratch, and should verify against the other's actual landed code (not just this snapshot).

## Why turn count + transcript chars, and why NOT duration

- `transcript.length` is already computed in `buildEmotionalStateStoreHandler` (`hooks/emotional-state.ts:305`) — free.
- User-turn count (`messages` filtered to `role === "user"`) is a better substance proxy than raw `messages.length`, which counts assistant/tool traffic that says nothing about how much the *human* invested.
- **Duration is not usable in v1.** The `agent_end` event does carry `durationMs` (OpenClaw `src/plugins/hook-types.ts` — `PluginHookAgentEndEvent { runId?, messages, success, error?, durationMs? }`), but it is `Date.now() - context.started` for a **single agent run** (OpenClaw `src/agents/cli-runner.ts:1067`) — i.e. model + tool latency of one turn, not how long the human conversation lasted. And `event.messages` is typed `unknown[]` with no timestamp contract (entries come from `loadCliSessionHistoryMessages`, which strips transcript entries down to `entry.message`), so deriving conversation duration from first/last message timestamps would depend on undocumented runner internals. Skip duration; store raw signals so a future score revision can happen at *fetch* time without re-storing.

One relevant detail: hook history is capped at 100 messages (`MAX_AGENT_HOOK_HISTORY_MESSAGES`, OpenClaw `src/agents/harness/hook-history.ts`). Our saturation constants sit far below that cap, so the ceiling is harmless.

Because `agent_end` fires per run with the **full session history**, a long conversation produces several debounced snapshots (one per `STORE_DEBOUNCE_MS`), each with a *larger* transcript than the last — the final snapshot of a deep talk naturally carries the full depth weight. This also creates a hazard the selector must handle: several high-depth snapshots of the *same* conversation would otherwise fill the whole arc (see session dedupe below).

## Implementation

### 1. `hooks/emotional-state.ts` — compute and store depth signals

Add near the existing constants:

```ts
/**
 * Depth-signal saturation points. Beyond these, more length stops adding
 * salience — a 40-turn talk and a 400-turn marathon are both "deep"; what we
 * must distinguish is check-in vs. substantive, not marathon vs. epic.
 */
const DEPTH_TURNS_SATURATION = 12;
const DEPTH_CHARS_SATURATION = 6000;

/** 0..1 salience proxy from conversation size. Exported for tests. */
export function computeDepthScore(userTurns: number, transcriptChars: number): number {
	const turnPart = Math.min(1, userTurns / DEPTH_TURNS_SATURATION);
	const charPart = Math.min(1, transcriptChars / DEPTH_CHARS_SATURATION);
	return Math.round(((turnPart + charPart) / 2) * 100) / 100;
}
```

In `buildEmotionalStateStoreHandler`, after `transcript` is computed (`hooks/emotional-state.ts:305`) and before the store call:

```ts
const userTurns = (messages as Message[]).filter((m) => m.role === "user").length;
const depthScore = computeDepthScore(userTurns, transcript.length);
```

and extend the existing store call (`hooks/emotional-state.ts:324-327`):

```ts
const result = await client.storeEmotionalState(transcript, {
	relationshipId: cfg.relationshipId,
	// Depth signals ride the existing metadata field so fetch-time arc
	// selection can weight substance vs. recency (issue #68). Raw signals
	// are stored alongside the computed score so the scoring formula can
	// change later without re-storing history.
	metadata: {
		source: "openclaw_agent_end",
		turn_count: userTurns,
		transcript_chars: transcript.length,
		depth_score: depthScore,
	},
});
```

Store the signals **unconditionally** (even when the weighting config is off) — it's three cheap fields, and it builds the history that makes enabling the weight meaningful later.

### 2. `client.ts` — surface `metadata` on fetched states

Extend the type (`client.ts:54-60`):

```ts
export type EmotionalStateLatest = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
  /** Echo of store-time metadata (depth signals live here). Absent on legacy rows or if the backend doesn't echo yet. */
  metadata?: Record<string, unknown>
}
```

Map it in `getRecentEmotionalStates` (`client.ts:679-685`) and, for symmetry, `getEmotionalState` (`client.ts:634-640`):

```ts
...(d.metadata && typeof d.metadata === "object"
	? { metadata: d.metadata as Record<string, unknown> }
	: {}),
```

No change to `storeEmotionalState` — its signature already carries metadata.

### 3. `hooks/emotional-state.ts` — over-fetch + re-rank in the fetch path

Add the selector (exported for tests):

```ts
/** Over-fetch factor when depth weighting is on — mirrors lib/ranking.ts's
 * candidateMultiplier: the deep-but-older register must be IN the pool to win. */
const ARC_CANDIDATE_MULTIPLIER = 3;
/** Recency half-life: a register loses half its recency score every 24h. */
const RECENCY_HALF_LIFE_HOURS = 24;
/** Depth assumed for registers with no depth metadata (legacy rows, backend
 * not echoing yet): neutral, so they're neither privileged nor buried. */
const NEUTRAL_DEPTH = 0.5;

function recencyScore(extractedAt: string, now: number): number {
	const t = new Date(extractedAt).getTime();
	if (Number.isNaN(t)) return 0;
	const ageHours = Math.max(0, (now - t) / 3_600_000);
	return 0.5 ** (ageHours / RECENCY_HALF_LIFE_HOURS);
}

function depthOf(s: EmotionalStateLatest): number {
	const d = s.metadata?.depth_score;
	return typeof d === "number" && d >= 0 && d <= 1 ? d : NEUTRAL_DEPTH;
}

/**
 * Pick the arc from a larger candidate pool: recency + weighted depth, with
 * two hard rules — (1) at most one register per session, so the debounced
 * snapshots of one long talk can't fill the whole arc with the same
 * conversation; (2) the single most recent register always keeps its slot,
 * because "how things feel right now" must never be ranked out by an older
 * deep talk. Output stays newest-first (the injection contract).
 */
export function selectArc(
	candidates: EmotionalStateLatest[],
	limit: number,
	depthWeight: number,
	now = Date.now(),
): EmotionalStateLatest[] {
	const seenSessions = new Set<string>();
	const deduped = candidates.filter((s) => {
		if (!s.sessionId) return true;
		if (seenSessions.has(s.sessionId)) return false;
		seenSessions.add(s.sessionId);
		return true;
	});
	if (deduped.length <= limit) return deduped;

	const [latest, ...rest] = deduped;
	const chosen = rest
		.map((s) => ({ s, score: recencyScore(s.extractedAt, now) + depthWeight * depthOf(s) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit - 1)
		.map(({ s }) => s);

	return [latest, ...chosen].sort(
		(a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime(),
	);
}
```

Rewire `fetchRecentOrLatest` (`hooks/emotional-state.ts:128-143`) to over-fetch **only when weighting is on** (so `depthWeight = 0` keeps request payloads byte-identical to today):

**⚠️ Coordination with issue #76 (on-demand `hyperspell_emotional_arc` tool) — read before implementing either.** #76 also modifies `fetchRecentOrLatest`'s signature, adding an external `limit?: number` parameter so its tool can request a different arc size on demand. These are compatible, not conflicting, IF the signature is reconciled as below — an explicit caller-supplied `limit` wins outright; the depth-weight-driven default only applies when no `limit` is passed (i.e. the hook's own call site, `fetchRecentOrLatest(client, cfg)` with no third arg):

```ts
export async function fetchRecentOrLatest(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	limit?: number,
): Promise<EmotionalStateLatest[]> {
	const fetchLimit =
		limit ??
		(cfg.emotionalArcDepthWeight > 0
			? EMOTIONAL_ARC_LIMIT * ARC_CANDIDATE_MULTIPLIER
			: EMOTIONAL_ARC_LIMIT);
	try {
		const recent = await client.getRecentEmotionalStates(cfg.relationshipId, fetchLimit);
		if (recent !== null) return recent; // endpoint available (may be empty)
	} catch (err) {
		log.debug("emotional-context: /recent unavailable — falling back to latest", err);
	}
	const single = await client.getEmotionalState(cfg.relationshipId);
	return single ? [single] : [];
}
```

If #76 lands first (before `cfg.emotionalArcDepthWeight` and `ARC_CANDIDATE_MULTIPLIER` exist), its version of this function will just be `limit ?? EMOTIONAL_ARC_LIMIT` — when implementing #68 afterward, extend that existing optional `limit` parameter with the depth-weight branch above rather than re-adding a third parameter that already exists. Whichever of #68/#76 lands second should read the other's actual merged code, not assume this snapshot.

In `buildEmotionalStateFetchHandler`, apply selection **after** the raw-transcript-placeholder filter (`hooks/emotional-state.ts:187-189`) — placeholders must not consume candidate slots:

```ts
const usable = states.filter((s) => s.summary && !looksLikeRawTranscript(s.summary));
const arc = selectArc(usable, EMOTIONAL_ARC_LIMIT, cfg.emotionalArcDepthWeight);
```

then use `arc` where `usable` is used today (`buildEmotionalContext(arc)`, the `usable.length === 0` guard becomes `arc.length === 0` — note `selectArc` on an empty array returns empty, and on the 404-fallback single-item array returns it unchanged, so both existing fallback behaviors are preserved).

Ordering note for prompt-cache friendliness: the final arc is deterministically sorted (newest-first, ties impossible in practice since `extractedAt` is server-assigned).

### 4. `config.ts` — one tunable, default off

Follow the `moodWeatherChance` precedent exactly (top-level number, clamped, default 0 so shipping changes nothing for existing installs):

- `HyperspellConfig` (`config.ts:136`): add after `moodWeatherChance`:

```ts
/**
 * How much conversational depth (turn count / transcript length, stored as
 * register metadata) counts against recency when picking the injected
 * emotional arc. 0 (default) = pure recency, today's behavior. Sane values
 * ~0.3–0.7; clamped to [0,1]. Requires emotionalContext.
 */
emotionalArcDepthWeight: number;
```

- `ALLOWED_KEYS` (`config.ts:171`): add `"emotionalArcDepthWeight"`.
- `parseConfig` return (`config.ts:539` area):

```ts
emotionalArcDepthWeight: Math.min(
	1,
	Math.max(0, (cfg.emotionalArcDepthWeight as number) ?? 0),
),
```

## Edge cases and honest tensions

- **Short-but-intense conversations.** This is the real weakness of any length proxy: a six-message "my dad is in the hospital" exchange is deeper than a forty-message scheduling thread, and `computeDepthScore` cannot see that. Three mitigations are structural: (1) the guaranteed most-recent slot means an intense short talk that *just happened* always surfaces regardless of score; (2) recency still dominates at moderate `depthWeight` — with weight 0.5, a maximally-deep register only outscores a shallow one that is ~24h fresher, it doesn't outscore everything; (3) saturation compresses the top end, so "long" beats "tiny" but "very long" doesn't beat "long". The *correct* long-term fix is an `intensity` score emitted by the backend's extraction LLM (it already reads the full transcript to distill the register) stored alongside `depth_score` and folded into `depthOf` — record that in `docs/hyperspell-backend-followups.md` as a follow-up, out of scope here. Storing raw signals now means that upgrade needs no store-path change.
- **Same-session flooding (new hazard introduced by this change).** Depth weighting makes the debounced snapshots of one long conversation *all* rank high. The `sessionId` dedupe in `selectArc` (keep newest per session) is mandatory, not optional — without it the fix replaces "three shallow talks crowd out one deep one" with "one deep talk crowds out everything else".
- **Legacy rows / backend not echoing metadata.** `depthOf` returns `NEUTRAL_DEPTH` when `depth_score` is absent or malformed. If *no* candidate has metadata, scoring reduces to recency alone and the newest-first sort reproduces today's arc exactly. This is the graceful-degradation guarantee that lets plugin and backend ship independently.
- **`depthWeight = 0` (default).** Fetch limit stays at 3, `selectArc` receives ≤3 deduped candidates... one subtlety: session dedupe *could* change the default arc if today's arc contains two snapshots of one session. To keep default behavior strictly unchanged, gate the whole `selectArc` call on `cfg.emotionalArcDepthWeight > 0` and keep the current `usable` path verbatim otherwise. (Recommended; alternatively accept dedupe-always as a strict improvement, but that makes "default off = no behavior change" false — call it out in the PR either way.)
- **Unparseable `extractedAt`.** `recencyScore` returns 0 (NaN guard), matching `relativeWhen`'s existing defensiveness; such a register can still win a slot on depth alone rather than crashing selection.
- **Mixed clocks.** `now` is injected into `selectArc` for test determinism; future-dated `extractedAt` clamps to age 0 via `Math.max(0, …)`.

## Tests

All in the existing `node:test` + `assert/strict` style; `pnpm`-free (`package.json` test script is `node --test --experimental-strip-types …` and already lists `hooks/emotional-state.test.ts`).

**`hooks/emotional-state.test.ts`** — extend `State` with `metadata?`, extend `makeStoreClient` to also capture `opts.metadata`, and extend `makeArcClient` to record the `limit` it was called with:

```ts
test("computeDepthScore — saturates and orders check-in below substantive talk", () => {
	assert.ok(computeDepthScore(2, 300) < computeDepthScore(10, 5000));
	assert.equal(computeDepthScore(50, 100_000), 1, "saturates at 1");
	assert.equal(computeDepthScore(0, 0), 0);
});

test("emotional-state store — attaches depth signals to metadata", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(client as …, storeCfg("rel-depth"));
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	const md = stores[0].opts.metadata as Record<string, unknown>;
	assert.equal(md.turn_count, 2, "counts user-role messages only");
	assert.equal(typeof md.transcript_chars, "number");
	assert.ok((md.depth_score as number) > 0 && (md.depth_score as number) <= 1);
});

test("selectArc — deep older register survives a burst of shallow check-ins", () => {
	// 1 deep talk 36h ago + 4 shallow check-ins in the last 3h; limit 3.
	// Pure recency would evict the deep one; depthWeight 0.5 must keep it.
	const deep = { ...st("Deep and raw.", hoursAgo(36)), sessionId: "s-deep",
		metadata: { depth_score: 1 } };
	const shallow = [1, 2, 3, 4].map((h) => ({
		...st(`Quick check-in ${h}.`, hoursAgo(h)), sessionId: `s-${h}`,
		metadata: { depth_score: 0.1 } }));
	const arc = selectArc([...shallow, deep], 3, 0.5, NOW);
	assert.ok(arc.some((s) => s.summary.includes("Deep and raw")));
	assert.equal(arc[0].summary, "Quick check-in 1.", "latest always keeps its slot, arc stays newest-first");
});

test("selectArc — depthWeight 0 reproduces pure recency", () => { /* same pool → top-3 newest */ });
test("selectArc — at most one register per session (debounced snapshots don't flood)", () => { /* 3 snapshots of s-long + 2 others, limit 3 → arc has ≤1 s-long */ });
test("selectArc — missing metadata is neutral, not buried", () => { /* legacy row without metadata still selectable */ });
test("selectArc — invalid extractedAt doesn't throw and scores recency 0", () => { … });

test("emotional-state fetch — over-fetches candidates only when depth weighting is on", async () => {
	// cfg { emotionalArcDepthWeight: 0.5 } → recorded limit === 9; weight 0 → limit === 3.
});
test("emotional-state fetch — placeholders don't consume candidate slots", async () => {
	// 9 candidates, 2 raw-transcript placeholders → arc built from the 7 usable.
});
```

(`hoursAgo`/`NOW` are tiny fixed-clock helpers; pass `now` into `selectArc` so tests never depend on wall time.)

**`client.test.ts`** — reuse the existing `stubFetch` pattern with a GET-shaped response:

```ts
test("getRecentEmotionalStates — maps metadata through when the backend echoes it", async () => { … });
test("getRecentEmotionalStates — omits metadata cleanly when the backend doesn't", async () => { … });
```

**`config.test.ts`** — mirror the `moodWeatherChance` tests: default 0, honors override, clamps `-1 → 0` and `3 → 1`, unknown-key strictness already covered by `ALLOWED_KEYS`.

## Longer-horizon validation (per the issue's "how we'd test it")

Add a debug-level log line in the fetch handler when weighting is active: `emotional-context: arc=[resourceId:score,…] pool=N` — with `debug: true` this makes it possible to diff, over weeks of real sessions, which registers a recency-only arc vs. the weighted arc would have surfaced, using only logs (no extra storage). Cheap, and it directly answers "does salience weighting keep substantive conversations in the arc longer".

## Files touched

- `hooks/emotional-state.ts` — `computeDepthScore`, depth metadata on store, `selectArc`, over-fetch + selection wiring in `fetchRecentOrLatest`/`buildEmotionalStateFetchHandler`, new constants (`ARC_CANDIDATE_MULTIPLIER`, `RECENCY_HALF_LIFE_HOURS`, `NEUTRAL_DEPTH`, saturation constants)
- `hooks/emotional-state.test.ts` — depth-score, store-metadata, `selectArc`, over-fetch, and placeholder-slot tests
- `client.ts` — `EmotionalStateLatest.metadata?`, metadata mapping in `getRecentEmotionalStates` (and `getEmotionalState`)
- `client.test.ts` — metadata round-trip mapping tests
- `config.ts` — `emotionalArcDepthWeight` (type, `ALLOWED_KEYS`, `parseConfig` clamp)
- `config.test.ts` — default/override/clamp tests
- `README.md` — document the new key next to `emotionalContext`/`moodWeatherChance`
- `docs/hyperspell-backend-followups.md` — (conditional) metadata echo on emotional-state GETs; (follow-up) extraction-time `intensity` score for short-but-intense conversations
