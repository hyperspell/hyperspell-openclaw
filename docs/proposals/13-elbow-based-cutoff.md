# Proposal 13 — Elbow-based dynamic cutoff instead of a fixed `maxResults`

> Idea #13 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)).
> This is an implementation guide, not an implementation. No functional code changes ship with this PR.

## 1. Summary

`selectRanked` today stops injecting memories at a fixed count (`maxResults`, default 10) plus a flat score threshold — it has no notion of *where the signal actually runs out* for a given query. This proposal adds a cheap, online "elbow" rule to `selectRanked`: while accepting results, track the average score drop between consecutive accepted results, and stop early when the next drop is both a large multiple of that average **and** big in absolute terms — but never before a minimum-results floor, and never in a way that returns more than the existing threshold/quota/`maxResults` logic would. The elbow can only cut *earlier*; when no clear cliff exists, behavior is byte-for-byte identical to today. It ships behind a config flag (`ranking.elbow.enabled`, default `false`) and is validated against real score distributions collected by a small live-client script before any default change.

## 2. Problem

The stopping rule in `lib/ranking.ts` is purely a fixed count plus a flat threshold. `selectRanked` (`lib/ranking.ts:128-146`) is, in full:

```ts
export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): RankedResult[] {
	const out: RankedResult[] = [];
	let chatter = 0;
	for (const r of ranked) {
		if (r._composite < threshold) continue;
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) continue;
			chatter++;
		}
		out.push(r);
		if (out.length >= maxResults) break;
	}
	return out;
}
```

The input is already sorted descending by composite score (`rerank`, `lib/ranking.ts:106-120`). So the three stopping conditions today are:

1. **Flat threshold** — `if (r._composite < threshold) continue` (line 137)
2. **Chatter quota** — skip chatter beyond `chatterQuota` (lines 138-141)
3. **Fixed count** — `if (out.length >= maxResults) break` (line 143)

None of these look at the *shape* of the score curve. Two failure modes follow:

- **Narrow query, thin signal**: 2 genuinely relevant memories at composite 0.82/0.80, then a cliff down to a plateau of marginal 0.55-ish results that still clear the default threshold. Today all of them are injected up to 10, padding the context with near-noise.
- **Broad query, wide signal**: 15 comparably good candidates; the fixed cap truncates at 10. (This proposal does **not** fix the broad case — the elbow only cuts earlier, never later. Raising the ceiling is a separate, deliberate decision; see §5.)

The single-user auto-context path already sets the elbow up to have something to work with: when ranking is enabled it fetches a widened candidate pool of `cfg.maxResults * ranking.candidateMultiplier` (`hooks/auto-context.ts:189-191`, default multiplier 3 → 30 candidates) and calls `selectRanked(ranked, cfg.maxResults, cfg.relevanceThreshold, ranking.chatterQuota)` (`hooks/auto-context.ts:202-207`). Config surface: `maxResults` defaults to 10 (`config.ts:575`), bounded 1-20 by the manifest schema (`openclaw.plugin.json:166-170`); ranking weights are parsed by `parseRanking` (`config.ts:230-247`) against the `ranking` schema object (`openclaw.plugin.json:171-184`).

Scope note: the multi-user path formats personal/shared sections via `formatHighlightBullets`, not `selectRanked` (`hooks/auto-context.ts:334-356`), so the elbow initially applies only where composite ranking applies — the single-user ranked path. That is also where the chatter problem this brainstorm targets actually lives.

## 3. Proposed design

### 3.1 The elbow rule

Work *online, inside the accept loop*, over the results actually accepted so far (post-threshold, post-quota) — not over the raw ranked list. For a small list (~10-30 candidates) this is O(1) extra work per candidate and needs no second pass, no derivatives, no kneedle-style curve fitting.

Definitions, at the moment candidate `r` is about to be accepted:

- `gap` = `out[out.length - 1]._composite - r._composite` — the drop from the last *accepted* result to this candidate.
- `gapSum` = running sum of the gaps recorded when each accepted result (after the first) was pushed; `meanGap = gapSum / (out.length - 1)`.

**Stop (break) before accepting `r` iff all of:**

1. `elbow.enabled` is true,
2. `out.length >= elbow.minResults` — the floor has been met (see §3.3),
3. `gap >= elbow.minGap` — the drop is big in *absolute* terms (default `0.05`),
4. `gap >= elbow.gapRatio * meanGap` — the drop is big *relative* to the decline seen so far (default ratio `2.5`).

Condition 3 is what keeps a nearly-flat list from tripping the ratio test: if the accepted scores are 0.71, 0.709, 0.708, `meanGap` is ~0.001 and a routine 0.01 wobble would exceed `2.5 × meanGap` — but it cannot exceed the 0.05 absolute floor, so no elbow fires. Condition 4 is what keeps a *steadily* declining list from tripping the absolute test: gaps of exactly 0.05 each give `meanGap = 0.05`, and the next 0.05 gap fails `>= 0.125`. Both conditions must hold — the elbow fires only on a drop that is an outlier against the local trend *and* material on the raw score scale. Condition 4 is also trivially true when `meanGap` is 0 (all accepted scores equal), which is exactly right: any material drop off a flat plateau is a cliff, and condition 3 still gates it.

Worked example (the narrow-query case): composites `[0.85, 0.82, 0.80, 0.55, 0.53, 0.52, …]`, `minResults = 3`. After accepting three, `gapSum = 0.03 + 0.02 = 0.05`, `meanGap = 0.025`. Candidate 4 has `gap = 0.25`: `0.25 >= 0.05` ✓ and `0.25 >= 2.5 × 0.025 = 0.0625` ✓ → stop with 3 results instead of padding to 10.

Gradual-decline example: `[0.85, 0.80, 0.75, 0.70, 0.65, …]`. Every gap is 0.05; `meanGap` stays 0.05; the ratio test needs 0.125 and never sees it → the elbow never fires and selection proceeds exactly as today, out to `maxResults`/threshold.

### 3.2 Composition with the existing stopping conditions

The elbow is a **strictly earlier** `break` inserted into the existing loop. Nothing else moves:

- The `threshold` skip (`continue`) runs first, unchanged. Results the threshold rejects are never accepted, never counted, and never contribute gaps.
- The elbow check runs next, *before* the chatter-quota bookkeeping, so an elbow break never increments the chatter counter for a result it refuses. (Ordering vs. the quota check is otherwise immaterial: scores are sorted descending, so if the gap to *this* candidate clears the elbow, the gap to any later-accepted candidate is at least as large — the elbow would fire there anyway.)
- The chatter quota skip runs unchanged.
- `if (out.length >= maxResults) break` runs unchanged — **`maxResults` becomes the ceiling, the elbow an optional earlier stop.** No change to the `maxResults` schema or its meaning when the elbow is off.

Because the elbow can only `break` and never `push`, it can never force MORE results than threshold + quota + `maxResults` allow. Because it is gated on `out.length >= minResults`, and because when it never fires the loop is untouched, `selectRanked` with `elbow.enabled: false` (or with `elbow` omitted) is behavior-identical to today — this satisfies the repo rule that the change must be strictly conservative and can never return zero results merely because no elbow was found. If the pool is thin (fewer than `minResults` clear the threshold), the elbow simply never activates and the caller gets exactly what today's logic gives.

One subtlety worth a code comment: when the threshold or quota skips candidates *between* two accepted results, the recorded gap spans the skipped rows and looks larger than the raw adjacent-pair drop. That is intentional — the gap that matters is between results that could actually be injected — but it means quota-skipped chatter mildly increases the chance the elbow fires just after it. Acceptable: the skipped rows were never injectable anyway.

### 3.3 The minimum-results floor

`elbow.minResults`, default **3**, clamped to `>= 2` in `parseRanking` (at least one gap must exist before `meanGap` is defined; the first accepted result never records a gap). The elbow check is skipped entirely until `out.length >= minResults`, so even a pathological distribution like `[0.95, 0.40, 0.38, 0.37, …]` — a huge gap right after the first result — still yields at least 3 results (threshold permitting): the 0.55 drop between #1 and #2 is never examined because `out.length` is 1 at that point. The elbow can therefore never cut to 0 or 1 results; the only things that can are the pre-existing threshold and pool size, exactly as today.

### 3.4 Code sketch

New type + default in `lib/ranking.ts` (stays pure, no side effects):

```ts
export type ElbowOptions = {
	enabled: boolean;
	/** Never stop before this many accepted results (clamped >= 2). */
	minResults: number;
	/** Fire only if the drop is this multiple of the mean accepted-gap so far. */
	gapRatio: number;
	/** Fire only if the drop is at least this big in absolute composite terms. */
	minGap: number;
};

export const DEFAULT_ELBOW: ElbowOptions = {
	enabled: false,
	minResults: 3,
	gapRatio: 2.5,
	minGap: 0.05,
};
```

Modified `selectRanked` — the new parameter is optional, so every existing call site and test compiles and behaves unchanged:

```ts
export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
	elbow?: ElbowOptions,
): RankedResult[] {
	const out: RankedResult[] = [];
	let chatter = 0;
	let gapSum = 0;
	for (const r of ranked) {
		if (r._composite < threshold) continue;
		if (elbow?.enabled && out.length >= Math.max(2, elbow.minResults)) {
			const gap = out[out.length - 1]._composite - r._composite;
			// Cliff = outlier vs the decline so far AND material in absolute terms;
			// the two-part test keeps flat lists (tiny meanGap) and steady declines
			// (every gap "big") from tripping it.
			if (gap >= elbow.minGap && gap >= elbow.gapRatio * (gapSum / (out.length - 1)))
				break;
		}
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) continue;
			chatter++;
		}
		if (out.length > 0) gapSum += out[out.length - 1]._composite - r._composite;
		out.push(r);
		if (out.length >= maxResults) break;
	}
	return out;
}
```

Plumbing (all mechanical):

- `RankingWeights` in `lib/ranking.ts` gains `elbow: ElbowOptions`; `DEFAULT_RANKING` gains `elbow: DEFAULT_ELBOW`.
- `parseRanking` (`config.ts:230-247`) parses the nested object: `enabled` boolean defaulting false, `minResults: Math.max(2, num(...))`, `gapRatio: Math.max(1, num(...))`, `minGap: Math.max(0, num(...))`.
- The single-user call site (`hooks/auto-context.ts:202-207`) passes `ranking.elbow` as the fifth argument, and the existing ranked-injection debug line gains the elbow verdict, e.g. `elbow stopped at 3 (ceiling 10)` vs `elbow: no cliff` — this log line is the primary live-validation instrument (§6).
- `openclaw.plugin.json` `ranking` schema object (`lines 171-184`) gains:

```json
"elbow": {
	"type": "object",
	"additionalProperties": false,
	"description": "Stop injecting early at a natural score cliff instead of always filling maxResults. Conservative: only ever cuts earlier, never later; falls back to plain maxResults/threshold when no clear cliff exists.",
	"properties": {
		"enabled": { "type": "boolean" },
		"minResults": { "type": "number", "minimum": 2, "maximum": 20 },
		"gapRatio": { "type": "number", "minimum": 1, "maximum": 10 },
		"minGap": { "type": "number", "minimum": 0, "maximum": 1 }
	}
}
```

plus a matching `uiHints` entry if the other `ranking` fields have one.

## 4. Test plan

### 4.1 Live score-distribution collection (validates the idea, not just the code)

Add `docs/elbow-scan.mjs`, mirroring the existing live-client scripts (`docs/hotbuffer-verify.mjs` pattern: read `~/.openclaw/openclaw.json` → `plugins.entries["openclaw-hyperspell"].config` for `apiKey`/`userId`, construct the `hyperspell` client directly). Run with `node --experimental-strip-types docs/elbow-scan.mjs` so it can import `rerank`/`selectRanked` straight from `../lib/ranking.ts` and score with the *exact* production math rather than a reimplementation.

Per query it should:

1. Read a batch of real prompts — from a `--prompts <file>` newline-delimited file (e.g. pulled from recent session transcripts), falling back to a small built-in mix of narrow ("what is Heath's relationship to Junii") and broad ("what have we been working on lately") queries.
2. Search with `limit = maxResults * candidateMultiplier` and the live config's filter, exactly as `hooks/auto-context.ts:189-193` does.
3. `rerank` with the live config's weights and print the full descending composite list with per-pair gaps, annotated with three markers: where the current fixed cutoff (10) falls, where each candidate elbow parameterization would stop, and the threshold line.
4. Emit JSON (`-o` flag) so parameter sweeps are scriptable: for a grid of `gapRatio ∈ {2, 2.5, 3}` × `minGap ∈ {0.03, 0.05, 0.08}`, report per-query stop index and an aggregate "elbow fired on N% of queries, median cut at k".

Acceptance for proceeding to rollout: on ~30-50 real prompts, a human eyeballs each printed distribution and marks where "the rest isn't really relevant"; the chosen parameterization should (a) fire on a meaningful fraction of narrow queries, (b) land within ±1 of the human mark when it fires, and (c) essentially never fire on the broad queries the human marked as "all decent". If no parameterization achieves that, the idea fails its own test cheaply, before any production wiring.

### 4.2 Unit tests (`lib/ranking.test.ts`)

Follow the existing conventions: `node --test --experimental-strip-types lib/ranking.test.ts`, plain `node:test` + `node:assert`, reusing the file's `ranked(kind, composite, id)` fixture helper (`lib/ranking.test.ts:86-91`). Define a local `const ELBOW = { enabled: true, minResults: 3, gapRatio: 2.5, minGap: 0.05 }`.

**(i) Obvious early cliff → stops before `maxResults`:**

```ts
test("selectRanked — elbow: stops at a clear score cliff before maxResults", () => {
	const list = [
		ranked("curated", 0.85, "a"),
		ranked("curated", 0.82, "b"),
		ranked("curated", 0.80, "c"),
		ranked("other", 0.55, "d"), // gap 0.25 vs meanGap 0.025 → cliff
		ranked("other", 0.53, "e"),
		ranked("other", 0.52, "f"),
	];
	const sel = selectRanked(list, 10, 0.4, 2, ELBOW);
	assert.deepEqual(sel.map((r) => r.resourceId), ["a", "b", "c"]);
});
```

**(ii) Gradual decline, no cliff → identical to the plain behavior:**

```ts
test("selectRanked — elbow: gradual decline falls through to maxResults/threshold unchanged", () => {
	const list = [0.85, 0.80, 0.75, 0.70, 0.65, 0.60].map((s, i) =>
		ranked("curated", s, `g${i}`),
	);
	const withElbow = selectRanked(list, 5, 0.4, 2, ELBOW);
	const without = selectRanked(list, 5, 0.4, 2);
	assert.deepEqual(withElbow, without, "no cliff → byte-identical selection");
	assert.equal(withElbow.length, 5, "still fills to maxResults");
});
```

**(iii) Extreme early gap → the floor holds:**

```ts
test("selectRanked — elbow: minResults floor holds even across a huge early gap", () => {
	const list = [
		ranked("curated", 0.95, "a"),
		ranked("curated", 0.40, "b"), // 0.55 drop — but floor not met yet
		ranked("curated", 0.38, "c"),
		ranked("curated", 0.37, "d"),
	];
	const sel = selectRanked(list, 10, 0.3, 2, ELBOW);
	assert.ok(sel.length >= 3, "never cut below the floor");
	assert.deepEqual(sel.slice(0, 3).map((r) => r.resourceId), ["a", "b", "c"]);
});
```

Additional cases worth writing while in there: flat list (all 0.70) never fires despite `meanGap = 0` (proves the `minGap` guard); `elbow` omitted / `enabled: false` leaves the two existing `selectRanked` tests' behavior untouched (regression guard for the optional-parameter contract); a cliff that sits exactly at `minResults` (fires on the first eligible check).

## 5. Risks / tradeoffs

- **Too aggressive → under-serving broad queries.** A broad query legitimately backed by many decent-but-not-great memories can contain a moderately large gap between its "good" and "decent" bands; an eager elbow trims context the agent would have used. Mitigations: the two-part (relative AND absolute) test, the `minResults` floor, defaults chosen from the §4.1 scan rather than intuition, and the off-by-default flag.
- **Too conservative → dead code.** If `gapRatio`/`minGap` are set so no real distribution ever trips them, this is pure complexity for nothing. The §4.1 sweep must show a real firing rate before merge, and the debug log line makes the live firing rate observable after; if it rounds to zero on a real install, remove the feature rather than leaving it.
- **Doesn't help the truncation half of the stated problem.** By design the elbow never extends past `maxResults`, so broad queries with 15 good candidates stay truncated at 10. That is deliberate (strictly conservative change); "elbow-aware ceiling raising" would be a separate proposal with its own risk profile (context-window pressure).
- **Gap semantics interact with skips.** Threshold/quota-skipped rows widen the observed accepted-to-candidate gap (§3.2), so the elbow fires slightly more readily immediately after skipped chatter. Judged acceptable, but the §4.1 scan should run with the live chatter quota so the tuned parameters bake this in.
- **Composite-scale coupling.** `minGap = 0.05` is meaningful on the current composite scale (base relevance ± boosts of 0.15-0.2). If ranking weights are retuned substantially, `minGap` needs revisiting — worth a sentence in the config description.

## 6. Rollout

Gate behind `ranking.elbow.enabled`, default **`false`** — with the flag off, `selectRanked`'s behavior is provably identical (the optional parameter short-circuits), so shipping the code is risk-free. Sequence:

1. Land the pure-function change + tests + config plumbing, flag off everywhere.
2. Run `docs/elbow-scan.mjs` against a real install's data to pick `gapRatio`/`minGap` (per §4.1 acceptance).
3. Enable on one live install (alinea is the natural candidate — verify ranking is enabled there first) and watch the debug line `elbow stopped at k (ceiling N)` for a week or so: firing rate, cut depths, and any "that memory should have been there" complaints.
4. Only then discuss flipping the default; keep the flag either way, since the right aggressiveness is corpus-dependent.

## 7. Effort estimate

**S** — a ~10-line change to one pure function, mechanical config/schema plumbing, straightforward unit tests, and a validation script that mirrors an existing pattern; the only genuinely open work is parameter tuning, which the scan script makes cheap.
