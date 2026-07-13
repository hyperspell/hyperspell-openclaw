# Implementation guide — #82: `storyBoost` is silently inert with the empty `storyTerms` default

> **Status (2026-07-12): resolved — superseded by PR #83 (`proposal/01-story-terms-boost`).**
>
> The matching-semantics disagreement flagged below was decided by the owner on
> 2026-07-12: **word-boundary matching wins** over this guide's
> substring-plus-docs position. PR #83 is the primary change and has absorbed
> everything this guide proposed to land:
>
> - `parseRanking` normalization (trim + lowercase + drop whitespace-only —
>   this guide's Deliverable 2 footgun fix — plus dedupe)
> - the README composite-ranking section and Configuration Options rows
>   (Deliverable 1, adapted to word-boundary semantics: the planned
>   "`mira` also matches `admiral`" tip is no longer true and was replaced by
>   the boundary-matching rule)
> - the missing `uiHints.ranking` manifest entry
> - the tests from this guide's Tests section (the manuscript-vs-chatter corpus
>   test, the highlight-text match case, the normalization test)
>
> **Remaining scope for this PR: none.** The only part of this guide not
> absorbed by #83 is the "Future work" sketch (semi-automatic `storyTerms`
> seeding), which both documents agreed is a follow-up issue, not PR scope.
> Recommendation: after #83 merges, close #115 in its favor (the same
> disposition as #84 → #100), filing the seeding sketch as its own issue if
> still wanted.
>
> The sections below are kept as the verified code analysis they were — they
> describe the **pre-#83** code and informed #83's implementation — with
> notes where #83 changed the behavior described.

## Background: what the code actually does today

**Where the boost lives.** `lib/ranking.ts` implements the composite score documented in its header comment: `composite = relevance + curationBoost + storyBoost − chatterPenalty`. The defaults:

```ts
export const DEFAULT_RANKING: RankingWeights = {
	enabled: true,
	curationBoost: 0.2,
	chatterPenalty: 0.2,
	storyBoost: 0.15,
	storyTerms: [],        // <-- the problem
	candidateMultiplier: 3,
	chatterQuota: 2,
};
```

**The matching logic** is in `classifyResult` (as analyzed pre-#83; #83
replaced the substring test below with word-boundary regex matching over a
`\n`-joined haystack):

```ts
const title = (r.title ?? "").trim();
if (storyTerms.length > 0) {
	const hay = `${title} ${r.highlights.map((h) => h.text).join(" ")}`.toLowerCase();
	if (storyTerms.some((t) => t && hay.includes(t.toLowerCase()))) return "story";
}
```

So, precisely:

- Matching is **case-insensitive substring** matching (haystack is lowercased; each term is lowercased at match time).
- The haystack is the result **title plus all highlight excerpt texts** — not the full document content. A term can hit via either the memory's title or any returned highlight snippet.
- With `storyTerms: []`, the `storyTerms.length > 0` guard skips the story branch entirely. Every result falls through to `curated` / `chatter` / `other`. **`storyBoost: 0.15` is dead weight for every user who hasn't hand-configured terms** — which is every user, because the option is documented nowhere (see below).
- A `story` classification is worth a lot: `scoreResult` gives story results `storyBoost + curationBoost` = **+0.35** by default ("the story is kept memory too"), vs +0.2 for curated and −0.2 for chatter. Story results are also exempt from the `chatterQuota` cap in `selectRanked`.

**Where ranking applies.** Only the **auto-context hook** uses the composite pipeline — both the single-user path and the multi-user path call `rerank` + `selectRanked` with `cfg.relevanceThreshold` (default `0.6`). The `hyperspell_search` tool and `/getcontext` do **not** rerank. Docs must say this so users don't test `storyTerms` via the search tool and conclude it's broken.

**Config parsing** (`parseRanking`): `ranking` is a recognized top-level plugin config key. `storyTerms` is accepted only as an array; entries are `String()`-coerced and empty strings filtered:

```ts
storyTerms: Array.isArray(r.storyTerms)
	? (r.storyTerms as unknown[]).map((t) => String(t)).filter((t) => t.length > 0)
	: DEFAULT_RANKING.storyTerms,
```

**README status:** the entire `ranking` block — `enabled`, `curationBoost`, `chatterPenalty`, `storyBoost`, `storyTerms`, `candidateMultiplier`, `chatterQuota` — is undocumented, as is `relevanceThreshold`. Nobody can configure what they can't discover; that's the real bug behind "silently inert."

**Useful synergy to document:** section-level memory sync titles memories as `"<file title> — <section title>"`. A manuscript file with frontmatter `title: The Lighthouse Keeper` produces memories titled `The Lighthouse Keeper — Chapter 3`, so a single title-derived storyTerm matches **every section** of the manuscript via the title alone, even when the highlight text never mentions the title. This makes the "just add your manuscript's title" advice genuinely effective, not aspirational.

---

## Deliverable 1 (the PR's concrete change): document `ranking` and `storyTerms` in README.md

> **Absorbed by #83.** The README section and table rows below landed there,
> adapted to word-boundary semantics — in particular the "prefer distinctive,
> multi-word terms because matching is substring-based" tip was replaced by the
> boundary-matching rule ("mira" matches "Mira's" but not "admiral"/"miracle").
> Kept verbatim below as the drafted-against-substring version for reference.

### 1a. Add rows to the Configuration Options table

Add after `maxResults`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `relevanceThreshold` | number | `0.6` | Minimum (composite) score a memory needs to be injected by auto-context |
| `ranking` | object | see below | Composite re-ranking of auto-context results — see [Composite ranking](#composite-ranking--surfacing-your-active-work) |
| `ranking.storyTerms` | string[] | `[]` | **Off until you set it.** Substrings identifying your active creative work, so it outranks conversation chatter |

### 1b. Add a new subsection under "## Auto-Context"

Suggested content (adapt tone to the existing README voice):

~~~markdown
### Composite ranking — surfacing your active work

Raw semantic relevance rewards *frequency*: a phrase repeated across a hundred
auto-saved conversation fragments looks "most similar" to everything and buries
quieter, truer memory — like the manuscript you're actually writing. When
`ranking.enabled` is on (default), auto-context re-scores candidates:

```
composite = relevance
          + curationBoost   (a memory you deliberately kept: journals, notes, synced files)
          + storyBoost      (your active story/manuscript — matched via storyTerms)
          − chatterPenalty  (an auto-saved conversation fragment)
```

Chatter is additionally capped at `chatterQuota` results per injection,
regardless of score.

**`storyBoost` does nothing until you set `storyTerms`.** The default is `[]`,
so no result ever classifies as "story". Set it to distinctive substrings of
your active work — the title, character names, a project codename:

```jsonc
"config": {
  "ranking": {
    "storyTerms": ["lighthouse keeper", "mira", "the shoal chapters"]
  }
}
```

For example: if you're writing a novel called *The Lighthouse Keeper* with a
protagonist named Mira, the config above makes any memory whose **title or
highlight excerpt** contains those substrings (case-insensitive) rank as
"story" — it gets `storyBoost + curationBoost` (+0.35 by default) and is exempt
from the chatter cap. If you sync the manuscript via `syncMemories` with
`sectionize: true`, every section is titled `The Lighthouse Keeper — <section>`,
so the title term alone catches the whole manuscript.

Tips:

- **Prefer distinctive, multi-word terms.** Matching is substring-based, so a
  short term like `"mira"` also matches "ad**mira**l" and "**mira**cle". A
  title fragment (`"lighthouse keeper"`) or unusual name is safer.
- Terms are matched case-insensitively; casing in your config doesn't matter.
- Ranking (including `storyTerms`) applies only to **auto-context** injection.
  The `hyperspell_search` tool and `/getcontext` return raw relevance order.

Full knobs and defaults:

```jsonc
"ranking": {
  "enabled": true,
  "curationBoost": 0.2,     // lift for deliberately-kept memory
  "chatterPenalty": 0.2,    // penalty for auto-saved conversation fragments
  "storyBoost": 0.15,       // extra lift for storyTerms matches (stacks with curationBoost)
  "storyTerms": [],         // REQUIRED for storyBoost to do anything
  "candidateMultiplier": 3, // fetch this × maxResults candidates before re-ranking
  "chatterQuota": 2         // hard cap on chatter results per injection
}
```
~~~

Keep the boost/penalty numbers in the doc sourced from `DEFAULT_RANKING` at writing time; they are the single source of truth.

## Deliverable 2 (small in-scope code fix): normalize terms in `parseRanking`

> **Absorbed by #83** (trim + lowercase + drop whitespace-only, plus dedupe via
> `Set`). The footgun analysis below — a stray `" "` entry silently classifying
> every result as story — is the reason the fix exists and is cited in #83's
> change; the fix now lives there.

Two rough edges found while investigating, one of which is a real footgun:

1. **Whitespace-only terms pass the filter and match everything.** `config.ts` filters `t.length > 0` but never trims, so `storyTerms: [" "]` (or a stray `"mira "` plus an accidental `" "` entry) survives — and since the haystack joins title and highlights with spaces, a single-space term substring-matches essentially **every** result, silently classifying the whole pool as "story" and neutering the chatter penalty/quota. Fix in `parseRanking`:

   ```ts
   storyTerms: Array.isArray(r.storyTerms)
   	? (r.storyTerms as unknown[])
   		.map((t) => String(t).trim().toLowerCase())
   		.filter((t) => t.length > 0)
   	: DEFAULT_RANKING.storyTerms,
   ```

2. This also makes the config honor the existing type-level contract — `RankingWeights.storyTerms` is documented as "**Lowercased** substrings" but the parser never lowercased them. Keep the defensive `t.toLowerCase()` inside `classifyResult` as-is: tests and any direct constructors of `RankingWeights` bypass `parseRanking`, and the per-term cost is negligible.

**Matching semantics — DECIDED (2026-07-12): word-boundary matching won.** This guide originally argued that switching to word-boundary matching was out of scope — that substring matching was a deliberate trade-off (phrase terms work naturally; word-boundary regexes looked fiddly around punctuation/possessives like "Mira's") and the short-word over-match risk should stay a docs-only concern. `proposal/01-story-terms-boost` (#83) argued the opposite. Both documents flagged the disagreement for a human decision rather than resolving it unilaterally; the owner decided in #83's favor, and #83 implements it:

- Terms are matched at word boundaries via per-term compiled regexes (`\b` anchored only against word-character term edges), so "mira" no longer matches "admiral"/"miracle".
- The possessive/punctuation worry that motivated this guide's position turned out not to bite: boundaries are word↔non-word transitions, so "mira" still matches "Mira's" and "mira-class". `proposal/01` §3.2 and #83's tests pin this.
- The haystack is `\n`-joined (was space-joined), so a phrase term can no longer spuriously match across the seam of two unrelated highlights.
- The un-match risk for existing deployments relying on deliberate prefix terms (e.g. `"omuert"`) is accepted and called out in #83; the fix is listing full inflected forms.

## Tests

> **Absorbed by #83**, adjusted for the decided semantics: the corpus test
> (manuscript-vs-chatter, empty vs populated terms), the highlight-text match
> case, and the `parseRanking` normalization test all landed there, alongside
> #83's own word-boundary tests and a new eval-harness case pinning the
> boundary behavior.

Test runner is `node --test`; ranking tests live in `lib/ranking.test.ts`, config tests in `config.test.ts`.

1. **Corpus regression test (the issue's acceptance test), in `lib/ranking.test.ts`.** Build a small realistic pool: 3–4 "chatter" echoes (title `"Unnamed Conversation"`, UUID `resourceId`, high scores ~0.8) that paraphrase the creative content, plus 2 manuscript sections (titles like `"The Lighthouse Keeper — Chapter 3"`, non-UUID ids, modest scores ~0.55) and 1 curated note. Then:
   - `rerank(pool, DEFAULT_RANKING)` (empty `storyTerms`): assert manuscript sections classify as `curated` (not `story`) and the top slot goes to a chatter echo before `selectRanked` quota-caps it — demonstrating today's inert behavior.
   - `rerank(pool, { ...DEFAULT_RANKING, storyTerms: ["lighthouse keeper", "mira"] })` → `selectRanked(..., maxResults 5, threshold 0.6, quota 2)`: assert both manuscript sections classify `story`, outrank every echo, and survive selection.
2. **Term matching via highlight text, not just title** — one case where the title is bland but a highlight contains "Mira", asserting `classifyResult` returns `story`.
3. **`parseRanking` normalization, in `config.test.ts`:** `storyTerms: ["  Mira ", " ", "", 42]` parses to `["mira", "42"]` — trims, lowercases, drops whitespace-only entries.

Run: `npm test` (or the single files: `node --test --experimental-strip-types lib/ranking.test.ts config.test.ts`).

---

## Future work (explicitly NOT this PR): semi-automatic `storyTerms` seeding

The issue asks whether the plugin could detect "a large, frequently-updated single-source document" from local file sync and seed/suggest terms. Honest assessment after reading `sync/markdown.ts` in full:

**Signal that exists today (per-run):**
- File inventory: `getSyncableFiles` walks `memory/` + `watchPaths` for `.md` files.
- Size/structure: `parseMarkdownSections` yields section count and content lengths — a 40-section, 80KB file is trivially distinguishable from a 300-char note.
- A ready-made "distinguishing term": the file-level title (frontmatter `title:`, `# ` heading, or filename — `readMarkdownFile`), which is already prepended to every section's memory title.
- Recency: `fs.statSync(...).mtimeMs` is already consulted for the `maxAgeDays` filter.

**Signal that does NOT exist:** cross-run **edit frequency**. The sync manifest (`.hyperspell-sync-hashes.json`) stores only `{ hash, resourceId }` per section — no timestamps, no change counts. "Frequently-updated" over time would require extending the manifest schema (e.g. `lastChangedAt` per section). The forward-migration in `loadManifest` tolerates extra fields, so this is a modest, non-breaking addition — but it is a schema change with its own test surface.

**Verdict: plausible near-term, but correctly out of scope here.** A defensible v1 sketch:

1. Add `lastChangedAt` to `SectionRecord`, stamped whenever a section syncs dirty.
2. After startup bulk sync, score files by `(size or section count) × (fraction of sections changed in last N days)`; if a clear single-file winner exists under `watchPaths`/`memory/` and its title is not already covered by configured `storyTerms`, **suggest** — via a log line and/or the `openclaw openclaw-hyperspell status` command output — adding its file-level title as a storyTerm.
3. Suggest, never auto-write: silently mutating `openclaw.json` is surprising, and a false positive (e.g. a big auto-generated `MEMORY.md`) would mis-boost the wrong content plugin-wide.

What remains **genuinely speculative** is the second half of the issue's idea — extracting character names/codenames automatically. That needs proper-noun frequency analysis or an LLM pass; heuristics on free-form manuscripts are noisy. File this whole item as a follow-up issue linked from this PR rather than growing this change.

---

## Files touched

**By this PR: none beyond this guide.** Every file this guide planned to touch
was touched by #83 instead (with word-boundary semantics where the two
disagreed):

- `README.md` — composite-ranking subsection + Configuration Options rows → **landed in #83**
- `config.ts` — `parseRanking` trim/lowercase/drop-empty (+ dedupe) → **landed in #83**
- `config.test.ts` / `lib/ranking.test.ts` — normalization, corpus, and highlight-match tests → **landed in #83**
- `lib/ranking.ts` / `hooks/auto-context.ts` — this guide planned no changes; #83 changed both (boundary matching; candidate-pool debug tallies)
- `sync/markdown.ts` — read for evidence only in both; seeding deferred to a follow-up issue

**Disposition:** close #115 in favor of #83 after it merges (as #84 closed
into #100). If the semi-automatic seeding idea is still wanted, file it as its
own issue using the "Future work" section above as the starting sketch.
