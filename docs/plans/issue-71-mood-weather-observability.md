# Implementation guide — issue #71: make mood-weather rolls observable without ever feeding them back

## Design summary

Each time a mood actually lands (i.e. is injected into a session), fire-and-forget a small memory row tagged `openclaw_source: "mood_weather"` via the existing `memories.add` write path, and extend the existing exclude-filter mechanism in `lib/filters.ts` so that tag is dropped from every recall path the same way `agent_end` traces already are. The "never writes forward" guarantee stays enforced by construction: the emotional-state **store** handler (`POST /emotional-state`) is untouched, the record goes to a completely separate store (vault memories), and the arc **fetch** (`GET /emotional-state[/recent]`) can never return it because it reads a different endpoint keyed by `relationship_id`. The only new leak surface is generic memory recall — which is exactly what the exclude filter closes.

**No backend change is needed.** This is purely client-side:

- `memories.add` metadata is **proven** to persist and be filterable — canary `A` in `docs/filter-dialect-test.mjs` was tagged via `memories.add` and both matched `{$eq}` and was dropped by `{$ne}` (see truth table in `docs/hyperspell-backend-followups.md`).
- Do **not** use `POST /messages` (`sendMessages`) for this — per the warning in `lib/filters.ts:30-33`, a `/messages` write carrying metadata renders the row non-retrievable.
- No new `HyperspellClient` method is needed. `client.ts`'s `addMemory` already accepts arbitrary metadata and its default `openclaw_source: "command"` is overridden by the spread (`client.ts:290-297`: `openclaw_source: "command", ...options?.metadata`), so passing `metadata: { openclaw_source: "mood_weather", ... }` wins. Reuse it.

The one open backend question is the **multi-value filter shape** (step 0 below).

## Step 0 (blocking): verify the multi-value filter shape live

Today's shipped filter is exactly:

```ts
// lib/filters.ts:39-41
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  openclaw_source: { $ne: "agent_end" },
}
```

We now need to exclude **two** values when both auto-trace and mood-weather are enabled. The pre-#1921 truth table (`docs/hyperspell-backend-followups.md:39-49`) shows `$nin` behaved *differently* from `$ne` (returned 4 rows vs `$ne`'s 7) and `$and:[{$ne}]` returned **0 rows**. Backend #1921 changed `$ne` to MongoDB absent-field semantics (per the header comment in `lib/filters.ts:19-23`), but `$nin` and `$and`-of-`$ne` have **not been re-verified post-#1921**.

Before writing the filter code, extend `docs/filter-dialect-test.mjs`:

1. Add a canary `M` — `memories.add` with `metadata: { openclaw_source: "mood_weather" }` (copy the `A` canary block).
2. Add to `FILTERS`:
   - `["$nin[agent_end,mood_weather]", { openclaw_source: { $nin: ["agent_end", "mood_weather"] } }]`
   - `["$and[$ne,$ne]", { $and: [{ openclaw_source: { $ne: "agent_end" } }, { openclaw_source: { $ne: "mood_weather" } }] }]`
3. Run it. Success criterion: `U=Y, A=N, M=N, status 200`.

Pick whichever shape passes (prefer `$nin` — one predicate, likely same ~1s cost as the current single `$ne`; `$and`-of-`$ne` is the fallback). **Contingency:** if neither passes, single-value `$ne` still covers the two common configs (only one feature on at a time — see gating below); file a backend follow-up in the style of `docs/hyperspell-backend-followups.md` for the both-on combo and log a warning when both features are enabled. The rest of this guide assumes `$nin` verifies.

## 1. Filter change — `lib/filters.ts`

Replace the single-value constant with a config-driven list. Keep the per-feature gating pattern (it exists for the ~1s/search latency of any `openclaw_source` predicate):

```ts
/** Metadata tag values excluded from all generic recall. */
export const AGENT_END_SOURCE = "agent_end"
export const MOOD_WEATHER_SOURCE = "mood_weather"

/** Minimal slice of config the exclude logic needs (avoids a config-module cycle). */
type ExcludeCfg = {
  autoTrace: { enabled: boolean }
  emotionalContext: boolean
  moodWeatherChance: number
}

export function excludeFilterFor(
  cfg: ExcludeCfg,
): Record<string, unknown> | undefined {
  const excluded: string[] = []
  if (cfg.autoTrace.enabled) excluded.push(AGENT_END_SOURCE)
  // Mood rolls are recorded only when the emotional-context handler is
  // registered AND the dice are live — same "no rows to hide → skip the
  // ~1s predicate" gate as auto-trace.
  if (cfg.emotionalContext && cfg.moodWeatherChance > 0) {
    excluded.push(MOOD_WEATHER_SOURCE)
  }
  if (excluded.length === 0) return undefined
  // Single value: keep the proven plain-$ne shape. Two values: $nin
  // (verified live post-#1921 — see docs/filter-dialect-test.mjs).
  if (excluded.length === 1) return { openclaw_source: { $ne: excluded[0] } }
  return { openclaw_source: { $nin: excluded } }
}
```

- **Delete** `EXCLUDE_SESSION_END_FILTER` — its only consumers are `lib/filters.ts` and `lib/filters.test.ts` (verified by grep); update the tests rather than keeping the stale export.
- `mergeWithExclude` needs **no change** — it delegates to `excludeFilterFor`.
- All production call sites pick this up automatically with zero edits, because they pass the full `HyperspellConfig` (which structurally satisfies the widened `ExcludeCfg`): `hooks/auto-context.ts:193`, `hooks/auto-context.ts:278`, `hooks/auto-context.ts:291`, `tools/search.ts:90`.

### Closing the remaining recall paths

- **Emotional-state arc fetch** — nothing to do; excluded by construction. `getEmotionalState` / `getRecentEmotionalStates` (`client.ts:612-688`) read `GET /emotional-state[/recent]`, a separate store that only `storeEmotionalState` writes to. A vault memory row cannot appear there. State this in a comment on the write helper.
- **Startup-orientation loops search** — `hooks/startup-orientation.ts:271-274` calls `client.search(so.loopsQuery, { limit, userId })` with **no filter**. This is a context-injection path; add `filter: excludeFilterFor(cfg)`. (Note in the PR: this also closes a pre-existing gap where `agent_end` traces could surface in the loops block.) The recent-interactions paths are already safe: `fetchRecentConversations` skips any row with a truthy `metadata.openclaw_source` (`hooks/startup-orientation.ts:185`), and `fetchRecentTraces` requires `openclaw_source === "agent_end"` (`hooks/startup-orientation.ts:130`).
- **Knowledge graph** — `graph/ops.ts:94-107` `scanMemories` iterates all memories and would ingest mood rows into the graph (which feeds context). Add after line 106: `if (mem.metadata?.openclaw_source === MOOD_WEATHER_SOURCE) continue` (import from `lib/filters.ts`).
- **`/getcontext`** (`commands/slash.ts:75`) does not apply the exclude filter today (for `agent_end` either). That's an operator-facing command reply, not agent context, so leaving it is consistent — and it doubles as an ad-hoc retrieval path. Leave as-is; note in the PR.

## 2. Write path — record the roll

### Helper in `hooks/mood-weather.ts`

Put the recorder next to the mood table it describes (it imports `MOOD_WEATHER_SOURCE` from `lib/filters.ts` — hooks→lib is the normal direction, no cycle):

```ts
import type { HyperspellClient } from "../client.ts";
import { MOOD_WEATHER_SOURCE } from "../lib/filters.ts";
import { log } from "../logger.ts";

/** Collection the roll records live in, so /moodweather can list them without a search. */
export const MOOD_WEATHER_COLLECTION = "mood-weather";

/**
 * Fire-and-forget observability record for a mood roll (issue #71).
 *
 * This does NOT weaken the "does not write forward" contract above: the record
 * goes to the generic vault store tagged openclaw_source="mood_weather", which
 * excludeFilterFor() drops from every recall path (auto-context, the
 * hyperspell_search tool, startup-orientation loops, knowledge graph). The
 * emotional-state arc fetch reads a different endpoint entirely, so it can
 * never surface there. Queryable only via the dedicated /moodweather command.
 *
 * Deliberately not awaited: this sits on the first-turn injection hot path, and
 * a logging write must never delay or break the session.
 */
export function recordMoodRoll(
  client: HyperspellClient,
  mood: MoodSpec,
  opts: { sessionKey?: string; relationshipId?: string },
): void {
  const rolledAt = new Date().toISOString();
  void client
    .addMemory(
      `Mood weather roll: woke up "${mood.id}" (${rolledAt}). Exogenous session mood — uncaused, session-only, never part of the relational register.`,
      {
        title: `Mood weather — ${mood.id} (${rolledAt.slice(0, 10)})`,
        collection: MOOD_WEATHER_COLLECTION,
        metadata: {
          openclaw_source: MOOD_WEATHER_SOURCE,
          mood: mood.id,
          rolled_at: rolledAt,
          ...(opts.sessionKey ? { session: opts.sessionKey } : {}),
          ...(opts.relationshipId ? { relationship_id: opts.relationshipId } : {}),
        },
      },
    )
    .catch((err) => {
      // Fire-and-forget — observability must never break the session.
      log.warn("mood-weather: roll record write failed (non-fatal)", err);
    });
}
```

Also update the `DOES NOT WRITE FORWARD` bullet in the file header (`hooks/mood-weather.ts:21-24`) to say: *"…A private, recall-excluded observability record IS written per roll (issue #71) — see recordMoodRoll; it is invisible to every injection/recall path, so the guarantee holds."*

### Call sites in `hooks/emotional-state.ts` (`buildEmotionalStateFetchHandler`)

Critical placement detail: the handler can roll a mood and then **discard** it — the "still extracting" branch (`hooks/emotional-state.ts:202-212`) returns without injecting `moodBlock`, and the next turn re-rolls. Record **only when the mood block is actually returned**, or the log will show weather that never happened. Two injection sites:

```ts
// blank-slate return
if (sessionKey) injectedSessions.add(sessionKey);
if (mood) recordMoodRoll(client, mood, { sessionKey, relationshipId: cfg.relationshipId });
return moodBlock ? { prependContext: moodBlock } : undefined;
```

In the arc branch:

```ts
if (sessionKey) injectedSessions.add(sessionKey);
if (mood) recordMoodRoll(client, mood, { sessionKey, relationshipId: cfg.relationshipId });
return { prependContext: context };
```

Because the inject-once cache (`injectedSessions`) gates the whole path, this is at most **one record per injected session** — matching the roll semantics exactly.

**Quarantine is inherited for free:** the merged start-handler wrapper in `index.ts` skips the fetch handler entirely for `excludeChannels` conversations, so no roll and no write happen there — consistent with the "no memory writes" quarantine contract.

## 3. Retrieval path — `/moodweather` command (in scope, small)

Include it in this PR: it's ~30 lines, it's the only way to satisfy the issue's third test ("CAN be retrieved via a dedicated path"), and it follows the existing pattern in `commands/slash.ts`. Register alongside `/getcontext`:

```ts
// /moodweather — private roll history (operator retrospection only; these rows
// are excluded from all agent recall, so this command is the ONLY reader).
api.registerCommand({
  name: "moodweather",
  description: "Show recent mood-weather rolls (never fed back into tone)",
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => {
    try {
      const rows: Array<{ mood: string; rolledAt: string }> = []
      for await (const mem of client.listMemories({
        collection: MOOD_WEATHER_COLLECTION,
        pageSize: 50,
      })) {
        if (mem.metadata?.openclaw_source !== MOOD_WEATHER_SOURCE) continue
        rows.push({
          mood: String(mem.metadata.mood ?? "?"),
          rolledAt: String(mem.metadata.rolled_at ?? ""),
        })
        if (rows.length >= 20) break
      }
      if (rows.length === 0) return { text: "No mood-weather rolls recorded." }
      const lines = rows.map((r) => `• ${r.rolledAt.slice(0, 16).replace("T", " ")} — ${r.mood}`)
      return { text: `Recent mood-weather rolls (newest first):\n${lines.join("\n")}` }
    } catch (err) {
      log.error("/moodweather failed", err)
      return { text: "Failed to fetch mood-weather history. Check logs for details." }
    }
  },
})
```

`listMemories` returns newest-first, and the mood + timestamp live in metadata, so no content parsing is needed. A `/moodweather clear` (bulk `deleteMemory`) is a reasonable **follow-up**, not this PR.

## 4. Tests

### `lib/filters.test.ts` (rewrite the fixtures)

```ts
const BOTH_OFF = { autoTrace: { enabled: false }, emotionalContext: false, moodWeatherChance: 0 }
const TRACE_ON = { autoTrace: { enabled: true },  emotionalContext: false, moodWeatherChance: 0 }
const MOOD_ON  = { autoTrace: { enabled: false }, emotionalContext: true,  moodWeatherChance: 0.1 }
const BOTH_ON  = { autoTrace: { enabled: true },  emotionalContext: true,  moodWeatherChance: 0.1 }
```

- `excludeFilterFor(BOTH_OFF)` → `undefined`
- `excludeFilterFor(TRACE_ON)` → `{ openclaw_source: { $ne: "agent_end" } }` (proves the shipped single-`$ne` shape is byte-identical to today's — no regression for existing users)
- `excludeFilterFor(MOOD_ON)` → `{ openclaw_source: { $ne: "mood_weather" } }`
- `excludeFilterFor(BOTH_ON)` → `{ openclaw_source: { $nin: ["agent_end", "mood_weather"] } }`
- mood gate requires **both** flags: `{ ...MOOD_ON, emotionalContext: false }` → `undefined`; `{ ...MOOD_ON, moodWeatherChance: 0 }` → `undefined`
- `mergeWithExclude(base, BOTH_ON)` → `{ $and: [base, <nin filter>] }`; `mergeWithExclude(base, BOTH_OFF)` → `base`

### `hooks/emotional-state.test.ts` (roll → write)

Extend `FakeClient` with a recorder. Use `cfg = { relationshipId: "rel-x", emotionalContext: true, moodWeatherChance: 1 }` — chance 1 makes `rollMood` deterministic. Since the write is un-awaited, flush microtasks with `await new Promise((r) => setImmediate(r))` before asserting.

1. **Roll triggers exactly one tagged write:** first turn with a usable arc → `prependContext` contains `<hyperspell-mood-weather>`; after flush, `client.added.length === 1`, tagged `mood_weather`, valid mood id, valid timestamp, correct collection. Second turn same session → no new write (inject-once cache).
2. **Write failure never breaks the session:** `addMemory` rejects → handler still resolves with the injection; no throw, no unhandled rejection.
3. **Discarded roll is not recorded:** arc client returning only raw-transcript-placeholder states with `moodWeatherChance: 1` → handler returns `undefined` and `client.added.length === 0`.
4. **Chance 0 → no write.**

### Live proof (before landing)

1. Run the extended `docs/filter-dialect-test.mjs` — the `$nin` row must show `U=Y, A=N, M=N`.
2. On a dev agent set `moodWeatherChance: 1`, start a fresh session; confirm the log line and that `/moodweather` shows the entry.
3. Negative recall check: send a prompt that is a strong semantic match for the record text and confirm auto-context/hyperspell_search return no `mood_weather` row.

## 5. Edge cases and decisions to state in the PR

- **Fire-and-forget contract:** never `await` because the write sits on the first-turn injection path; matches the store handler's "never let this break the session" pattern.
- **Filter gating tradeoff (pre-existing, now shared):** if `moodWeatherChance` later goes back to 0, old rows lose their filter gate — same accepted tradeoff the `agent_end` gate has. Document it; a cleanup command is follow-up material.
- **Multi-user:** the record is written as the primary configured user (no `userId` passed), same as the emotional register itself.
- **`/messages` is off-limits** for this write; `memories.add` is the proven path.
- **Backend coordination:** none required for the core feature. Only the both-features-on `$nin` shape needs live confirmation (step 0); if it fails, ship the single-`$ne` gating and file a backend dialect follow-up.

## Files touched

- `lib/filters.ts` — `AGENT_END_SOURCE`/`MOOD_WEATHER_SOURCE` constants, list-driven `excludeFilterFor` (`$ne`/`$nin`), widened `ExcludeCfg`, delete `EXCLUDE_SESSION_END_FILTER`
- `lib/filters.test.ts` — new gating/shape truth-table tests
- `hooks/mood-weather.ts` — `recordMoodRoll`, `MOOD_WEATHER_COLLECTION`, header-contract comment update
- `hooks/emotional-state.ts` — call `recordMoodRoll` at the two injection return sites in `buildEmotionalStateFetchHandler`
- `hooks/emotional-state.test.ts` — roll-writes-record, write-failure, discarded-roll, chance-0 tests
- `hooks/startup-orientation.ts` — add `filter: excludeFilterFor(cfg)` to the loops search
- `graph/ops.ts` — skip `mood_weather`-tagged rows in `scanMemories`
- `commands/slash.ts` — `/moodweather` history command
- `docs/filter-dialect-test.mjs` — `M` canary + `$nin`/`$and` probe rows
- `hooks/auto-context.test.ts`, `tools/search.test.ts` — fixture config fields only, if the compiler asks
