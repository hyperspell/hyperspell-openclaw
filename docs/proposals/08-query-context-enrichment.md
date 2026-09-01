# Proposal 08 — Enrich the search query with recent conversation context

Idea #8 from the retrieval-relevance brainstorm (#66). Design document only — no
functional code ships with this PR.

## 1. Summary

`auto-context` searches the vault on the bare prompt text. Short, pronoun-heavy
follow-ups ("what about that?", "did she reply?") carry almost no lexical or
semantic signal, so raw similarity search scores poorly even when the target
memory exists and the *conversation* makes the referent obvious. This proposal
adds a conditional query-enrichment step: when the prompt looks under-specified
by a cheap, explicit heuristic, fold a small, sanitized slice of the most recent
conversation turns (now reliably available on the `before_prompt_build` event as
`event.messages`) into the string passed to `client.search`. Well-specified
prompts are untouched; enrichment failures degrade to the bare prompt; search
options, filters, and `dropCurrentSession` are unchanged.

## 2. Problem

The search query is the raw prompt, full stop:

- `hooks/auto-context.ts:164` — `const prompt = event.prompt as string | undefined`
- `hooks/auto-context.ts:165` — `if (!prompt || prompt.length < 5) return`
- `hooks/auto-context.ts:193` — `await client.search(prompt, { limit, filter: excludeFilterFor(cfg) })`
- the multi-user path passes the same bare `prompt` to both the personal and
  shared searches (`multiUserSearch`, `hooks/auto-context.ts:242` onward).

A follow-up like "what about that?" embeds near nothing. The memory that should
surface ("the Q3 pricing decision" discussed two turns ago) never clears
`relevanceThreshold`, so the turn gets no injection precisely when recalled
context would help most.

**What changed to make this feasible now:** the session-start injectors were
just migrated from the deprecated `before_agent_start` hook to
`before_prompt_build` (see `index.ts` — the `api.on("before_prompt_build", ...)`
registration and the comment block above it). On the old event, `messages` was
optional (`messages?: unknown[]`) and could be absent in a pre-session phase.
The new event shape is `PluginHookBeforePromptBuildEvent = { prompt: string,
messages: unknown[] }` — the session's prepared messages for this run are
**reliably present on every call**, in the very same event this handler already
receives. No new hook registration, no new plumbing: the recent-turn context is
already in `buildAutoContextHandler`'s hands and currently ignored.

## 3. Proposed design

Two small pure helpers in a new `lib/query-enrichment.ts` (exported for unit
tests, mirroring how `dropCurrentSession` is exported from
`hooks/auto-context.ts` for its tests), plus a three-line change inside
`buildAutoContextHandler`.

### 3a. The "looks under-specified" heuristic

Be cheap and explicit — no model calls, no embeddings. A prompt is
under-specified when it is short AND leans on anaphora, or is so short it
cannot possibly name its referent:

```ts
// lib/query-enrichment.ts
const ANAPHORA =
  /\b(that|this|it|its|those|these|them|they|their|he|him|his|she|her|hers|there|one|ones|same|again|more|why|how so|and then|what about|did it|do it|fix it)\b/i

export function looksUnderSpecified(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (trimmed.length >= 120) return false        // long prompts carry their own signal
  const words = trimmed.split(/\s+/).filter(Boolean).length
  if (words <= 3) return true                     // "why?", "and then?", "status?"
  return words <= 12 && ANAPHORA.test(trimmed)    // short + pronoun/demonstrative
}
```

Rationale for the numbers:

- `>= 120` chars: a prompt that long almost always names its subject; never
  enrich it (hard ceiling protects well-specified prompts by construction).
- `<= 3` words: cannot name a referent regardless of vocabulary.
- `<= 12` words + anaphora hit: "did she ever reply to that email" — short and
  referent-dependent. 12 words is deliberately conservative; tune with the
  transcript eval in section 4.

Note the existing `prompt.length < 5` gate at `hooks/auto-context.ts:165` stays
evaluated against the **bare** prompt and stays first — enrichment must not
resurrect a prompt the hook would previously have skipped. (Whether that gate
should itself be loosened for enrichable prompts like "why?" is a follow-up,
not this change.)

### 3b. Building the enriched query from `event.messages`

```ts
// lib/query-enrichment.ts
import { sanitizeTraceText } from "../hooks/auto-trace.ts"

type Message = { role?: string; content?: string | unknown }
type ContentItem = { type?: string; text?: string }

const MAX_TURNS = 4            // last 4 user/assistant messages (~2 exchanges)
const MAX_CHARS_PER_TURN = 200
const MAX_CONTEXT_CHARS = 600  // total budget for the folded-in context

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return (content as ContentItem[])
      .filter((i) => i?.type === "text" && typeof i.text === "string")
      .map((i) => i.text as string)
      .join(" ")
  }
  return ""
}

/** Never throws. Returns the bare prompt when there is nothing usable to add. */
export function enrichQuery(prompt: string, messages: unknown[] | undefined): string {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return prompt
    const turns: string[] = []
    for (let i = messages.length - 1; i >= 0 && turns.length < MAX_TURNS; i--) {
      const m = messages[i] as Message
      if (m?.role !== "user" && m?.role !== "assistant") continue
      const clean = sanitizeTraceText(textOf(m.content))
        .replace(/\s+/g, " ")
        .trim()
      if (!clean) continue
      turns.unshift(clean.slice(0, MAX_CHARS_PER_TURN))
    }
    if (turns.length === 0) return prompt
    const context = turns.join("\n").slice(-MAX_CONTEXT_CHARS)
    return `${context}\n${prompt}`
  } catch {
    return prompt
  }
}
```

Decisions baked in:

- **Which roles:** `user` and `assistant` only. `system` and `tool`/`toolResult`
  messages are transport plumbing and tool dumps — high volume, low referent
  signal, and the biggest contamination surface. This mirrors
  `messagesToJSONL` in `hooks/auto-trace.ts`, which skips `role === "system"`
  and treats tool results specially.
- **How many turns / how much text:** last 4 qualifying messages, 200 chars
  each, 600 chars total (tail-truncated so the most recent text survives).
  The current prompt goes **last** and untruncated, so it dominates the
  embedding and any lexical matching; the context is prefix material.
- **Content flattening:** the `string | ContentItem[]` handling copies the
  `sanitizeContent`/`messagesToJSONL` pattern from `hooks/auto-trace.ts` —
  the established way this codebase pulls plain text out of `messages`.
- **Plain concatenation, no labels:** no "Recent context:" scaffolding —
  scaffold words add noise to similarity scoring and buy nothing; the search
  backend sees a query string, not a chat.

### The injected-wrapper contamination risk (must-handle)

`event.messages` contains the session's prepared messages — **including any
`<hyperspell-context>` block this same hook injected on a prior turn** (and the
emotional-context / recent-interactions / unfinished-loops wrappers from the
sibling injectors). Folding that back into the next query creates a feedback
loop: the query drifts toward whatever memory already surfaced, that memory
scores even higher next turn, and retrieval collapses onto a rich-get-richer
echo of its own output. This is the exact self-amplifying pollution loop
`sanitizeTraceText` (`hooks/auto-trace.ts:23`) was built to break on the
write path — its doc comment describes the same failure mode for stored
traces.

The fix is to reuse it, not re-invent it: `enrichQuery` runs every candidate
turn's text through `sanitizeTraceText` before including it. That strips
`<hyperspell-context>...</hyperspell-context>`,
`<hyperspell-emotional-context>`, `<hyperspell-recent-interactions>`,
`<hyperspell-unfinished-loops>`, the sender-metadata JSON fence, and the
bootstrap/startup banners — everything the plugin family injects. A message
that was *only* wrapper text sanitizes to empty and is skipped. If a future
injector adds a new wrapper tag, it must be added to `sanitizeTraceText` — one
shared strip list for both the write path and this read path is a feature, and
worth a comment at the `sanitizeTraceText` definition site.

### 3c. Wiring into `buildAutoContextHandler`

```ts
// hooks/auto-context.ts (sketch)
import { enrichQuery, looksUnderSpecified } from "../lib/query-enrichment.ts"

export function buildAutoContextHandler(client: HyperspellClient, cfg: HyperspellConfig) {
  return async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    const prompt = event.prompt as string | undefined
    if (!prompt || prompt.length < 5) return

    const query =
      cfg.queryEnrichment.enabled && looksUnderSpecified(prompt)
        ? enrichQuery(prompt, event.messages as unknown[] | undefined)
        : prompt
    if (query !== prompt) {
      log.debug(`auto-context: enriched under-specified prompt (+${query.length - prompt.length} chars of recent context)`)
    }

    // ... unchanged: resolveCurrentSessionId, recordSender ...
    // every subsequent use of `prompt` as the SEARCH STRING becomes `query`:
    //   - multiUserSearch(client, cfg, query, resolved, currentSessionId)
    //   - client.search(query, { limit, filter: excludeFilterFor(cfg) })
    // log lines may keep slicing `prompt` for readability.
  }
}
```

Enrichment happens **once, before the multi-user branch**, so the single-user
search and both multi-user searches (personal + shared) see the same enriched
string.

### 3d. Interaction with `dropCurrentSession` and search options

**Purely the query text changes.** Nothing else:

- `limit` (including the `candidateMultiplier` widening), `filter` /
  `excludeFilterFor` / `mergeWithExclude`, `userId` routing, the ranking
  pipeline (`rerank`/`selectRanked`), threshold, and chatter quota are all
  untouched.
- `dropCurrentSession` is untouched but becomes **more load-bearing**: the
  enriched query is by construction maximally similar to the current session's
  own hot-buffer rows (it *is* recent-turn text), so the current session would
  be the top hit almost every time. `dropCurrentSession`
  (`hooks/auto-context.ts:141`) already excludes those rows by `resourceId`,
  and it already runs on every path. One practical consequence: with ranking
  enabled, more of the widened candidate pool may be same-session rows that
  get dropped post-fetch. If the transcript eval shows the surviving pool
  getting thin, bump the effective fetch limit by a small constant when the
  query was enriched — but do not pre-build that; measure first.
- `client.search` (`client.ts`) takes a plain string; there is no structured
  context-hint parameter today, so string-level enrichment is the only lever
  and requires no API changes.

### 3e. Fallback story: never worse than the bare prompt

Two independent layers:

1. **Conditional by construction.** Well-specified prompts never enter the
   enrichment path at all (`looksUnderSpecified` returns false), so their
   behavior is bit-identical to today. The alternative — always folding in a
   little context — was considered and rejected for v1: it would change
   retrieval for *every* prompt, making regressions diffuse and hard to
   attribute, and a good prompt diluted by 600 chars of adjacent chatter can
   genuinely rank worse. The cost of the conditional approach is false
   negatives (a vague prompt the heuristic misses), but that failure mode is
   exactly the status quo — safe direction. Revisit always-on-light (e.g.
   1 turn, 150 chars) only after the transcript eval gives a baseline.
2. **Degrade-safe execution.** `enrichQuery` never throws (internal
   try/catch returns the bare prompt), tolerates `messages` being missing,
   empty, or malformed, and returns the bare prompt when no usable turn
   survives sanitization. The handler's existing outer try/catch and
   `classifySearchError` path are unchanged, so a weird enriched query that
   makes the backend unhappy fails exactly like any other failed search:
   logged, no injection, turn proceeds.

### 3f. Config

New optional block, following the `ranking` precedent:

- `config.ts`: `queryEnrichment: { enabled: boolean }` on `HyperspellConfig`,
  parsed with a default alongside the other blocks (near
  `maxResults`/`relevanceThreshold`, `config.ts:575`). Keep `MAX_TURNS` /
  `MAX_CHARS_PER_TURN` / `MAX_CONTEXT_CHARS` as module constants for v1 —
  don't grow config surface for knobs nobody has data to tune yet.
- `openclaw.plugin.json`: schema entry (`"queryEnrichment": { "type": "object",
  "additionalProperties": false, "properties": { "enabled": { "type":
  "boolean" } } }`) plus a `uiHints` entry with `"advanced": true`, matching
  the `relevanceThreshold` hint style.

## 4. Test plan

### Unit tests — `lib/query-enrichment.test.ts`

Plain `node:test` + `node:assert/strict`, run via
`node --test --experimental-strip-types lib/query-enrichment.test.ts`.

`looksUnderSpecified` table:

- true: `"why?"`, `"what about that?"`, `"did she reply?"`, `"fix it"`,
  `"and then?"`
- false: `"summarize the Q3 pricing decision we made with Acme last March"`,
  any 120+ char prompt even if it contains "that", a 13+ word prompt with
  anaphora.

`enrichQuery`:

- string content and `[{type:"text",text}]` array content both flatten.
- `system` and `tool`/`toolResult` roles are skipped.
- **contamination:** a prior assistant message whose content includes a full
  `<hyperspell-context>...</hyperspell-context>` block (use the real wrapper
  shape from `wrapContext`, including `resource_id:` bullet lines) → the
  returned query contains the surrounding genuine text but none of the
  wrapper: assert `!query.includes("hyperspell-context")`,
  `!query.includes("resource_id")`, `!query.includes("passive match")`.
- a message that is *only* wrapper text → skipped entirely; if all messages
  are wrapper-only, returns the bare prompt.
- per-turn and total char caps enforced; most recent text survives
  tail-truncation.
- `messages` undefined / empty / garbage (`[42, null, {role:"user"}]`) →
  returns the bare prompt, never throws.
- output always ends with the exact bare prompt.

### Handler tests — extend `hooks/auto-context.test.ts`

Follow the existing conventions in that file (plain-object mock cast
`as unknown as HyperspellClient`), with a mock that **captures the query
string**:

```ts
let captured: string | undefined
const client = {
  search: async (q: string) => ((captured = q), []),
} as unknown as HyperspellClient
```

- **Vague follow-up gets enriched:** event
  `{ prompt: "what about that?", messages: [ ...two real turns about "the Trieste ferry schedule"... ] }`
  → `captured` contains `"Trieste"` and ends with `"what about that?"`.
- **Well-specified prompt untouched:** long specific prompt with the same
  `messages` → `captured === prompt` exactly (byte-identical — this is the
  no-regression guarantee).
- **Config off:** vague prompt, `queryEnrichment.enabled: false` →
  `captured === prompt`.
- **Contaminated history:** `messages` where the previous turn contains an
  injected `<hyperspell-context>` block → `captured` does not contain
  `"hyperspell-context"` or `"resource_id"`.
- **Missing/malformed messages:** vague prompt, `messages: undefined` and
  `messages: [{}]` → `captured === prompt`, handler resolves normally.
- **Multi-user parity:** with `cfg.multiUser` set and a two-search mock,
  assert both captured queries are the same enriched string.

### Curated-transcript comparison (the issue's acceptance test)

Offline eval script (e.g. `scripts/eval-enrichment.mjs`, run manually against a
dev vault — not part of `node --test`):

1. Curate 10–20 real multi-turn transcripts that end in a vague follow-up
   where a *known* target memory should surface; record the target
   `resourceId` per case.
2. For each case run `client.search` twice — bare prompt vs.
   `enrichQuery(prompt, messages)` — with production `limit` and filters, then
   apply `dropCurrentSession` with the transcript's own session id.
3. Report per case: target present in top-`maxResults`? rank? score? Plus 5
   well-specified control prompts to confirm the heuristic leaves them
   unenriched.
4. Ship-gate: enriched wins or ties on the vague set with zero control-set
   regressions. Use the failures to tune the word/char thresholds in 3a.

## 5. Risks / tradeoffs

- **Diluting an already-good query.** Mitigated structurally: the heuristic's
  hard ceilings mean well-specified prompts are never touched, and the
  handler-level byte-identity test locks that in. Residual risk is a short
  prompt that was actually self-sufficient ("deploy checklist") picking up
  irrelevant adjacent turns — bounded by the 600-char cap and prompt-last
  ordering, and measured by the control set in the eval.
- **Contamination feedback loop.** The serious one; addressed by routing all
  candidate text through `sanitizeTraceText` (section 3b). Residual risk: a
  *new* wrapper tag added by a future injector without updating the shared
  strip list — hence the recommendation to document the coupling at the
  `sanitizeTraceText` definition site.
- **Latency / token cost.** Enrichment itself is pure string work
  (microseconds). The query grows by ≤ ~600 chars only on enriched turns —
  marginal embedding cost server-side, no extra round-trips, no change to the
  number of searches.
- **Current-session echo pressure.** The enriched query strongly matches the
  live session's hot-buffer rows; `dropCurrentSession` already handles it, but
  the effective candidate pool can shrink post-drop (see 3d). Watch the debug
  log's dropped-count on enriched turns during rollout.
- **Heuristic false negatives.** A vague prompt the regex misses simply gets
  today's behavior. Acceptable; iterate the word list from eval data rather
  than trying to enumerate English anaphora up front.

## 6. Rollout

Gate behind `queryEnrichment.enabled`, **default off** for one release:

1. Ship dark. Enable on a dogfood deployment (e.g. alinea), watch the
   `auto-context: enriched...` debug line and the dropped-count from
   `dropCurrentSession` for a few days of real traffic.
2. Run the curated-transcript eval against a real vault; tune thresholds.
3. Flip the default to **on** in the following release (the conditional design
   plus byte-identity guarantee for well-specified prompts makes default-on
   the right end state — the users who need this most are the least likely to
   find an advanced flag), keeping the flag as the escape hatch.

## 7. Effort estimate

**S–M** (roughly a day): two small pure functions plus a three-line handler
change and config plumbing are S; the curated-transcript eval and threshold
tuning are what push it toward M.
