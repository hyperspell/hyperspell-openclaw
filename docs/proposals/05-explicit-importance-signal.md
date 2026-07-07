# Proposal 05 — Explicit importance/pin signal to replace the structural heuristic

Idea #5 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Design doc only — no functional code changes in this PR.

## 1. Summary

`classifyResult` in `lib/ranking.ts` decides whether a memory is "curated" or "chatter" from pure structure — does it have a title, and is its `resourceId` a bare UUID. That proxy misfires in both directions: a titled hot-buffer session row can read as deliberately-kept memory, and an untitled-but-important quick note reads as conversational noise. This proposal adds an **explicit, write-time importance signal** — an `openclaw_pinned` metadata flag set by the `hyperspell_remember` tool (plus honoring the existing `openclaw_source` write tags as an explicit chatter signal) — and checks it in `classifyResult` **before** falling back to the structural guess. The one real unknown is whether Hyperspell's search API returns arbitrary write-time metadata on search results; the plan below resolves that with a live probe script first, recommends the metadata path as primary, and specifies a pinned-resource-id manifest as the fallback if the probe fails.

## 2. Problem

`classifyResult` (`lib/ranking.ts:75-88`) classifies each `SearchResult` using only two structural facts:

```ts
const untitled = title === "" || /^unnamed conversation$/i.test(title);
if (untitled && UUID_RE.test(r.resourceId)) return "chatter";
if (title !== "" && !UUID_RE.test(r.resourceId)) return "curated";
return "other";
```

`scoreResult` (`lib/ranking.ts:91-103`) then adds `curationBoost` (+0.2 default) or subtracts `chatterPenalty` (−0.2 default) from the composite, and `selectRanked` (`lib/ranking.ts:128-146`) hard-caps how many "chatter" results may be injected at all (`chatterQuota`). So a misclassification isn't cosmetic — it swings a result by ±0.2 of composite score and can exempt noise from (or subject real memory to) the quota.

The heuristic is a proxy for *"did someone deliberately keep this?"*, and it misfires in both directions:

1. **False curated — a titled hot-buffer/session row.** Anything auto-saved that happens to carry a title and a non-UUID resource key (e.g. a session row keyed by an OpenClaw session id like `agent:main:discord-...`, or a consolidated session resource that picked up an auto-title) passes `title !== "" && !UUID_RE.test(id)` and gets the **curation boost** — an auto-saved conversation fragment ranked as if it were a journal entry, and exempt from the chatter quota.
2. **False chatter — an untitled-but-important note.** A quick `hyperspell_remember` save with no `title` param (`tools/remember.ts:30-32` — title is optional) gets a backend-generated UUID `resourceId`, so it hits `untitled && UUID_RE.test(id)` and is classified "chatter": penalized −0.2 **and** competing with actual conversation echoes for the 2-slot chatter quota. The most deliberate save path in the plugin produces results the ranker treats as noise.

The root cause is that the deliberate-save path already *knows* the memory is important at write time — but records nothing the ranking path can see. Meanwhile writes already tag metadata (`openclaw_source: "command"` in `client.ts:290-297` via `addMemory`; `openclaw_source: "agent_end"` in `sendTrace`, `client.ts:458-465`), and the filter layer (`lib/filters.ts`) already matches those metadata keys server-side — the signal exists on the write side; it just never comes back to `classifyResult`.

## 3. Proposed design

### 3.0 The open question: does search return write-time metadata?

`SearchResult` (`client.ts:16-24`) does not expose metadata today. But the search response mapping (`client.ts:135-152`) *already reads* `doc.metadata`:

```ts
url: (doc.metadata?.url as string | null) ?? null,
createdAt: (doc.metadata?.created_at as string | null) ?? null,
```

So the SDK's search documents carry **a** `metadata` object. What's unverified is whether it contains **arbitrary write-time keys** (`openclaw_source`, a future `openclaw_pinned`) or only a normalized envelope (`url`, `created_at`). Circumstantial evidence cuts both ways:

- **For:** `memories.list` returns write-time metadata (`client.ts:341-375` yields `memory.metadata`; `docs/issue42-resourceid-probe.mjs` successfully reads `m.metadata?.openclaw_source` from list results). And search *filters* match against write-time metadata keys (`lib/filters.ts` — `{ openclaw_source: { $ne: "agent_end" } }` works, verified live post-backend-#1921), so the search index definitely stores them.
- **Against:** storing a key for filtering and *returning* it on result documents are different code paths, and history says not to assume: backend #1921 was exactly a case where metadata was accepted on write (200) but silently changed retrieval behavior, and `POST /messages` with metadata still makes hot rows non-retrievable today (`lib/filters.ts:30-33`). Write-accepted ≠ read-visible.

**Resolve this with the probe script in §4.3 before writing any ranking code.** Everything below branches on its outcome.

### 3.1 Primary approach (Path A) — metadata round-trip, recommended

*Precondition: probe confirms write-time metadata keys come back on search documents.*

**(a) Surface metadata on `SearchResult`.** Add one field to the type (`client.ts:16-24`) and populate it in both mappings (`search` at ~`client.ts:135`, `searchWithAnswer` at ~`client.ts:240`):

```ts
export type SearchResult = {
    resourceId: string;
    title: string | null;
    source: HyperspellSource;
    score: number | null;
    url: string | null;
    createdAt: string | null;
    highlights: Highlight[];
    metadata: Record<string, unknown>;   // write-time metadata, {} if absent
};

// in the .map():
metadata: (doc.metadata ?? {}) as Record<string, unknown>,
```

Purely additive; no call site breaks (existing consumers ignore the new field).

**(b) Write the pin at save time.** `tools/remember.ts` gains an optional `pinned` param and threads it into the metadata it already sends (`tools/remember.ts:123-130` currently sends `metadata: { source: "openclaw_tool" }`):

```ts
pinned: Type.Optional(
  Type.Boolean({
    description:
      "Mark this memory as important. Pinned memories always rank as deliberately-kept, never as conversational chatter. Use sparingly — only when the user signals lasting importance.",
  }),
),

// in execute():
await client.addMemory(params.text, {
  ...,
  metadata: {
    source: "openclaw_tool",
    ...(params.pinned ? { openclaw_pinned: true } : {}),
  },
  ...
})
```

`addMemory` already merges caller metadata into its envelope (`client.ts:290-297`), so no client change is needed on the write side. Also add a `hyperspell_pinned` line to the stored-confirmation text so the agent (and transcript) can see the pin took.

**(c) Check the explicit signal ahead of the structural guess.** New precedence in `classifyResult` (`lib/ranking.ts:75-88`): story terms (unchanged, config is also an explicit signal and carries the larger boost), then the pin, then explicit write-source tags, then the structural fallback — byte-for-byte unchanged — for everything untagged:

```ts
export function classifyResult(
    r: SearchResult,
    storyTerms: string[],
): ResultKind {
    const title = (r.title ?? "").trim();
    if (storyTerms.length > 0) {
        const hay = `${title} ${r.highlights.map((h) => h.text).join(" ")}`.toLowerCase();
        if (storyTerms.some((t) => t && hay.includes(t.toLowerCase()))) return "story";
    }

    // Explicit write-time signals outrank the structural guess below: the writer
    // KNEW what this was; title/id shape is only a proxy for when it didn't say.
    const meta = r.metadata ?? {};
    const pinned = meta.openclaw_pinned === true || meta.openclaw_pinned === "true";
    if (pinned) return "curated";
    const src = meta.openclaw_source;
    if (src === "agent_end" || src === "hot_buffer") return "chatter";
    if (src === "command") return "curated";

    // Structural fallback — unchanged for untagged/legacy memories.
    const untitled = title === "" || /^unnamed conversation$/i.test(title);
    if (untitled && UUID_RE.test(r.resourceId)) return "chatter";
    if (title !== "" && !UUID_RE.test(r.resourceId)) return "curated";
    return "other";
}
```

Notes on the sketch:

- The `=== "true"` alternate handles metadata value coercion — `addMemory` accepts `string | number | boolean` but the round-trip type is unverified; the probe (§4.3) reports the actual returned type, and this check can then be tightened.
- `src === "command"` makes *every* `/remember` save (and CLI `remember` command) explicitly curated, which fixes the untitled-note case even without the caller passing `pinned` — `pinned` then exists for the agent to express *user-signaled* importance, and becomes the hook for a possible future stronger `pinBoost` / quota exemption. Start without a new `ResultKind`; reusing `"curated"` keeps `scoreResult`, `selectRanked`, config, and docs untouched.
- The `agent_end`/`hot_buffer` branch fixes the false-curated direction *for tagged rows*. Honesty note: live hot-buffer rows are currently written **content-only** — `POST /messages` metadata makes rows non-retrievable (`lib/filters.ts:30-33`, verified live), so do **not** try to tag hot rows to feed this branch. It fires today for `agent_end` traces (tagged via `sendTrace`) and for any future consolidated resources that inherit tags; untagged hot rows keep falling through to the structural heuristic, same as today. The false-curated case is therefore only *partially* fixed by this proposal — fully fixing it is blocked on the backend `/messages` metadata bug, and that dependency should be stated in the PR that implements this.

**(d) No filter changes.** The pin is read client-side off returned results — no new `options.filter` clause, so the ~1s/`$ne` search-latency cost documented in `lib/filters.ts` is not incurred.

### 3.2 Fallback approach (Path B) — pinned-resource-id manifest

*Only if the probe shows search documents do not return write-time metadata keys.*

Keep the same `remember.ts` `pinned` param, but instead of (or in addition to) writing metadata, record the `resourceId` that `addMemory` returns (`client.ts:272` — it does return one) into a local manifest, e.g. `~/.openclaw/hyperspell-pins.json`:

```json
{ "pinned": ["a1b2c3d4-…", "…"] }
```

`classifyResult` is pure and must stay IO-free, so pins load once at plugin init and travel the same way `storyTerms` does — a new `pinnedIds: string[]` on `RankingWeights` (`lib/ranking.ts:19-34`), checked as `if (pinnedIds.includes(r.resourceId)) return "curated"` at the same precedence point as Path A's metadata check.

Why B is the fallback, not the primary:

- **Single-machine state.** The pin lives next to the plugin, not in Hyperspell — a second device or reinstall loses it. Path A stores the signal with the memory itself.
- **Maintenance surface.** Deleted memories leave stale ids (harmless but unbounded); manifest read/write needs its own degrade-safely error handling; concurrent sessions can race on the file.
- **No `openclaw_source: "command"` win.** Path A gets "every deliberate save is curated" for free from tags already being written today (so it even helps *existing* post-tagging memories retroactively); Path B only covers explicitly-pinned items going forward.

Even under Path B, still write `openclaw_pinned` into metadata anyway — it costs nothing, is filterable server-side today, and becomes live signal the moment the backend surfaces metadata on search results.

### 3.3 Config / manifest

No `openclaw.plugin.json` `configSchema` change is required for the minimal version (the pin is a tool param, not config). If a `pinBoost` weight or Path B's manifest path is added later, that's when `configSchema`/`uiHints` grow — out of scope here.

## 4. Test plan

### 4.1 Unit fixtures — the two known failure cases (`lib/ranking.test.ts`)

Follow the existing `mk()` fixture helper (`lib/ranking.test.ts:13-22`; it needs `metadata: {}` added to its defaults once `SearchResult` grows the field). First **pin the current misbehavior** so the fix demonstrably changes it, then assert the explicit signal wins with no help from title/id shape:

```ts
test("structural heuristic misfires — documented failure cases (pre-fix behavior)", () => {
    // 1. titled auto-saved session row, non-UUID session key → reads as kept memory
    const titledSession = mk({
        title: "Trip planning chat",
        resourceId: "agent:main:discord-1234",
    });
    // 2. untitled deliberate /remember note, backend UUID id → reads as noise
    const untitledNote = mk({ title: null, resourceId: UUID });

    assert.equal(classifyResult(titledSession, []), "curated"); // wrong, but current
    assert.equal(classifyResult(untitledNote, []), "chatter");  // wrong, but current
});

test("explicit write-time signal outranks title/id shape in BOTH directions", () => {
    // same shapes as above — only metadata differs
    const titledSession = mk({
        title: "Trip planning chat",
        resourceId: "agent:main:discord-1234",
        metadata: { openclaw_source: "agent_end" },
    });
    const untitledNote = mk({
        title: null,
        resourceId: UUID,
        metadata: { source: "openclaw_tool", openclaw_source: "command", openclaw_pinned: true },
    });

    assert.equal(classifyResult(titledSession, []), "chatter");
    assert.equal(classifyResult(untitledNote, []), "curated");
});

test("no explicit signal → structural fallback byte-identical to today", () => {
    assert.equal(classifyResult(mk({ title: "2026-02-09 — Writing Notes", resourceId: "mem-1" }), []), "curated");
    assert.equal(classifyResult(mk({ title: "Unnamed Conversation", resourceId: UUID }), []), "chatter");
    assert.equal(classifyResult(mk({ title: "x", resourceId: UUID }), []), "other");
});
```

Plus: a coercion case (`openclaw_pinned: "true"` string), a `pinned`-beats-untitled `rerank()` case mirroring the existing "kept note out-ranks louder echo" test (`lib/ranking.test.ts:52-72`), and a story-term-beats-pin precedence case. Also extend `tools/remember` coverage (or add it — there is no `tools/remember.test.ts` today) to assert `pinned: true` produces `openclaw_pinned: true` in the metadata passed to `addMemory`, using a stub client per repo convention (plain `node:test`, no mocking framework). Run with `node --test --experimental-strip-types lib/ranking.test.ts`.

### 4.2 The existing test that must keep passing unchanged

All current `lib/ranking.test.ts` fixtures have no metadata → they exercise the structural fallback and must pass with zero edits besides `mk()` gaining a `metadata: {}` default. That *is* the backward-compat regression suite.

### 4.3 Live probe — resolve the metadata-retrievability question FIRST

New standalone script `docs/pin-metadata-probe.mjs`, same pattern as `docs/issue42-resourceid-probe.mjs` / `docs/filter-dialect-test.mjs` (reads config from `~/.openclaw/openclaw.json`, raw `hyperspell` SDK, prints structure not content). Run it **before** implementing §3.1 — it is the decision gate between Path A and Path B.

```
1. WRITE  — memories.add with a unique sentinel text
            ("pin-probe <timestamp> zxqv-sentinel") and
            metadata: { openclaw_pinned: true, probe_marker: "pin-probe-<ts>" }.
            Record the returned resource_id.
2. POLL   — memories.search({ query: "zxqv-sentinel pin-probe" }) every ~5s,
            up to ~2 min, until the new resource_id appears in documents
            (embedding indexing is not instant).
3. INSPECT — for the matching document, print:
              Object.keys(doc.metadata ?? {})
              doc.metadata.openclaw_pinned  (value AND typeof — boolean vs "true")
              doc.metadata.probe_marker
              whether openclaw_source / openclaw_user round-trip too
4. CROSS-CHECK — memories.get + one page of memories.list for the same id, so
            the report distinguishes "metadata lost entirely" from "stored but
            not returned on SEARCH documents specifically".
5. CLEANUP — memories.delete(resource_id, { source: "vault" }).
6. VERDICT — print PATH A (keys round-trip on search documents, with the
            observed value type) or PATH B (they don't; use the manifest).
```

One caution from history: after backend #1921 and the `/messages` metadata trap, also confirm the probe resource is *retrievable at all* (step 2 doubles as this check) — metadata on `/memories/add` is believed safe (the `openclaw_source` tags prove writes with metadata index fine), but the probe makes it explicit rather than assumed.

### 4.4 End-to-end sanity (post-implementation)

Save two memories via the live `hyperspell_remember` tool — one `pinned`, one untitled/unpinned — then run a query that matches both and confirm (debug logs expose `_kind`/`_composite` via `rerank`) that the pinned one classifies "curated" without a title. Per the repo's alinea-is-personal rule: fine to run against alinea's store since this is the plugin's own write path, but use throwaway content and delete the probes after.

## 5. Risks / tradeoffs

- **Forward-only.** The pin only exists on memories saved after the change. The existing corpus (e.g. alinea's ~1900 memories) keeps being classified structurally. Partial mitigation for free: any *already-tagged* memories (`openclaw_source: "command"` / `"agent_end"` — written by current plugin versions) start classifying correctly the moment metadata is surfaced, no backfill needed. A true backfill (re-tagging old untagged resources) would need a metadata-update or re-add path and is explicitly out of scope; note it as a possible follow-up script in the `docs/*.mjs` mold.
- **False-curated direction only partially fixed.** Untagged live hot-buffer rows can't carry metadata today (the `/messages` non-retrievability trap, `lib/filters.ts:30-33`) — a titled hot row still falls to the structural guess. Fully closing this depends on the backend fixing `/messages` metadata; track it in `docs/hyperspell-backend-followups.md`.
- **Pin inflation.** The agent decides when to pass `pinned`. If it pins habitually, "pinned" degenerates into "saved" and the signal is worthless. Mitigate in the param description ("use sparingly — only when the user signals lasting importance"), and note that because pinned currently maps to plain `"curated"` (+0.2, same as any titled note), over-pinning degrades gracefully rather than dominating. Revisit only if a stronger `pinBoost` is added.
- **Metadata type drift.** `openclaw_pinned` may round-trip as `true`, `"true"`, or `"True"` depending on backend serialization; the probe pins the actual behavior and the classify check should match exactly that (keep the lenient two-form check unless the probe shows a third).
- **SDK payload size.** Surfacing full metadata on every `SearchResult` carries whatever was written (small, flat string/number/boolean maps today) — negligible, but the mapping should not start dumping metadata into logs (`log.debugResponse` currently logs counts only; keep it that way).
- **Path B liabilities if forced there:** local single-machine state, manifest races, stale ids — see §3.2.

## 6. Rollout

1. **Land the probe first** (`docs/pin-metadata-probe.mjs`) and record its verdict in the implementation PR description; the verdict picks Path A or B.
2. **Path A lands as one small PR:** `SearchResult.metadata` + both search mappings, `classifyResult` precedence, `remember.ts` `pinned` param, tests. No config schema change, no migration.
3. **Backward compatibility is structural:** every memory without the new metadata keys (all pre-existing memories, all hot-buffer rows, anything written by other clients) takes the `classifyResult` fallback path, which is byte-for-byte today's heuristic — §4.2's untouched existing tests are the proof. `pinned` is an optional tool param, so older agent prompts/callers keep working; `SearchResult.metadata` is additive, so no consumer breaks.
4. **No coordination needed** with the Hermes port or other plugin surfaces at rollout time, but mirror the metadata key (`openclaw_pinned`) in the Hermes port's write path eventually so pins are cross-runtime.
5. Ship behind nothing — the behavior change for any memory lacking the signal is zero, so no feature flag is warranted.

## 7. Effort estimate

**S** (assuming the probe confirms Path A): one additive type field, two mapping lines, ~10 lines of precedence in `classifyResult`, one optional tool param, and tests — the probe script is the only genuinely new artifact. (Becomes **M** if the probe forces Path B: manifest IO, init-time plumbing into `RankingWeights`, and its error handling roughly double the surface.)
