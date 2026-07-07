# Proposal 16 — Supersession, not just age

Implementation guide for idea #16 from #66. Design doc only; no functional code ships with this PR.

## 1. Summary

When a fact is corrected ("actually, my address is 44 Birch Ave now"), the stale fact and the correction are near-duplicates semantically, so they retrieve together at similar rank — and recency decay (idea #7) only nudges the old one down a little. This proposal adds an explicit supersession link: `hyperspell_remember` gains an optional `supersedes: <resourceId>` parameter that stamps a forward pointer (`openclaw_supersedes`) into the new memory's metadata, and the retrieval paths drop any candidate whose resourceId is pointed at by another candidate in the same pool. The mechanism is write-once (no mutation of the old resource), fail-open (a missing or bogus pointer changes nothing), time-independent (a correction from yesterday suppresses as hard as one from a year ago), and inert until the first flagged correction — zero behavior change at rollout. Automatic correction detection is explicitly out of scope.

## 2. Problem

`lib/ranking.ts` scores results as `composite = base relevance ± kind boost/penalty` (`scoreResult`). `classifyResult` is purely structural — title shape + resourceId shape — so a corrected fact and its correction are both, typically, `curated`: same boost, and near-identical base relevance because they describe the same entity in nearly the same words. Nothing in `RankingWeights` knows that one of them is *wrong*.

**Why idea #7 (recency decay) doesn't cover this.** Decay is generic age-based de-weighting: ALL old memory gets a bit weaker. That's the right treatment for a preference that's merely old but still true. A superseded fact is categorically different — it is not weaker evidence, it is *false*, and it needs:

- **Much stronger suppression** than any sane decay curve would apply. A decay tuned to gently age out stale chatter cannot also nuke a wrong address without nuking everything else that old.
- **Time-independence.** If the user corrected their address yesterday, decay applies essentially zero differential between the two resources (both are recent). The correction signal must not depend on elapsed time at all.

Decay and supersession are complementary, not alternatives: decay handles "probably less relevant because old", supersession handles "known wrong because corrected". This guide is only about the latter.

## 3. Proposed design

### 3a. Detection/capture: explicit flagging only

Honest scoping first: **automatic correction detection is a non-goal.** Inferring "this new statement contradicts that old memory" requires semantic diffing of new utterances against the whole store — an entity-resolution + contradiction-detection problem that is its own (hard) project, with its own failure modes (false supersessions silently hiding true facts). It is explicitly deferred as a separate future idea.

What ships here is the explicit path, and it fits the tool flow that already exists:

1. User states a correction ("actually, update my address — it's 44 Birch Ave now").
2. The agent searches (auto-context has usually already surfaced the stale fact, complete with its `resourceId` — `SearchResult.resourceId` is already available to the model via the search tool output).
3. The agent calls `hyperspell_remember` with the new fact and `supersedes: "<old resourceId>"`.

So "detection" is delegated to the model + user, guided by the tool parameter's description — the same mechanism `scope` and `userId` already use in `tools/remember.ts`. This will only catch corrections the user or agent explicitly frames as corrections. That limitation is accepted (see Risks).

### 3b. Where the marker lives: forward pointer on the NEW resource

There are two places the link could live, and the codebase forces the choice:

- **Tag the OLD resource** (`openclaw_superseded: true` in its metadata) — would enable a server-side exclude filter, but `HyperspellClient` has **no update-memory method** (only `addMemory`, `getMemory`, `deleteMemory`). Re-`addMemory` with the same `resourceId` has unverified upsert semantics and would clobber the old content even if it worked. Tagging the old resource is not implementable in the plugin today without new API surface.
- **Forward pointer on the NEW resource** (`openclaw_supersedes: "<oldResourceId>"`) — write-once, lands in the same `metadata` bag `addMemory` already builds (`openclaw_source`, `openclaw_user`, `openclaw_scope`), no mutation of anything existing.

The forward pointer is the recommended and only currently-implementable option. Its consumption is necessarily client-side (a server filter can only match a row's *own* metadata, and the old row carries nothing).

### 3c. Exclude vs. de-rank — the decision

Three candidate enforcement mechanisms:

| Mechanism | Verdict |
|---|---|
| Server-side exclude filter (à la `EXCLUDE_SESSION_END_FILTER` in `lib/filters.ts`) | **No.** Requires the old row to be tagged (see 3b — not possible), and a `$ne` metadata predicate costs ~1s per search (measured, documented in `filters.ts`), paid on *every* search forever even when nothing was ever superseded. |
| Client-side scoring penalty (`supersededPenalty` in `RankingWeights`) | **No.** A wrong fact shouldn't merely rank lower — a high-similarity stale fact can clear any fixed penalty, exactly the failure `chatterQuota` exists to plug for chatter. Tuning one more weight to "usually below threshold" is fragile. |
| Client-side hard drop from the candidate pool when its superseder is present | **Yes — recommended.** |

The recommended semantics: **within a retrieved candidate pool, if resource B carries `supersedes: A` and resource A is also in the pool, drop A before ranking.** This is the `dropCurrentSession` pattern from `hooks/auto-context.ts`: a pure, fail-open pre-rank filter where a wrong or missing id can only fail to help, never actively hurt.

Why this threads the exclude-vs-derank needle:

- **It's absolute where it matters.** The problem statement is "both surface at similar rank" — precisely the case where correction and stale fact co-retrieve (and they almost always will: they're near-duplicates semantically, and `candidateMultiplier: 3` widens the pool). In that case the stale fact is *gone*, not merely lower — correct for a factual correction.
- **It preserves historical value.** The old resource is never deleted, never server-hidden. `getMemory`, `listMemories`, and any query where the correction doesn't co-retrieve (e.g. "what did we used to think about X?" phrased so only the old note matches) still reach it. Exclusion is conditional on the correction being present to replace it — the safest possible flavor of exclusion.
- **Zero cost when unused.** No filter clause, no latency, no config.

The known weakness — if the superseding resource is NOT in the pool, the stale one surfaces alone — is bounded by the near-duplicate property above and is the fail-open direction (stale info surfaces, as it does today; nothing new breaks).

### 3d. Concrete changes

**Config/schema:** none required. The mechanism is inert until the first flagged write, and hard-drop has no weight to tune. (If misuse ever demands a killswitch, a single `ranking.supersession: boolean` default `true` can be added later — deliberately not pre-built.)

**`tools/remember.ts`** — one new optional parameter, passed through to metadata:

```ts
parameters: Type.Object({
  text: Type.String({ description: "Information to remember" }),
  // ... existing params ...
  supersedes: Type.Optional(
    Type.String({
      description:
        "resourceId of an existing memory this CORRECTS (the old fact is now wrong, not just old). Only set when the user explicitly corrects a prior fact and you have the stale memory's resourceId from a search result. The old memory will be suppressed whenever this one surfaces.",
    }),
  ),
}),
```

and in `execute`, alongside the existing metadata:

```ts
await client.addMemory(params.text, {
  title: params.title,
  date: params.date,
  collection,
  metadata: {
    source: "openclaw_tool",
    ...(params.supersedes ? { openclaw_supersedes: params.supersedes } : {}),
  },
  userId,
  scope: scopingEnabled ? scope : undefined,
})
```

No validation that the target resourceId exists — deliberately. A hallucinated or stale id is a pointer that matches nothing in any future pool: a no-op, never an error (fail-open, matching repo style). Validating would cost a `getMemory` round-trip per remember for no safety gain.

**`client.ts`** — surface the pointer on `SearchResult`. The search mapper already reads `doc.metadata?.url` and `doc.metadata?.created_at`, so the extension is one field:

```ts
export type SearchResult = {
  resourceId: string
  // ... existing fields ...
  supersedes: string | null
}

// in the search() mapper:
supersedes: (doc.metadata?.openclaw_supersedes as string | null) ?? null,
```

⚠️ **Shared open question with idea #5 (explicit importance signal):** it is *verified* that write-time metadata is server-side FILTERABLE (`openclaw_source` powers `EXCLUDE_SESSION_END_FILTER`), and that `metadata.url`/`created_at` come back on search docs — but it is **not yet verified that arbitrary custom keys written via `memories.add` are echoed back in `doc.metadata` on search responses** (the server may whitelist keys). This must be verified live before implementation (Test plan step 0). Related trap, for the record: `POST /messages` with metadata makes rows non-retrievable — but this design writes via `memories.add`, the path already proven safe for metadata by the `agent_end` tagging.

**`lib/ranking.ts`** — a pure pre-rank drop, sibling to `rerank`:

```ts
/** Drop results whose resourceId is superseded by ANOTHER result in the same
 * pool. Forward pointers only suppress when the correction co-retrieves, so a
 * wrong or dangling pointer can only fail to help, never actively hurt
 * (same fail-open contract as dropCurrentSession). Self-pointers are ignored. */
export function dropSuperseded(results: SearchResult[]): SearchResult[] {
  const superseded = new Set<string>()
  for (const r of results) {
    if (r.supersedes && r.supersedes !== r.resourceId) superseded.add(r.supersedes)
  }
  if (superseded.size === 0) return results
  return results.filter((r) => !superseded.has(r.resourceId))
}
```

**Call sites:** apply `dropSuperseded` wherever `dropCurrentSession` is applied today — the auto-context hook (`hooks/auto-context.ts`, before `rerank`) and the `hyperspell_search` tool result path — so suppression is consistent across both retrieval paths, same as the `lib/filters.ts` convention.

### 3e. Relationship to idea #5 (explicit importance signal)

Both ideas need the identical write-side primitive: *an optional `hyperspell_remember` parameter that lands as an `openclaw_*` metadata key and is read back at retrieval time.* Both also share the same open question (custom-metadata round-trip) and would share its live verification.

**Recommendation: share the plumbing, keep the semantics separate.** Concretely:

- **Shared:** the pass-through pattern in `tools/remember.ts` (param → `metadata.openclaw_*`), the `SearchResult` metadata mapping in `client.ts`, and the one-time live verification of metadata retrievability. Whichever idea lands first pays that cost; the second reuses the pattern and the verified answer.
- **Separate:** the read-side consumption. Importance (#5) is a *scalar boost* inside `scoreResult` — it belongs in `RankingWeights` next to `curationBoost`. Supersession is an *identity-linked hard drop* before ranking — it deliberately bypasses scoring (see 3c). Forcing both through one generic "metadata signals framework" would abstract over two behaviors with nothing in common past the write, against repo minimalism.

## 4. Test plan

**Step 0 — live verification gate (do this FIRST, blocks everything else).** Against a test app (NOT alinea's live store): `addMemory("probe", { metadata: { openclaw_supersedes: "test-target" } })`, then search for it via `searchRaw` and inspect the raw `doc.metadata` for the custom key. If the key round-trips → proceed. If not → the forward-pointer read path is dead and the fallback is a backend ask (echo custom metadata on search docs, or an update-metadata endpoint enabling the tag-the-old-row + exclude-filter route); record the finding either way, since idea #5 gates on the same answer.

**Unit tests (`lib/ranking.test.ts` additions, fixture-based):**

1. **Correction pair surfaces at similar rank today (the bug).** Two fixture `SearchResult`s — old: `{ resourceId: "res-old", title: "David's address", score: 0.82, supersedes: null }`; new: `{ resourceId: "res-new", title: "David's address (corrected)", score: 0.84, supersedes: "res-old" }`. Assert `rerank` without `dropSuperseded` keeps both, adjacent — documenting current behavior.
2. **Suppression.** `dropSuperseded([old, new])` → only `res-new` remains; the correction still surfaces.
3. **Fail-open cases:** pointer to an id not in the pool → identity; `supersedes: null` everywhere → identity (and returns the same array reference, no copy); self-pointer (`supersedes === resourceId`) → ignored; empty input → empty; A-supersedes-B *and* B-supersedes-A (pathological) → both dropped, documented as acceptable (both flagged wrong by someone).
4. **`tools/remember.ts`:** with `supersedes` set, `addMemory` receives `metadata.openclaw_supersedes`; without it, metadata is unchanged from today.

**Live end-to-end (test app):** store the old-address fact; store the correction with `supersedes` set to the first write's returned `resourceId`; query "David's address"; confirm both appear in the raw candidate pool at similar score (reproducing the problem), then confirm the injected context contains only the correction.

## 5. Risks / tradeoffs

- **Explicit flagging only helps flagged corrections.** Corrections stated casually and never routed through `hyperspell_remember` with `supersedes` get zero benefit — they remain idea #7's (weak) territory. Accepted: this is the honest scope; automatic detection is a separate future idea.
- **Suppression is conditional on co-retrieval.** If the correction doesn't make the candidate pool, the stale fact surfaces alone, exactly as today. Bounded by semantic near-duplication + `candidateMultiplier`, and it's the fail-open direction.
- **Historical value:** mostly preserved by design (no deletion, no server-side hiding, `getMemory`/`listMemories` untouched) — but "what did we used to think?" queries where BOTH co-retrieve will hide the old one. If that ever matters, the drop could later be downgraded to an annotation ("superseded by …") rather than removal; not built now.
- **Misuse / wrong flagging.** The agent could mark something superseded that isn't a correction (e.g. two coexisting-true facts). Blast radius is limited — the "victim" is only hidden when the flagger co-surfaces, and the link is inspectable (it's plain metadata on the new resource) and reversible by deleting the flagging resource. A hallucinated target resourceId is a harmless no-op.
- **Pointer rot:** if the superseded resource is deleted, the dangling pointer is a no-op forever. If the *superseding* resource is deleted, suppression silently ends — correct behavior (the correction is gone).

## 6. Rollout

Purely additive and opt-in by construction: no config change, no schema migration, no existing resource carries `openclaw_supersedes` today, so `dropSuperseded` is an identity function over every current store. Behavior changes only for pools containing a post-rollout flagged correction. Ship order: Step-0 live verification → `client.ts` mapping → `lib/ranking.ts` drop + call sites → `tools/remember.ts` parameter last (nothing can write the pointer until everything can read it, so there is no window where flags are written and ignored).

## 7. Effort estimate

**M** — the code surface is small (one tool param, one `SearchResult` field, one ~10-line pure function, two call sites, unit tests), but it is gated on a live metadata round-trip verification with a real possibility of a backend follow-up, and touches both retrieval paths.
