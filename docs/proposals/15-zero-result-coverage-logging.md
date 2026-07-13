# Proposal 15 — Log zero-result searches as a coverage signal, separate from ranking

Idea #15 from the retrieval-relevance brainstorm (#66). This is an implementation guide, not an implementation — no functional code ships with this PR.

## 1. Summary

Every ranking idea in #66 assumes the right memory exists in the vault and just needs to surface better. If a fact was never captured — said while autoTrace was off, in a quarantined channel, or simply never `/remember`ed — no ranking tweak can fix it, and today nothing distinguishes "ranking failed" from "it was never stored." This proposal adds a small, local-only, append-only JSONL coverage log: whenever an auto-context search *succeeds* but injects nothing (zero candidates, or candidates that all fell below the relevance threshold), we durably record the prompt, the candidate counts before/after thresholding, the top score, and the session id. After a couple of weeks of normal operation, a short manual review pass sorts the entries into "capture gap" vs "correctly found nothing" vs "ranking near-miss" — telling us whether the next round of effort should go toward capture (idea #14, hot-buffer coverage, `/remember` discipline) or toward ranking.

## 2. Problem

The signal we need already occurs on every no-injection turn — we just throw it away.

**Single-user path.** In `buildAutoContextHandler` (`hooks/auto-context.ts:156`), when no memory clears the bar the entire outcome is one ephemeral debug line (`hooks/auto-context.ts:226-229`):

```ts
if (!formatted) {
  log.debug("auto-context: no relevant memories found")
  return
}
```

This is debug-level (invisible unless `cfg.debug` is on — `logger.ts:26-30`), unstructured, and routed to wherever the host's plugin logger goes. The prompt that produced zero results is not preserved anywhere durable, and the line doesn't even distinguish the two very different ways we got here:

- `client.search` (`hooks/auto-context.ts:193`) returned **zero candidates** (possibly after `dropCurrentSession` at `hooks/auto-context.ts:192-195` removed the live session's own rows), or
- candidates **existed but all fell below `cfg.relevanceThreshold`** — `formatSelected` (`hooks/auto-context.ts:75-96`, fed by `selectRanked`, `lib/ranking.ts:128`) or `formatHighlightBullets` (`hooks/auto-context.ts:44-67`) returned `null`.

**Multi-user path.** `multiUserSearch` (`hooks/auto-context.ts:242`) has the same blind spot at `hooks/auto-context.ts:365-378`: when neither the personal nor the shared lane produced a memory section (`!haveMemorySections`), it logs the identical debug line (`hooks/auto-context.ts:370`) and moves on (still injecting the identity preamble for known senders — that's injection of *identity*, not *memory*, and is coverage-irrelevant).

**What this is NOT about.** Search *failures* are a different case and already have structured handling: the single-user `catch` at `hooks/auto-context.ts:231-238` and the per-lane rejected-promise branches at `hooks/auto-context.ts:303-322` go through `classifySearchError`/`logSearchError` (`lib/search-error.ts:87-105`, `144-158`), which exist precisely to stop "backend unavailable" being misread as "no memories" (issue #39). A failed search tells us nothing about capture coverage and must not pollute the coverage log. This proposal covers only the *legitimate* outcome: search succeeded and genuinely came back empty or below-threshold. The one interaction point is the multi-user path, where one lane can fail while the other succeeds — handled explicitly below.

## 3. Proposed design

### 3.1 What counts as a loggable event

One coverage event per handled prompt, only when auto-context injected **no memory sections**, with an `outcome` discriminator because the two cases point at different fixes:

| `outcome` | Meaning | What it suggests |
|---|---|---|
| `"empty"` | Search succeeded, zero candidates after `dropCurrentSession` | Capture question: was this ever stored? |
| `"below_threshold"` | Candidates existed, none survived threshold/quota formatting | Ranking/threshold question: `topScore` vs `threshold` says how near the miss was |

Explicitly **not** loggable:

- Any thrown/rejected search (single-user `catch`; in multi-user, if **every executed lane rejected** we record nothing — that's an availability event, already logged by `logSearchError`, and "unknown" is not "zero").
- Prompts shorter than 5 chars — the handler already returns before searching (`hooks/auto-context.ts:165`), so these never reach the logger. No extra gate needed.
- Multi-user turns where at least one memory section was injected — partial coverage is coverage.

Multi-user granularity: **one event per turn**, not one per lane, with a `lanes` array carrying per-lane detail. A lane that rejected is recorded as `status: "error"` with no counts, so a reviewer never misreads "personal lane was down" as "personal memory is empty" — this is the same distinction #39 forced on the agent-facing path, kept intact in the log schema. The event is written only when at least one lane fulfilled.

### 3.2 File format and location

**JSONL, append-only, at `<workspaceDir>/.hyperspell-coverage.jsonl`.**

- **JSONL** because the write is a single `appendFileSync` of one line (no read-modify-write, no lock, unlike the sync manifest), and review is line-by-line by construction — `jq` and a text editor both work directly.
- **Location** follows the existing local-state precedent: `sync/markdown.ts:51` keeps `.hyperspell-sync-hashes.json` under the workspace dir, and both it and the hot buffer resolve that dir via the already-exported `getWorkspaceDir()` (`config.ts:625`). No new path-resolution mechanism.
- **Testability** follows `buildHotBufferHandler`'s injectable-root pattern (`hooks/hot-buffer.ts:133-137`): `opts?.stateRoot ?? getWorkspaceDir()`, so tests never touch the developer's real `~/.openclaw` workspace (see the warning comment in `hooks/hot-buffer.test.ts:43-48`).
- **Not `log.debug`**: debug output is gated off in exactly the deployments we want to observe (see §6), interleaved with everything else the host logs, routed somewhere we don't control, and not reviewable as structured data weeks later. A dedicated file is the whole point — durable, queryable, ours.

One line per event, schema version stamped for forward compatibility:

```jsonc
// single-user, true zero
{"v":1,"ts":"2026-07-07T18:04:11.312Z","outcome":"empty","prompt":"what did we decide about the staging DB migration?","fetched":0,"candidates":0,"droppedCurrentSession":0,"topScore":null,"threshold":0.6,"ranking":true,"sessionId":"sess-8f2c"}

// single-user, below threshold (the interesting near-miss case)
{"v":1,"ts":"2026-07-07T18:09:40.021Z","outcome":"below_threshold","prompt":"remind me who owns the billing retry work","fetched":6,"candidates":4,"droppedCurrentSession":2,"topScore":0.54,"threshold":0.6,"ranking":true,"sessionId":"sess-8f2c"}

// multi-user, mixed lanes: shared lane errored, personal lane genuinely empty
{"v":1,"ts":"2026-07-07T18:12:02.940Z","outcome":"empty","prompt":"when is grandma's flight landing","fetched":0,"candidates":0,"droppedCurrentSession":0,"topScore":null,"threshold":0.6,"ranking":false,"sessionId":"sess-11a0","userId":"kid-2","lanes":[{"lane":"personal","status":"ok","candidates":0,"topScore":null},{"lane":"shared","status":"error"}]}
```

Field notes:

- `prompt` — truncated to **500 chars**. Enough to judge "should this have found something"; bounds line size and file growth. Full-prompt fidelity is not needed for labeling.
- `fetched` / `candidates` / `droppedCurrentSession` — pre-drop count, post-drop count, and the delta, so a session-echo-dominated result set (issue #42 territory) is visible as such.
- `topScore` — `max(r.score)` over post-drop candidates (`null` when empty). This single number does most of the review work: `topScore 0.54` against `threshold 0.6` is a ranking near-miss; `topScore 0.12` means the vault has nothing close — a capture question.
- `outcome` for multi-user is `"below_threshold"` if **any** fulfilled lane had candidates, else `"empty"`; top-level counts are sums/max over fulfilled lanes, with per-lane detail preserved in `lanes`.
- `sessionId` — from `resolveCurrentSessionId` (`hooks/auto-context.ts:169`), omitted when unresolvable.

**Sensitivity decision: local-only, truncation but no redaction.** Prompt text can contain sensitive personal content, so this must be stated in code comments and README: the coverage log is written **only** to the local workspace dir and is **never** sent to Hyperspell's backend or anywhere remote — same trust domain as the hot-buffer state files and sync manifest already living there, and strictly less sensitive than the conversation content the hot buffer already uploads. Within that boundary, redaction would defeat the feature: you cannot label "capture gap vs correctly absent" on a prompt you can't read. The concessions to sensitivity are (a) the 500-char truncation, (b) the size cap + rotation in §3.4 so content ages out instead of accumulating forever, and (c) an opt-out config flag (§6). Anything stronger (hashing, PII scrubbing) belongs to a future *remote* aggregation idea, not this local one.

### 3.3 Where the hook plugs in

New module `lib/coverage-log.ts` (mirrors `lib/search-error.ts` in spirit: one shared, well-commented mechanism used identically by every retrieval path):

```ts
// lib/coverage-log.ts
import * as fs from "node:fs"
import * as path from "node:path"
import { getWorkspaceDir } from "../config.ts"
import { log } from "../logger.ts"

export const COVERAGE_LOG_NAME = ".hyperspell-coverage.jsonl"
const MAX_PROMPT_CHARS = 500
const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface CoverageLane {
  lane: "personal" | "shared"
  status: "ok" | "error"
  candidates?: number
  topScore?: number | null
}

export interface CoverageEvent {
  outcome: "empty" | "below_threshold"
  prompt: string
  fetched: number
  candidates: number
  droppedCurrentSession: number
  topScore: number | null
  threshold: number
  ranking: boolean
  sessionId?: string
  userId?: string
  lanes?: CoverageLane[]
}

/**
 * Append one coverage event to the LOCAL-ONLY coverage log. Never sent to the
 * backend. Best-effort by contract: any failure is swallowed (debug-logged) —
 * a coverage write must never throw into, block, or delay the turn.
 */
export function recordCoverageEvent(event: CoverageEvent, stateRoot?: string): void {
  try {
    const dir = stateRoot ?? getWorkspaceDir()
    const p = path.join(dir, COVERAGE_LOG_NAME)
    rotateIfOversized(p)
    const line = JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      ...event,
      prompt: event.prompt.slice(0, MAX_PROMPT_CHARS),
    })
    fs.appendFileSync(p, `${line}\n`)
  } catch (err) {
    log.debug(`coverage-log: append failed — ${String(err)}`)
  }
}

/** One-generation rotation: current file > cap → rename to .old (replacing the
 * previous .old), start fresh. Total footprint bounded at ~2× MAX_LOG_BYTES. */
function rotateIfOversized(p: string): void {
  try {
    if (fs.statSync(p).size > MAX_LOG_BYTES) fs.renameSync(p, `${p}.old`)
  } catch {
    /* missing file or rename race — appendFileSync creates/handles it */
  }
}
```

Notes on mechanism: `appendFileSync` with a single small line is effectively atomic on local filesystems and takes microseconds; it runs only on the *no-injection* branch (after the search already round-tripped the network), so it cannot meaningfully delay a turn. Sync-vs-async here buys ordering and no unhandled-rejection surface — matching the repo's degrade-safely rule. The `topScore` helper is one line worth inlining at call sites:

```ts
const topScore = (rs: SearchResult[]): number | null =>
  rs.length ? Math.max(...rs.map((r) => r.score ?? 0)) : null
```

**Insertion point 1 — single-user, `hooks/auto-context.ts:226-229`.** `buildAutoContextHandler` gains the hot-buffer-style `opts?: { stateRoot?: string }` third parameter (wiring at `index.ts:154` unchanged — the parameter is optional):

```ts
if (!formatted) {
  log.debug("auto-context: no relevant memories found")
  recordCoverageEvent(
    {
      outcome: results.length > 0 ? "below_threshold" : "empty",
      prompt,
      fetched: rawResults.length,        // capture the pre-drop array (see below)
      candidates: results.length,
      droppedCurrentSession: rawResults.length - results.length,
      topScore: topScore(results),
      threshold: cfg.relevanceThreshold,
      ranking: ranking.enabled,
      sessionId: currentSessionId,
    },
    opts?.stateRoot,
  )
  return
}
```

Small refactor required: split the nested call at `hooks/auto-context.ts:192-195` into `const rawResults = await client.search(...)` then `const results = dropCurrentSession(rawResults, currentSessionId)` so `fetched` is observable. Behavior identical.

**Insertion point 2 — multi-user, `hooks/auto-context.ts:369-378`** (inside `if (!haveMemorySections)`, before the early returns; `multiUserSearch` gains a `stateRoot?: string` parameter threaded from the builder). The per-lane raw counts need the same split applied to the fulfilled branches at `hooks/auto-context.ts:298-323`:

```ts
if (!haveMemorySections) {
  log.debug("auto-context: no relevant memories found")
  const lanes: CoverageLane[] = []
  if (personalSearch)
    lanes.push(
      personalOk
        ? { lane: "personal", status: "ok", candidates: personalResults.length, topScore: topScore(personalResults) }
        : { lane: "personal", status: "error" },
    )
  if (sharedSearch)
    lanes.push(
      sharedOk
        ? { lane: "shared", status: "ok", candidates: sharedResults.length, topScore: topScore(sharedResults) }
        : { lane: "shared", status: "error" },
    )
  const okLanes = lanes.filter((l) => l.status === "ok")
  if (okLanes.length > 0) {
    // every-lane-failed is an availability event (#39), not a coverage event
    const candidates = personalResults.length + sharedResults.length
    recordCoverageEvent(
      {
        outcome: candidates > 0 ? "below_threshold" : "empty",
        prompt,
        fetched: rawPersonalCount + rawSharedCount,
        candidates,
        droppedCurrentSession: rawPersonalCount + rawSharedCount - candidates,
        topScore: topScore([...personalResults, ...sharedResults]),
        threshold: cfg.relevanceThreshold,
        ranking: cfg.ranking.enabled,
        sessionId: currentSessionId,
        userId: resolved?.userId,
        lanes,
      },
      stateRoot,
    )
  }
  // ...existing identity-preamble return unchanged (hooks/auto-context.ts:371-377)
}
```

(`personalOk`/`sharedOk` are booleans set in the existing settled-branches; `rawPersonalCount`/`rawSharedCount` fall out of the same pre-drop split as insertion point 1.)

One known coverage-blind spot to accept and document, not fix here: a `below_threshold` event where the shared lane matched only *scope-filtered-out* rows looks identical to a plain ranking miss — the scope filter (`hooks/auto-context.ts:261`, `285`) is applied server-side, so filtered rows never appear in `fetched`. Fine for v1.

### 3.4 Growth bound

Worst realistic case is one event per turn; at ~700 bytes/line that's ~1.4k no-hit turns per MB. The 5 MB cap plus one `.old` generation bounds the footprint at ~10 MB and gives the reviewer a stable "current + previous" window. Rotation happens opportunistically on append (no timers, no startup work).

## 4. Test plan

### 4.1 Automated (`hooks/auto-context.test.ts` + `lib/coverage-log.test.ts`)

Convention: `node --test --experimental-strip-types <file>.test.ts`, `node:test` + `node:assert/strict`. The existing `hooks/auto-context.test.ts` only exercises `dropCurrentSession` directly; the new tests exercise the full handler with a mock client and an injected temp `stateRoot`, exactly as `hooks/hot-buffer.test.ts` does (`mkdtempSync` root at `hooks/hot-buffer.test.ts:14-16`, mock client at `:24-35`, `after`-hook cleanup at `:48`; `sync/markdown.test.ts:126` uses the same `mkdtempSync` pattern):

```ts
import { COVERAGE_LOG_NAME } from "../lib/coverage-log.ts"

function mkStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-coverage-"))
}

function makeSearchClient(results: SearchResult[] | Error) {
  return {
    async search() {
      if (results instanceof Error) throw results
      return results
    },
  } as unknown as HyperspellClient
}

const cfg = parseConfig({ apiKey: "k", userId: "u1" }) // relevanceThreshold defaults to 0.6

test("auto-context — zero-result search writes an 'empty' coverage event", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(makeSearchClient([]), cfg, { stateRoot })
  const out = await handler({ prompt: "what did we decide about the staging DB migration?" }, {})
  assert.equal(out, undefined) // still injects nothing

  const lines = fs
    .readFileSync(path.join(stateRoot, COVERAGE_LOG_NAME), "utf-8")
    .trim()
    .split("\n")
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.outcome, "empty")
  assert.equal(entry.candidates, 0)
  assert.equal(entry.topScore, null)
  assert.match(entry.prompt, /staging DB migration/)
})
```

Companion cases:

- **below_threshold**: client returns one result with `score: 0.2` (< 0.6 default) → single line with `outcome: "below_threshold"`, `candidates: 1`, `topScore: 0.2`, `threshold: 0.6`.
- **hit → no event**: result with `score: 0.9` and a qualifying highlight → context injected, coverage file does not exist.
- **error → no event**: `makeSearchClient(new Error("boom"))` → handler returns undefined (existing behavior), coverage file does not exist. This pins the §2 errors-are-not-coverage separation.
- **degrade-safe**: `stateRoot` pointing at a regular *file* (append will fail) → handler still resolves without throwing.
- **truncation + rotation** (in `lib/coverage-log.test.ts`): 600-char prompt stored at 500; pre-seed a file just over the cap, append, assert `.old` exists and the live file has exactly the new line.
- **multi-user parity**: `cfg` with `multiUser`, personal lane rejects while shared lane fulfills `[]` → one event, `lanes` shows `personal: error` + `shared: ok`; both lanes rejecting → no file.

### 4.2 Manual review workflow (the actual point of the feature)

Run the plugin normally for **two weeks** (alinea is the natural venue — verify auto-context is enabled there first, per usual practice). Then:

1. Pull a review sheet: `jq -r '[.ts, .outcome, .topScore, .prompt] | @tsv' ~/.openclaw/.hyperspell-coverage.jsonl` (adjust the path to the actual workspace dir).
2. Label every line — mechanical rules first, judgment second:
   - **`capture_gap`** — the reviewer knows the fact exists in real life and *should* be in memory, but `outcome` is `empty` (or `below_threshold` with a hopeless `topScore`, say < 0.3). Example: "what dose did the vet prescribe?" returning nothing when that conversation happened in a channel autoTrace didn't cover. Each of these points at a capture-side fix: idea #14, hot-buffer/autoTrace coverage, `/remember` discipline.
   - **`ranking_miss`** — `below_threshold` with `topScore` within ~0.1 of `threshold`. The memory is there; the surfacing pipeline is the problem. Feeds the ranking/threshold ideas in #66, not capture.
   - **`correct_absence`** — the prompt genuinely has no relevant history: new topics, small talk, generic coding questions. Expected to be the majority; that's healthy.
   - **`noise`** — prompts that shouldn't trigger retrieval at all (pure imperatives, tool-ish commands). A large bucket here is input for a future "should we even search this prompt" idea, separate from both capture and ranking.
3. Decision rule, per the issue: if `capture_gap` meaningfully outnumbers `ranking_miss`, the next investment round goes to capture; the reverse sends it to ranking; a dominant `noise` bucket reprioritizes query gating. Record the tallies and the call in the follow-up issue.

## 5. Risks / tradeoffs

- **Unbounded growth** → bounded by the 5 MB cap + single `.old` generation (~10 MB worst case, §3.4). The tradeoff is losing events older than the window — acceptable, since the review cadence (§4.2) is shorter than the window at realistic volumes.
- **Sensitive prompt text at rest, in plaintext, locally.** Deliberate (§3.2): the file lives in the same workspace dir as hot-buffer state, is never transmitted, is truncated, ages out via rotation, and can be switched off (§6). Must be documented in the README so a user can make an informed choice; anything beyond that (hashing/scrubbing) destroys reviewability for no boundary change.
- **Review is manual and subjective.** `capture_gap` requires the reviewer to *know* the fact existed — only the operator can label their own log. Mitigations: `topScore`/`threshold` make the `ranking_miss` cut mechanical, and the labels only need to be right in aggregate to answer "capture or ranking next," not per-line.
- **A busy no-hit path adds a sync file append per no-injection turn.** Microseconds against a completed network round-trip, and `recordCoverageEvent` swallows every error by contract — the response path cannot be blocked or broken by it.
- **Ambiguity in multi-user `below_threshold`** when the scope filter did the excluding server-side (§3.3). Known blind spot, documented, deferred.

## 6. Rollout

> **Decision at implementation time (locked, maintainer):** shipped as **default OFF** — `coverageLog: false`. Prompt text must not be written to disk unless explicitly enabled in config, matching the stance of the `HYPERSPELL_SCORE_LOG` instrumentation (proposal 02). The paragraph below records the proposal's original always-on argument; the observation-window tradeoff it describes is accepted: an operator turns `coverageLog: true` on for a review window, then reads the log.

**Always-on by default — not gated behind `cfg.debug`.** Debug-gating would be self-defeating: `cfg.debug` is off during exactly the long, boring, production-like periods this log exists to observe, and coverage gaps are by nature discovered *after* the fact — you can't retroactively enable logging for last week. The event is cheap, local, and fires only on no-injection turns, so always-on costs effectively nothing. Provide an explicit opt-out for the privacy-sensitive: a `coverageLog: boolean` config key (default `true`) in `config.ts`, checked at the top of `recordCoverageEvent`'s call sites — mirroring how other feature flags in `parseConfig` default (`config.ts:576` area). Defaults: path `<workspaceDir>/.hyperspell-coverage.jsonl`, 500-char prompt truncation, 5 MB cap with one `.old` generation. README gets a short "Coverage log" section stating the local-only guarantee, the location, and the opt-out.

## 7. Effort estimate

**S.** One new ~60-line lib module + tests, two localized insertions in `hooks/auto-context.ts` (plus the mechanical raw/post-drop split), one config flag, no API or backend surface — the two-week review period, not the code, is the long pole.
