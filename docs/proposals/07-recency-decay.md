# Proposal 07 — Recency decay in the composite ranking score

Idea #7 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Design doc only — no functional code ships with this PR.

## 1. Summary

The composite ranking score in `lib/ranking.ts` has no time term: a two-year-old memory and yesterday's memory with the same semantic relevance tie exactly, and whichever the backend happened to order first wins. This proposal adds a gentle, age-based additive penalty to `scoreResult`, computed from the `createdAt` field already present on every `SearchResult`. The decay is exponential with a configurable half-life (default **90 days**), is capped so it can never exceed a bounded maximum penalty (default **0.1** — half a `curationBoost`), applies at a reduced rate to `curated`/`story` results (deliberately kept memory ages slower), and applies no penalty at all when `createdAt` is null (fail-open, matching the codebase's never-punish-on-missing-data convention). Existing configs need no changes; `recencyHalfLifeDays: 0` disables the term entirely.

## 2. Problem

`scoreResult` (`lib/ranking.ts:91-103`) computes the composite as pure relevance plus kind-based adjustments:

```ts
const base = baseScore(r);            // lib/ranking.ts:58-64 — max(doc score, best highlight score)
let composite = base;
if (kind === "story") composite += w.storyBoost + w.curationBoost;
else if (kind === "curated") composite += w.curationBoost;
else if (kind === "chatter") composite -= w.chatterPenalty;
```

There is zero time component. `RankingWeights` (`lib/ranking.ts:19-34`) has no recency field, and neither `rerank` (`lib/ranking.ts:106-120`) nor `selectRanked` (`lib/ranking.ts:128-146`) looks at timestamps.

Yet the raw data is already there: `SearchResult.createdAt` is `string | null` (`client.ts:22`), populated from `doc.metadata.created_at` in both search paths (`client.ts:145`, `client.ts:246`). We fetch the timestamp on every result and then ignore it.

Concrete failure mode: the user asks "what editor config do I use?" A note from 2024 and a note from last week both mention editor config with similar cosine similarity. The stale one can outrank the current one, and the agent confidently grounds itself in a preference that was superseded eighteen months ago. Relevance measures *aboutness*, not *currency* — for memories that describe mutable state (preferences, project status, who owns what), currency is half the signal.

## 3. Proposed design

### 3.1 Mathematical form: exponential half-life, applied as a bounded additive penalty

**Decay curve — exponential with a half-life in days:**

```
ageDays  = max(0, (now − createdAt) / 86_400_000)
decay    = 0.5 ** (ageDays / halfLifeDays)        // 1.0 at age 0, 0.5 at one half-life, → 0
penalty  = maxPenalty × (1 − decay)               // 0 at age 0, → maxPenalty asymptotically
composite = base ± kindAdjustments − penalty
```

**Why additive penalty, not a multiplier on relevance.** Two reasons, both grounded in how this file already works:

1. **Consistency with the existing algebra.** Every adjustment in `scoreResult` today is additive (`+storyBoost`, `+curationBoost`, `−chatterPenalty`), and the weights are tuned against each other on that additive scale — the canonical test at `lib/ranking.test.ts:52-72` reasons in exact sums (`0.47 + 0.20 = 0.67`). A multiplicative decay (`composite = base × decay ± boosts`) would interact nonlinearly with those tuned constants: a 0.9 base decayed at 0.5 loses 0.45 points, while a 0.4 base loses 0.2 — old-but-highly-relevant results would be punished *hardest*, which is exactly backwards for the stated risk ("a real still-true old preference shouldn't lose to something merely recent and shallow").
2. **Boundedness.** An additive penalty capped at `maxPenalty` guarantees the worst case: an infinitely old result loses at most 0.1 composite points. That makes the term easy to reason about against the other weights — it can break ties and reorder near-ties, but it can never on its own bury a result that out-relevances a rival by more than 0.1. A multiplier has no such natural cap.

So recency here is a **tiebreaker with teeth, not a dominant signal** — which is the correct posture for a memory system whose whole thesis (see the header comment at `lib/ranking.ts:3-17`) is that kept memory beats loud recent noise.

**Why `1 − decay` shaped as a penalty rather than `decay` as a bonus:** identical ordering effect, but the penalty form means a brand-new result scores exactly `base ± kindAdjustments` — the current formula unchanged. All existing composite-value expectations (and the exact-sum assertions in the current tests) stay true for age-0 fixtures, and behavior converges to today's as `ageDays → 0`. Fresh results are the baseline; old results drop below it.

### 3.2 New `RankingWeights` fields

```ts
export type RankingWeights = {
	// ...existing fields...
	/** Half-life in days for the recency penalty. A result this old has accrued
	 * half of recencyMaxPenalty. 0 disables recency entirely. */
	recencyHalfLifeDays: number;
	/** Ceiling on the recency penalty — the most an arbitrarily old result can
	 * lose. Keeps recency a tiebreaker, never a dominant signal. */
	recencyMaxPenalty: number;
	/** Fraction of the penalty applied to curated/story results (0..1).
	 * Kept memory describes durable truths; it ages slower than chatter. */
	recencyCuratedFactor: number;
};

export const DEFAULT_RANKING: RankingWeights = {
	// ...existing defaults...
	recencyHalfLifeDays: 90,
	recencyMaxPenalty: 0.1,
	recencyCuratedFactor: 0.5,
};
```

### 3.3 Modified `scoreResult` (sketch)

`scoreResult` currently takes no clock. Thread `now` through as an optional parameter defaulting to `Date.now()` so tests are deterministic — same pattern as passing `storyTerms` explicitly in the existing tests.

```ts
function recencyPenalty(
	createdAt: string | null,
	kind: ResultKind,
	w: RankingWeights,
	now: number,
): number {
	if (w.recencyHalfLifeDays <= 0 || w.recencyMaxPenalty <= 0) return 0;
	if (!createdAt) return 0; // unknown age — never punish missing data
	const ts = Date.parse(createdAt);
	if (Number.isNaN(ts)) return 0; // unparseable — same fail-open rule
	const ageDays = Math.max(0, (now - ts) / 86_400_000);
	const decay = 0.5 ** (ageDays / w.recencyHalfLifeDays);
	const kept = kind === "curated" || kind === "story";
	const factor = kept ? w.recencyCuratedFactor : 1;
	return w.recencyMaxPenalty * (1 - decay) * factor;
}

export function scoreResult(
	r: SearchResult,
	w: RankingWeights,
	now: number = Date.now(),
): { kind: ResultKind; base: number; composite: number } {
	const kind = classifyResult(r, w.storyTerms);
	const base = baseScore(r);
	let composite = base;
	if (kind === "story") composite += w.storyBoost + w.curationBoost;
	else if (kind === "curated") composite += w.curationBoost;
	else if (kind === "chatter") composite -= w.chatterPenalty;
	composite -= recencyPenalty(r.createdAt, kind, w, now);
	return { kind, base, composite };
}
```

`rerank` grows the same optional `now` parameter and forwards it, so one `rerank` call scores every candidate against a single consistent clock. No changes to `selectRanked`, `classifyResult`, or `baseScore`. Callers in `hooks/auto-context.ts` (both the single-user path and `multiUserSearch`) need no changes — the default argument covers them.

### 3.4 Default half-life: 90 days — the reasoning

The stated risk cuts both ways, but asymmetrically: **too-fast decay silently corrupts retrieval quality** (true old preferences vanish behind recent shallow mentions — the exact failure this plugin exists to prevent), while **too-slow decay merely under-delivers the feature** (stale ties still occasionally win). Start conservative and tighten later with evidence.

At `halfLifeDays = 90`, `maxPenalty = 0.1`, `curatedFactor = 0.5`, the penalty schedule is:

| Age | decay | chatter/other penalty | curated/story penalty |
|---|---|---|---|
| 1 day | 0.992 | 0.001 | 0.000 |
| 1 week | 0.947 | 0.005 | 0.003 |
| 1 month | 0.794 | 0.021 | 0.010 |
| 3 months | 0.500 | 0.050 | 0.025 |
| 6 months | 0.250 | 0.075 | 0.038 |
| 1 year | 0.060 | 0.094 | 0.047 |
| 2 years | 0.004 | 0.100 | 0.050 |

Sanity checks against the weights and thresholds already in play:

- **Exact ties break correctly.** The issue's core case — same relevance, one from yesterday, one from two years ago — resolves toward the recent one by ~0.1 (or ~0.05 curated). Done.
- **A still-true old preference survives.** A two-year-old curated note at 0.55 relevance scores `0.55 + 0.2 − 0.05 = 0.70`. A same-day chatter fragment needs raw relevance **> 0.90** to beat it (`0.90 − 0.2 = 0.70`). That's essentially unreachable for a shallow mention; the curated old note is safe by a wide margin.
- **Sub-week ordering is untouched.** Within a week the penalty is ≤ 0.005 — far below the noise floor of cosine scores — so this doesn't turn ranking into "latest session wins," which would re-amplify chatter (recent auto-saved fragments are, by construction, the *newest* things in the index; a fast decay would hand them back the advantage that `chatterPenalty` and `chatterQuota` exist to take away).
- **Threshold interactions are bounded.** `selectRanked` filters on composite ≥ threshold; the worst-case drop of 0.1 means results within 0.1 above the configured `relevanceThreshold` can now fall below it when very old. That is the intended behavior (ancient marginal results are the least valuable injections), and the cap keeps it from ever excluding a strong match.

Weeks-scale (e.g. 14–30 day) half-lives were considered and rejected as defaults: at 30 days a 6-month-old memory is already ~97% decayed, making the penalty a de-facto constant −0.1 on everything older than a season — all cap, no curve, and the cap then fights `curationBoost` directly. 90 days keeps the curve meaningful across the 1-month-to-1-year band where "is this still current?" is genuinely ambiguous.

### 3.5 Kind interaction: kept memory decays slower — an explicit choice

Should decay be uniform, or interact with kind? **Recommendation: interact, via `recencyCuratedFactor` (default 0.5) applied to `curated` and `story`.**

Rationale: age predicts staleness *differently per kind*. A chatter fragment is a snapshot of one conversational moment — its truth value genuinely rots with time. A curated note or the active story is something deliberately kept precisely because it's meant to outlive the moment ("kept memory is more likely to still be relevant regardless of age"). Applying full decay uniformly would partially claw back `curationBoost` on old notes — at 2 years, a uniform −0.1 wipes out half of the +0.2 curation edge, re-shrinking the very gap between kept memory and noise that the composite was built to create. Halving the penalty for kept kinds (max −0.05 vs. `curationBoost` +0.2) preserves that architecture: the *relative* gap between an old curated note and old chatter actually widens with age, which matches the plugin's thesis.

Implementation-wise this is one multiply (see `recencyPenalty` above), not a per-kind half-life table — resist the temptation to add four half-life knobs; one factor is tunable enough until there's evidence otherwise. `story` gets the same factor as `curated` because the existing code already treats story as "kept memory too" (`lib/ranking.ts:99`).

### 3.6 `createdAt: null` — fail open

Per `client.ts:22` the field is `string | null`, and both mapping sites (`client.ts:145`, `client.ts:246`) coalesce a missing `metadata.created_at` to `null`. Per the codebase's convention (adjustments are earned by positive evidence; missing data never punishes — same spirit as `dropCurrentSession` tolerating an unresolvable session id), a `null` or unparseable `createdAt` gets **zero penalty**: the result ranks exactly as it does today. This means timestamp-less results hold a slight edge over very old timestamped ones — acceptable, because the alternative (guessing an age) invents data, and the cap bounds the edge at 0.1.

### 3.7 Config plumbing

- `config.ts` — `parseRanking()` (~`config.ts:230-247`) gains three lines following the existing `num(...)` + clamp pattern:
  ```ts
  recencyHalfLifeDays: Math.max(0, num(r.recencyHalfLifeDays, DEFAULT_RANKING.recencyHalfLifeDays)),
  recencyMaxPenalty: Math.max(0, num(r.recencyMaxPenalty, DEFAULT_RANKING.recencyMaxPenalty)),
  recencyCuratedFactor: Math.min(1, Math.max(0, num(r.recencyCuratedFactor, DEFAULT_RANKING.recencyCuratedFactor))),
  ```
- `openclaw.plugin.json` — the `ranking` object in `configSchema` has `"additionalProperties": false`, so the three keys **must** be added there or user configs setting them will fail validation:
  ```json
  "recencyHalfLifeDays": { "type": "number", "minimum": 0, "maximum": 3650 },
  "recencyMaxPenalty": { "type": "number", "minimum": 0, "maximum": 1 },
  "recencyCuratedFactor": { "type": "number", "minimum": 0, "maximum": 1 }
  ```
  plus matching `uiHints` entries mirroring the existing `ranking.*` hints.
- `config.test.ts` — extend the existing ranking-parsing cases: defaults applied when absent, values respected when present, negative values clamped to 0.

## 4. Test plan

All in `lib/ranking.test.ts`, using the existing `mk()` fixture helper (which already defaults `createdAt: null`) and the deterministic `now` parameter. Suggested fixed clock: `const NOW = Date.parse("2026-07-01T00:00:00Z")`.

1. **Issue #66's case — same relevance, different ages.** Two `curated` results, both `score: 0.6`, one `createdAt` 2 days before `NOW`, one 730 days before. `rerank([old, fresh], DEFAULT_RANKING, NOW)` — assert the fresh one ranks first and both composites differ by the expected penalty gap (~0.049 with curated factor). Pass the inputs old-first so the assertion proves reordering, not input order.

2. **Old-but-still-true beats shallow-but-recent (the risk case, directly).** A 2-year-old curated note (`score: 0.55`, real title, non-UUID id) vs. a 1-day-old chatter fragment (`score: 0.62`, "Unnamed Conversation" + session UUID — reuse the shape from `lib/ranking.test.ts:52-72`). Assert the old curated note still wins: `0.55 + 0.2 − ~0.05 = ~0.70` vs. `0.62 − 0.2 − ~0.001 = ~0.42`. This is the load-bearing test for the default weights — if a future tuning change breaks it, the half-life or cap is wrong.

3. **`createdAt: null` — no penalty.** Same result scored with `createdAt: null` and with `createdAt` at `NOW`; assert equal composites. Also one unparseable string (`"not-a-date"`) — equal again.

4. **Disable switch.** `recencyHalfLifeDays: 0` (and separately `recencyMaxPenalty: 0`): a 10-year-old result's composite exactly matches today's formula.

5. **Cap holds.** A 50-year-old chatter result: penalty is `< recencyMaxPenalty` and asymptotically close to it (e.g. `> 0.099`); never exceeds.

6. **Kept-memory factor.** Same age, same base: curated penalty ≈ 0.5 × chatter penalty.

7. **Future timestamps clamp to zero age.** `createdAt` one day *after* `NOW` (clock skew happens): penalty is 0, not negative (no accidental future-boost).

8. **Existing tests stay green untouched.** Every current fixture has `createdAt: null`, so all exact-sum assertions (e.g. `lib/ranking.test.ts:70-71`) pass unchanged — a built-in regression check that the fail-open path preserves today's behavior.

## 5. Risks / tradeoffs

- **Half-life too short** → recency becomes a proxy for "was mentioned lately," which structurally favors chatter (the newest content in the index is auto-saved conversation). Mitigations: the 0.1 cap, the curated factor, and test 2 pinning the canonical case. This is the dangerous direction; hence the conservative 90-day default.
- **Half-life too long** → feature under-delivers; stale near-ties still occasionally win. Cheap to fix later by lowering the config value — no code change. Acceptable as the failure mode of a first release.
- **One global half-life is a lie for some content.** "Preferred editor" rots in months; "sister's name" never rots. This proposal deliberately does not attempt per-content decay (that's an embedding/classification problem, adjacent to other #66 ideas); the cap ensures the worst mis-decay costs at most 0.1.
- **Configurable vs. fixed constant:** configurable, definitively. Install profiles vary too much for one constant — a personal companion agent (Alinea-style, years of durable memory) wants 180+ days or off; a fast-moving team assistant might want 30. Three knobs with safe defaults follow the existing `RankingWeights` pattern exactly.
- **Clock dependence.** `scoreResult` becomes time-dependent — same inputs, different day, different score. Contained by the injectable `now` (tests stay deterministic) and irrelevant at runtime (scores are computed per-search, never persisted).
- **Backend `created_at` semantics.** The penalty assumes `created_at` ≈ when the memory was made. If the backend ever rewrites it on re-index/update, old memories would masquerade as fresh — worth a one-time verification against the Hyperspell API during implementation, not a blocker.

## 6. Rollout

- **Defaults:** `recencyHalfLifeDays: 90`, `recencyMaxPenalty: 0.1`, `recencyCuratedFactor: 0.5`, shipped in `DEFAULT_RANKING` — on by default wherever `ranking.enabled` is already on.
- **No separate `enabled` flag.** The feature lives inside the existing `ranking.enabled` gate (recency is meaningless without the composite), and `recencyHalfLifeDays: 0` or `recencyMaxPenalty: 0` is a complete opt-out. A fourth boolean would be redundant surface area.
- **Backward compatibility:** no schema break. Existing configs omit the new keys and get the defaults via `parseRanking`'s established fallback pattern; the manifest schema addition is purely additive (new optional properties). Behavior change for existing installs is bounded by design: ≤ 0.1 composite shift, only on old results — a minor-version release (`0.x` bump per repo convention) with a changelog note, not a breaking change.
- **Post-release validation:** with `debug` logging on, compare a handful of real injections before/after on a live install (e.g. verify no beloved old curated memory dropped out of top-N). Tune `recencyHalfLifeDays` from evidence if needed.

## 7. Effort estimate

**S** — one pure function plus three plumbed config fields across four files (`lib/ranking.ts`, `config.ts`, `openclaw.plugin.json`, tests), no new dependencies, no API calls, callers untouched thanks to the defaulted `now` parameter; the care is all in the constants, and this document has already spent it.
