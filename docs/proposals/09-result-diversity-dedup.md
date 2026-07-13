# Proposal 09 — Diversity/dedup check across the selected result set

Idea #9 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Implementation guide only — no functional code in this PR.

## 1. Summary

`selectRanked` in `lib/ranking.ts` currently selects the top-N results purely by composite score, with a threshold cutoff and a chatter quota — but with no check that the selected items differ from each other. When several near-identical "curated" results exist on one theme (a re-synced doc, a memory saved in multiple forms, a journal entry quoted in a note), all of them can clear the threshold, none of them classify as chatter, and they fill every injection slot with the same information. This proposal adds a cheap, dependency-free near-duplicate check inside `selectRanked`: as each candidate is considered in score order, its top highlight text is compared against the top highlight texts of already-accepted results using a token overlap coefficient; candidates above a similarity threshold (default 0.8) are skipped — with `continue`, not `break` — so genuinely different lower-scored memory fills the freed slot. The check runs before the chatter-quota increment so a diversity-skipped chatter item never consumes quota.

## 2. Problem

The selection loop is `selectRanked` at `lib/ranking.ts:128-146`:

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

Three gates exist — threshold, chatter quota, `maxResults` — and none of them looks at *content*. Two (or five) near-identical results on the same theme each individually pass all three gates:

- They score high, so the threshold doesn't cut them.
- They classify as `curated` via `classifyResult` (`lib/ranking.ts:75-88`) — real title, non-UUID resource id — so the chatter quota never applies. This is the key difference from the chatter-flood failure that `chatterQuota` was built for: none of these results individually looks like noise.
- `maxResults` just counts them; it doesn't care that slots 1–4 say the same thing.

Downstream, `formatSelected` in `hooks/auto-context.ts:75-96` formats whatever `selectRanked` returned (up to 2 highlights per result) into the injected context block. The dedup must happen in `selectRanked`, not `formatSelected`: skipping a duplicate during selection frees the slot for the next-ranked *different* result, whereas deduping at format time would just shrink the block and waste the slot.

Concrete failure mode observed in the wild: a memory that exists both as a synced Drive doc section and as a `hyperspell remember` note (or a hot-buffer row later curated into a titled memory) surfaces twice, and the second copy displaces the one genuinely different memory that would have made the injection useful.

## 3. Proposed design

### 3.1 What text to compare

Each result's **dedup key**: the text of its highest-scored highlight (`Highlight.text` from `client.ts`), falling back to `title ?? ""` when `highlights` is empty. This is exactly the text `formatSelected` would lead with, so "near-duplicate keys" ≈ "near-duplicate injected content". Comparing full concatenated highlights is possible but adds cost for little gain — the top highlight is what both copies of a duplicated memory match the query with.

```ts
export function dedupKey(r: SearchResult): string {
	let best = "";
	let bestScore = -1;
	for (const h of r.highlights) {
		const s = h.score ?? 0;
		if (s > bestScore) {
			bestScore = s;
			best = h.text;
		}
	}
	return best !== "" ? best : (r.title ?? "");
}
```

### 3.2 Similarity measure: token **overlap coefficient**

No embedding vectors exist client-side — only strings — and the repo has no NLP/similarity dependency (`@sinclair/typebox`, `hyperspell`, `@clack/prompts` only) and shouldn't grow one for this. The check also runs synchronously in the hot ranking path on every auto-context injection, over at most `maxResults × candidates` pairs (in practice ≤ ~10 × ~30 short strings). That rules anything fancy out and makes simple token-set math the right tool.

Candidates considered:

- **Normalized string equality** — too brittle: a re-saved memory usually differs by a date prefix, a trailing sentence, or whitespace.
- **Substring containment** — catches snippet-of-larger-doc cases but misses "same text, one word edited", and is asymmetric/ad-hoc.
- **Jaccard on token sets** (`|A∩B| / |A∪B|`) — good general measure, but it punishes length asymmetry: a 10-token highlight fully contained in a 40-token highlight scores Jaccard 0.25 despite being an obvious duplicate. Duplicated memories in this system frequently differ mainly by length (a note vs. the doc it quotes), so this is a real miss.
- **Overlap coefficient on token sets** (`|A∩B| / min(|A|, |B|)`) — **recommended.** Same O(|A|+|B|) cost as Jaccard, dependency-free, and it treats containment as high similarity: the 10-in-40 case above scores 1.0. That matches the actual failure mode (same content at different granularities).

Tokenization: lowercase, strip everything but letters/digits, split on whitespace, drop empty tokens, build a `Set`. Deliberately no stemming/stopwords — not worth the code for near-*duplicate* detection, where the shared text is literal.

```ts
function tokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter((t) => t.length > 0),
	);
}

export function nearDuplicate(a: string, b: string, threshold: number): boolean {
	if (threshold <= 0) return false;
	const ta = tokens(a);
	const tb = tokens(b);
	const min = Math.min(ta.size, tb.size);
	if (min === 0) return false;
	// Tiny keys (short titles, 2-3 common words) make overlap-coefficient
	// trigger-happy; require exact token-set equality below 5 tokens.
	if (min < 5) {
		if (ta.size !== tb.size) return false;
		for (const t of ta) if (!tb.has(t)) return false;
		return true;
	}
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / min >= threshold;
}
```

The `min < 5` guard is the mitigation for the overlap coefficient's one weakness (a 3-token key like "the writing notes" would otherwise "duplicate" any longer text containing those words).

### 3.3 Near-duplicate threshold: **0.8**

Chosen so that:

- **≥ 0.8 catches** the target cases: identical text, identical-plus-a-date-prefix, one-sentence edits, and full containment (containment scores 1.0 under overlap coefficient regardless of length difference).
- **< 0.8 spares** thematically related but distinct memories. Two different journal entries about the same project share vocabulary (names, project terms) but rarely share 80 % of one side's token *set* — token sets, not sequences, means shared topic words alone can't reach 0.8 unless the shorter text is mostly made of them, which the ≥5-token minimum plus real sentence structure makes unlikely.

This is a judgment call, not a measurement; §6 makes it configurable so it can be tuned from debug logs without a release.

### 3.4 Modified `selectRanked`

Additive optional parameter — every existing call site and test keeps working unchanged, and `0` disables the check entirely:

```ts
export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
	dedupThreshold = 0,
): RankedResult[] {
	const out: RankedResult[] = [];
	const keys: string[] = [];
	let chatter = 0;
	for (const r of ranked) {
		if (r._composite < threshold) continue;
		const key = dedupKey(r);
		if (keys.some((k) => nearDuplicate(k, key, dedupThreshold))) continue;
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) continue;
			chatter++;
		}
		out.push(r);
		keys.push(key);
		if (out.length >= maxResults) break;
	}
	return out;
}
```

Load-bearing ordering decisions:

1. **`continue`, not `break`, on a duplicate.** Iteration proceeds to the next-ranked candidate, so a genuinely different lower-scored result fills the freed slot. This is the whole point — the filter must *replace* duplicates with different content, not merely shrink the output.
2. **Diversity check runs BEFORE the chatter-quota increment.** A chatter item skipped for diversity injects nothing, so it must not consume quota. If the order were quota-first, a duplicate chatter echo would burn a quota slot and then get diversity-skipped — silently blocking a later *distinct* chatter item. That's the double-count bug called out in the issue; the ordering above makes it structurally impossible. Symmetrically, an over-quota chatter item is skipped *after* the dedup check but its key is **not** recorded (only accepted results push to `keys`), so a quota-rejected echo can't shadow a later curated result that happens to share its text — dedup compares only against content that will actually be injected.
3. **`keys` mirrors `out`** (push in lockstep). Dedup state is exactly "what was accepted", nothing more. `keys` is a parallel array rather than recomputing `dedupKey(out[i])` per comparison — keys are computed once per candidate.

Cost: worst case `candidates × accepted` calls to `nearDuplicate`, each linear in the two token counts. With defaults (`maxResults` ~5–10, `candidateMultiplier: 3`) that's a few hundred set operations on short strings per injection — negligible next to the network search that precedes it.

### 3.5 Config plumbing and the quota interaction summary

- `RankingWeights` (`lib/ranking.ts:19-34`): add `/** Token-overlap ratio above which a candidate is skipped as a near-duplicate of an already-selected result. 0 disables. */ dedupThreshold: number`.
- `DEFAULT_RANKING` (`lib/ranking.ts:36-44`): `dedupThreshold: 0.8`.
- `parseRanking` in `config.ts:230-247`: `dedupThreshold: Math.min(1, Math.max(0, num(r.dedupThreshold, DEFAULT_RANKING.dedupThreshold)))`.
- Call site `hooks/auto-context.ts:202-207`: pass `ranking.dedupThreshold` as the fifth argument. Extend the existing debug line at `hooks/auto-context.ts:215` to include a dedup-skip count (thread a counter out or recompute the tally) so threshold tuning has data.
- `openclaw.plugin.json`: add the field to the ranking config schema alongside `chatterQuota`.

Quota interaction, stated once as the invariant to test: **only accepted results consume chatter quota, and only accepted results participate in future dedup comparisons.** Skipped-for-any-reason candidates leave both counters/sets untouched.

All new functions stay pure and side-effect-free, per `lib/ranking.ts` convention.

## 4. Test plan

New tests in `lib/ranking.test.ts`, matching existing fixture style (`mk`, and the `ranked(kind, composite, id)` helper at `lib/ranking.test.ts:86-91` — extended to accept highlight text). Run with `node --test --experimental-strip-types lib/ranking.test.ts`.

```ts
const rankedH = (
	kind: RankedResult["_kind"],
	composite: number,
	id: string,
	text: string,
): RankedResult => ({
	...mk({ resourceId: id, title: `note ${id}`, highlights: [{ id: "h", text, score: composite }] }),
	_kind: kind,
	_base: composite,
	_composite: composite,
});

const THEME =
	"Heath finally confronts Junii about the Omuerta binding and what it cost Tevre on the night of storms";

test("selectRanked — five near-identical curated hits: today they flood, dedup caps them", () => {
	const five = [
		rankedH("curated", 0.9, "d1", THEME),
		rankedH("curated", 0.88, "d2", `2026-02-09 — ${THEME}`),
		rankedH("curated", 0.86, "d3", `${THEME}. She kept the letter.`),
		rankedH("curated", 0.84, "d4", THEME.replace("finally", "at last")),
		rankedH("curated", 0.82, "d5", THEME),
	];
	// Baseline: current behavior (dedup disabled) selects all up to maxResults.
	assert.equal(selectRanked(five, 4, 0.6, 2).length, 4, "status quo floods the slots");
	// Diversity filter collapses the theme to one entry.
	const sel = selectRanked(five, 4, 0.6, 2, 0.8);
	assert.equal(sel.length, 1);
	assert.equal(sel[0].resourceId, "d1", "highest-ranked copy wins");
});

test("selectRanked — freed slot goes to genuinely different lower-scored content", () => {
	const list = [
		rankedH("curated", 0.9, "d1", THEME),
		rankedH("curated", 0.88, "d2", `2026-02-09 — ${THEME}`),
		rankedH("curated", 0.86, "d3", `${THEME}. She kept the letter.`),
		rankedH("curated", 0.7, "k1", "Grocery run Thursday; Alinea prefers oat milk and dark rye"),
	];
	const sel = selectRanked(list, 2, 0.6, 2, 0.8);
	assert.deepEqual(
		sel.map((r) => r.resourceId),
		["d1", "k1"],
		"duplicates are skipped with continue, not break — k1 fills the freed slot",
	);
});

test("selectRanked — a diversity-skipped chatter item does not consume chatter quota", () => {
	const list = [
		rankedH("chatter", 0.9, "c1", THEME),
		rankedH("chatter", 0.88, "c2", `${THEME}.`), // near-dup of c1 → diversity-skipped
		rankedH("chatter", 0.86, "c3", "we argued about whether the sandbox should allow git push"),
		rankedH("curated", 0.7, "k1", "Grocery run Thursday; Alinea prefers oat milk and dark rye"),
	];
	const sel = selectRanked(list, 10, 0.6, 2, 0.8);
	// If the quota were charged before the dedup skip, c2 would burn slot 2 and c3 would be blocked.
	assert.deepEqual(sel.map((r) => r.resourceId), ["c1", "c3", "k1"]);
	assert.equal(sel.filter((r) => r._kind === "chatter").length, 2);
});

test("selectRanked — over-quota chatter does not shadow later results in the dedup set", () => {
	const list = [
		rankedH("chatter", 0.9, "c1", "morning chatter about coffee"),
		rankedH("chatter", 0.88, "c2", "afternoon chatter about trains"),
		rankedH("chatter", 0.86, "c3", THEME), // over quota (quota=2) → skipped, key NOT recorded
		rankedH("curated", 0.8, "k1", THEME), // must still be accepted
	];
	const sel = selectRanked(list, 10, 0.6, 2, 0.8);
	assert.deepEqual(sel.map((r) => r.resourceId), ["c1", "c2", "k1"]);
});

test("nearDuplicate — containment counts, tiny keys require equality, 0 disables", () => {
	assert.ok(nearDuplicate(THEME, `${THEME} and more happened after, much more, that evening`, 0.8));
	assert.ok(!nearDuplicate("the writing notes", THEME, 0.8), "short key needs exact match");
	assert.ok(!nearDuplicate(THEME, THEME, 0), "threshold 0 disables");
});
```

Also verify (no code change needed, just assert): existing `selectRanked` tests at `lib/ranking.test.ts:93-113` pass untouched, proving the default-off parameter is backward compatible.

## 5. Risks / tradeoffs

- **False-positive dedup** (distinct memories skipped): two genuinely different memories that quote the same passage — e.g. two journal entries both citing one line of the manuscript — can exceed 0.8 overlap on their *top highlight* even though the underlying documents differ. Cost: one real memory silently dropped from injection. Mitigations: the ≥5-token guard, the high threshold, comparing only against *accepted* items (at most `maxResults` comparisons), and the debug-log skip count making over-firing visible. Residual risk is acceptable because the skipped item is by construction the lower-ranked of the pair and its information content largely survives via the accepted twin.
- **False-negative dedup** (duplicates that slip through): paraphrased duplicates — same fact re-saved in different words, or summarized vs. verbatim — share little literal token overlap and won't be caught by any cheap string measure. This is a known ceiling of the approach: without client-side embeddings, semantic dedup isn't reachable, and shipping literal/containment dedup still removes the most common duplicate class (re-saves and re-syncs are near-verbatim). If paraphrase duplicates prove common in practice, that's a future server-side concern (dedup at write time in Hyperspell), not a reason to add an NLP dependency here.
- **Top-highlight-only comparison**: two results could be duplicates on their *second* highlight while their top highlights differ. `formatSelected` injects up to 2 highlights, so some duplicated text can still co-occur. Accepted for v1 — comparing all-pairs of highlights quadruples the cost for a rarer case; revisit only with evidence.
- **Ordering bias**: the highest-composite copy always wins the dedup contest. That's the right bias (it's the copy the ranker trusts most), but it means the *kind* of the surviving copy is score-determined — a chatter echo can outlive a curated twin if it outscores it post-penalty. Fine: the chatter quota still bounds echoes, and the information is identical by definition of the check.

## 6. Rollout

Make the threshold configurable as `ranking.dedupThreshold` (see §3.5), consistent with how `chatterQuota` and the boost weights are already exposed. **Default: `0.8`, enabled out of the box** — near-verbatim duplication is unambiguous enough that shipping it dark would just delay the benefit; `0` is the escape hatch (disables the check entirely and reproduces today's behavior exactly, which is also what keeps every existing caller/test green). Tuning path: watch the dedup-skip count in the extended `auto-context` debug line for a few days on a live install; if legitimate distinct memories are being skipped, raise toward 0.9; if obvious duplicates survive, consider lowering to 0.7 before considering measure changes.

## 7. Effort estimate

**S** — two small pure functions plus a five-line change to an existing pure function, one optional config field, one call-site argument, and tests; no I/O, no API surface, no migration.
