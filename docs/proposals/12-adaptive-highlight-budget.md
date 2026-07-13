# Proposal 12 — Adaptive highlight budget (gap-based, not fixed-2)

Idea #12 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Implementation guide only — no functional code in this PR.

## 1. Summary

`formatSelected` in `hooks/auto-context.ts` attaches up to 2 highlights per selected memory, requiring only that each highlight individually clears a floor — it never compares the two highlights against each other. A result whose top highlight nails the point at .95 can drag along a marginal .4 second highlight that adds tokens but no signal. This proposal adds a gap check: the second highlight is included only when its score is within a fixed absolute gap (default **0.15**) of the top highlight's score. The top highlight is always kept — only the second is ever conditionally dropped — so a selected result can never format to zero highlights that it wouldn't already format to today. Recommended as a fixed module constant, not a new config field, until real-world tuning proves otherwise.

## 2. Problem

Selection happens in two stages. `selectRanked` (`lib/ranking.ts:128-146`) decides *which results* get injected — composite threshold, chatter quota, `maxResults` cap. Then `formatSelected` (`hooks/auto-context.ts:75-96`) decides *which highlights within each selected result* to render:

```ts
function formatSelected(selected: RankedResult[], threshold: number): string | null {
  const sections: string[] = []

  for (const r of selected) {
    const hiFloor = Math.min(threshold, r._base)
    const chosen = [...r.highlights]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter((h) => (h.score ?? 0) >= hiFloor)
      .slice(0, 2)
    if (chosen.length === 0) continue
    ...
```

The floor is per-highlight and absolute: `hiFloor = Math.min(threshold, r._base)`. Nothing relates the second highlight's score to the first's. Two consequences:

- A .95/.58 pair (with `hiFloor` at the default `relevanceThreshold` 0.6 — wait, .58 is below 0.6; take a boosted-but-quiet result where `r._base = 0.5`, so `hiFloor = 0.5`): both highlights render, though the second is barely half as relevant as the first and usually restates a weaker echo of the same content.
- The `hiFloor = Math.min(threshold, r._base)` design (there deliberately, per the comment at `hooks/auto-context.ts:70-74`, so boosted-but-quiet memories aren't hidden) makes this *worse* for exactly those quiet results: a low `_base` lowers the floor for **both** highlights, so the weak second one rides in under a floor that was lowered to protect the strong first one.

The chatter quota and relevance threshold can't touch this — they operate on whole results (`selectRanked` never looks inside `r.highlights`). This is fluff *within* a correct selection, and it directly costs injected-context tokens on every turn where auto-context fires (both the single-user path at `hooks/auto-context.ts:208` and the multi-user path at `hooks/auto-context.ts:345` call `formatSelected`).

## 3. Proposed design

### Gap form: absolute score difference

Include the second highlight only when `topScore - secondScore <= HIGHLIGHT_GAP`.

Absolute-difference, not ratio, for three reasons:

1. **Codebase convention.** Every score comparison in this pipeline is absolute and additive: `hiFloor` is an absolute floor, `relevanceThreshold` (default 0.6) is an absolute cut, and the composite ranking works in absolute score deltas (`curationBoost` 0.2, `chatterPenalty` 0.2, `storyBoost` 0.15 — `lib/ranking.ts:36-44`). A ratio rule ("second must be ≥ 80% of top") would be the only multiplicative comparison in the file.
2. **Behavior at the scores that matter.** Selected results skew high (they cleared a ~0.6 composite threshold). In the .8–1.0 band, an absolute 0.15 gap and an ~84% ratio behave nearly identically, so the ratio buys nothing — while at low top scores a ratio gets *stricter* in absolute terms (80% of .5 demands the second be within .1) for no principled reason.
3. **Simplicity of reasoning.** "Within 0.15 of the top" composes mentally with the existing constants; "within 84%" doesn't.

### Default value: `0.15`

- Matches the magnitude of the existing score-space nudges (`storyBoost` is exactly 0.15; boosts/penalties cluster at 0.15–0.2), so the tolerance is "one boost's worth of score."
- The issue's motivating fixture (.95/.4, gap .55) is dropped decisively; a close pair (.95/.85, gap .10) is kept; a middling pair (.95/.75, gap .20) is dropped, which is the intent — at that spread the second highlight is usually a weaker paraphrase of the first.
- Boundary is inclusive (`<=`): a gap of exactly 0.15 keeps the second highlight, consistent with `>=` on `hiFloor`.

### Modified `formatSelected` sketch

```ts
const HIGHLIGHT_GAP = 0.15

function formatSelected(selected: RankedResult[], threshold: number): string | null {
  const sections: string[] = []

  for (const r of selected) {
    const hiFloor = Math.min(threshold, r._base)
    const passing = [...r.highlights]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter((h) => (h.score ?? 0) >= hiFloor)
    if (passing.length === 0) continue

    // Top highlight is always kept; the second rides along only when it is
    // nearly as strong — a distant second is dilution inside a correct pick.
    const [top, second] = passing
    const chosen =
      second && (top.score ?? 0) - (second.score ?? 0) <= HIGHLIGHT_GAP
        ? [top, second]
        : [top]

    const title = r.title ?? `[${r.source}]`
    const bullets = chosen
      .map((h) => `- ${h.text.replace(/\n/g, " ")} [${Math.round((h.score ?? 0) * 100)}%]`)
      .join("\n")

    sections.push(`### ${title} (resource_id: ${r.resourceId}, source: ${r.source})\n\n${bullets}`)
  }

  if (sections.length === 0) return null
  return sections.join("\n\n")
}
```

Notes on the sketch:

- **Invariant — top highlight always kept.** The gap logic only decides whether `second` joins `top`; `top` is unconditional once it passes `hiFloor`. A result selected by `selectRanked` therefore renders at least as many highlights as it would need to render today to appear at all — the change can never turn a selected result into an empty section. The existing `if (passing.length === 0) continue` degrade path (a selected result whose highlights all miss `hiFloor`) is unchanged.
- The gap check runs **after** the `hiFloor` filter, on the sorted survivors, so the two rules compose: floor first (is this highlight relevant at all?), gap second (is the runner-up close enough to the winner to be worth its tokens?).
- Keep the `(h.score ?? 0)` coalescing convention from the current code (`Highlight.score` is typed non-optional in `client.ts` but the code defends anyway; the gap comparison should too).
- `slice(0, 2)` disappears; destructuring `[top, second]` replaces it. Highlights beyond the second were never rendered and still aren't.

### Fixed constant vs. config field: fixed constant

Recommendation: a module-level `const HIGHLIGHT_GAP = 0.15` in `hooks/auto-context.ts`.

The repo's dividing line is visible in `config.ts`: things a deployment plausibly needs to tune for its own data are config (`maxResults`, `relevanceThreshold`, the whole `ranking` block parsed by `parseRanking` at `config.ts:230-247`); internal mechanics with one sane answer are constants (`MAX_ATTEMPTS` in `hooks/startup-orientation.ts`, retry/debounce internals). The gap threshold is the latter today: it's a formatting heuristic two levels below anything a user reasons about, there is no evidence yet that different vaults need different values, and every config field added to `parseRanking` is permanent API surface on a published npm package.

Escape hatch: if live tuning shows real variance across deployments, promote it to `ranking.highlightGap` later — `parseRanking` + `DEFAULT_RANKING` make that a three-line additive change (`num(r.highlightGap, DEFAULT_RANKING.highlightGap)`), fully backward compatible. Start constant; earn the config field.

## 4. Test plan

### Export `formatSelected`

`formatSelected` is currently private. Recommend exporting it and testing it directly rather than through `buildAutoContextHandler`: it is already a pure function of `(selected, threshold)` with a string-or-null return, whereas handler-level testing requires stubbing `HyperspellClient.search`, session resolution, and config, then asserting against the fully wrapped `<hyperspell-context>` envelope — far more fixture for far less precision. Precedent: `dropCurrentSession` was exported from the same file for exactly this kind of direct testing (`hooks/auto-context.test.ts`). Add `export` to the function; no other code change.

Tests go in the existing `hooks/auto-context.test.ts`, same conventions (`node:test` + `node:assert/strict`, a small `result(...)` fixture builder extended to take highlights). Run with `node --test --experimental-strip-types hooks/auto-context.test.ts`.

### Cases

Fixture builder: a `RankedResult` with `_kind: "curated"`, `_base` set so `hiFloor` doesn't interfere (see each case), threshold `0.6`.

1. **Characterization first — current behavior attaches the marginal second.** Fixture: highlights `[.95, .4]`, `_base: 0.4` (so `hiFloor = min(0.6, 0.4) = 0.4` and the .4 highlight passes the floor today). Assert the output contains **both** bullets (`[95%]` and `[40%]`). Write and commit this expectation *before* the change (or write it, watch it pass, then flip it) — it proves the bug is real, not hypothetical.
2. **Gap cutoff drops the weak second.** Same fixture after the change: output contains the `[95%]` bullet and does **not** contain `[40%]`. Exactly one `- ` bullet line in the section.
3. **Close pair keeps both.** Highlights `[.95, .85]`, `_base: 0.85`: gap .10 ≤ .15 → both bullets present.
4. **Boundary is inclusive.** Highlights `[.95, .80]`: gap exactly .15 → both kept.
5. **Invariant — top always survives.** Single-highlight result (`[.95]`) renders its one bullet; and a `[.95, .4]` result still renders a non-empty section (never formats a selected result to nothing).
6. **Floor still composes.** Highlights `[.95, .9]` but `_base`/threshold such that `hiFloor = 0.92`: the .9 fails the floor before the gap is consulted → one bullet, no crash.

### Live inspection before changing anything

Confirm today's real behavior on actual injected blocks — the rendered bullets already carry their scores as `[NN%]` suffixes, so no new instrumentation is needed:

1. On a live install (e.g. alinea — read-only, nothing mutated), set `debug: true` and let auto-context fire for a few turns; or grep recent session transcripts for `<hyperspell-context>` blocks.
2. For every `### ...` section with two bullets, extract the two `[NN%]` values and compute the gap. Tally: how many two-bullet sections exist, and what fraction have gap > 0.15.
3. Alternatively (no live agent needed): a one-off probe script in the style of the existing `docs/probe.mjs` scripts — call `client.search` with a handful of realistic prompts, run results through `rerank` → `selectRanked` → the current `formatSelected`, print each section's highlight-score pairs. This directly answers the issue's test bullet ("check whether formatSelected actually attaches marginal second highlights today") and also calibrates the 0.15 default against real gap distributions before committing to it.

## 5. Risks / tradeoffs

- **Gap too strict (e.g. 0.05–0.10):** genuinely complementary second highlights get dropped — two facets of one document (a decision and its rationale) often score .95/.78, and losing the second loses real context. Mitigation: the live-inspection step calibrates against the actual gap distribution before the value is locked; 0.15 was chosen to sit above typical same-document facet spreads at high scores.
- **Gap too loose (e.g. 0.3+):** almost every second highlight survives and the change is a no-op that adds code without fixing the fluff.
- **Score calibration assumption.** An absolute gap assumes highlight scores are on a comparable scale across sources (vault, Slack, Drive). If the backend's per-source scoring drifts, a fixed 0.15 means different strictness per source. Acceptable now (the absolute `relevanceThreshold` and `hiFloor` already make this assumption); revisit if the probe data shows per-source skew.
- **Interaction with the `hiFloor` protection.** The `Math.min(threshold, r._base)` floor exists to keep boosted-but-quiet memories visible. The gap rule tightens output for exactly those results (their lowered floor is what let weak seconds in), which is the point — but it must never touch the top highlight, or it would re-hide the quiet memories the floor protects. The always-keep-top invariant is load-bearing; test case 5 pins it.

## 6. Rollout

- Default `HIGHLIGHT_GAP = 0.15`, fixed constant, no new config surface — config-wise fully backward compatible, nothing to migrate.
- **This is still a behavior change worth calling out:** the shape of injected context changes — some memories that rendered two bullets will render one. Any downstream prompt-shape expectations (token budgeting, transcript diffing, eval fixtures asserting on injected blocks) will see shorter sections. Ship as a minor version with a changelog entry naming the new rule and the constant, and note the `formatSelected` export.
- Applies uniformly to both call sites (single-user and multi-user paths) since both go through `formatSelected`; `formatHighlightBullets` (the `ranking.enabled: false` path) is intentionally untouched — it has no per-result cap semantics to preserve and is the legacy path.
- Post-rollout check: rerun the step-4 live inspection; expect the two-bullet-with-large-gap sections to be gone and close-pair sections unchanged.

## 7. Effort estimate

**S** — one pure function edited in place (plus its export), ~6 focused unit tests in an existing test file, and a read-only probe; no config, schema, or API changes.
