import type { SearchResult } from "../client.ts";

/**
 * Composite retrieval ranking — score memories by more than raw semantic
 * relevance, so deliberately-KEPT memory (journals, notes, the active story)
 * surfaces above the flood of auto-saved conversation fragments.
 *
 * Why: relevance alone is cosine *similarity*, and similarity rewards
 * FREQUENCY — a moment re-saved a hundred times looks "most similar" to
 * everything and crowds out quieter, truer memory. Left unchecked the agent
 * grounds itself in evocative conversation echoes instead of what's real, and
 * drifts (the "useless dreamer" failure). The composite adds signal:
 *
 *   composite = relevance
 *             + curationBoost   (it's something she chose to keep)
 *             + storyBoost      (it's the active story/manuscript)
 *             − chatterPenalty  (it's an auto-saved conversation fragment)
 */
export type RankingWeights = {
	enabled: boolean;
	curationBoost: number;
	chatterPenalty: number;
	storyBoost: number;
	/** Lowercased substrings that mark a result as the active story (boosted). */
	storyTerms: string[];
	/** Fetch this many × maxResults as candidates, so true-but-quiet memory is
	 * in the pool to be re-ranked rather than cut off below the fetch limit. */
	candidateMultiplier: number;
	/** Hard cap on how many CHATTER (auto-saved conversation echo) results may be
	 * injected, regardless of score. A high-similarity echo can clear any penalty;
	 * the quota guarantees it can inform but never flood, keeping slots for real
	 * memory. Penalty alone can't bound the count. */
	chatterQuota: number;
};

export const DEFAULT_RANKING: RankingWeights = {
	enabled: true,
	curationBoost: 0.2,
	chatterPenalty: 0.2,
	storyBoost: 0.15,
	storyTerms: [],
	candidateMultiplier: 3,
	chatterQuota: 2,
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResultKind = "story" | "curated" | "chatter" | "other";

export type RankedResult = SearchResult & {
	_kind: ResultKind;
	_base: number;
	_composite: number;
};

/** Highest available relevance for a result (doc score or its best highlight). */
export function baseScore(r: SearchResult): number {
	const topHighlight = r.highlights.reduce(
		(m, h) => Math.max(m, h.score ?? 0),
		0,
	);
	return Math.max(r.score ?? 0, topHighlight);
}

/**
 * Classify a result by what KIND of memory it is — using only fields the search
 * already returns (title shape + resource id), so no extra round-trip:
 *  - story:   matches a configured story term (manuscript / its notes & threads)
 *  - chatter: untitled or "Unnamed Conversation" AND keyed by a bare session
 *             UUID — i.e. a hot-buffer conversation fragment (the dreamy echoes)
 *  - curated: has a real, human title and is not a raw session row — a journal,
 *             a writing note, a synced memory section (deliberately kept)
 */
export function classifyResult(
	r: SearchResult,
	storyTerms: string[],
): ResultKind {
	const title = (r.title ?? "").trim();
	if (storyTerms.length > 0) {
		const hay = `${title} ${r.highlights.map((h) => h.text).join(" ")}`.toLowerCase();
		if (storyTerms.some((t) => t && hay.includes(t.toLowerCase()))) return "story";
	}
	const untitled = title === "" || /^unnamed conversation$/i.test(title);
	if (untitled && UUID_RE.test(r.resourceId)) return "chatter";
	if (title !== "" && !UUID_RE.test(r.resourceId)) return "curated";
	return "other";
}

/** Composite score + classification for one result. */
export function scoreResult(
	r: SearchResult,
	w: RankingWeights,
): { kind: ResultKind; base: number; composite: number } {
	const kind = classifyResult(r, w.storyTerms);
	const base = baseScore(r);
	let composite = base;
	if (kind === "story")
		composite += w.storyBoost + w.curationBoost; // the story is kept memory too
	else if (kind === "curated") composite += w.curationBoost;
	else if (kind === "chatter") composite -= w.chatterPenalty;
	return { kind, base, composite };
}

/** Re-rank results by composite score (descending). Pure; stable enough. */
export function rerank(
	results: SearchResult[],
	w: RankingWeights,
): RankedResult[] {
	return results
		.map((r) => {
			const s = scoreResult(r, w);
			return Object.assign({}, r, {
				_kind: s.kind,
				_base: s.base,
				_composite: s.composite,
			}) as RankedResult;
		})
		.sort((a, b) => b._composite - a._composite);
}

/** Why a candidate was cut from injection. Closed set — the tuning analysis
 * (proposal 02) and the chatter-quota instrumentation (proposal 03) both key
 * off it. */
export type SelectionCut = "threshold" | "max-results" | "chatter-quota";

/** Selected entries carry `cut: null`; cut entries carry the binding reason.
 * Discriminated on `selected` so a cut entry can never lack a reason. */
export type SelectionExplained =
	| { result: RankedResult; selected: true; cut: null }
	| { result: RankedResult; selected: false; cut: SelectionCut };

/**
 * One pass over ranked results, annotating each with its selection outcome.
 * Same policy as selectRanked — which is now derived from this, so the two
 * can never drift (proposal 02 §3a).
 *
 * Attribution order is deliberate: the threshold check comes first so a
 * below-the-bar result is always attributed to "threshold" even when the
 * max-results cap is already full; and a chatter item past the cap reads
 * "max-results", not "chatter-quota" — it would have been cut regardless, so
 * the quota was not the binding constraint (proposal 03 §3.2 semantics).
 */
export function explainSelection(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): SelectionExplained[] {
	const out: SelectionExplained[] = [];
	let chatter = 0;
	let kept = 0;
	for (const r of ranked) {
		if (r._composite < threshold) {
			out.push({ result: r, selected: false, cut: "threshold" });
			continue;
		}
		if (kept >= maxResults) {
			out.push({ result: r, selected: false, cut: "max-results" });
			continue;
		}
		if (r._kind === "chatter" && chatter >= chatterQuota) {
			out.push({ result: r, selected: false, cut: "chatter-quota" });
			continue;
		}
		if (r._kind === "chatter") chatter++;
		kept++;
		out.push({ result: r, selected: true, cut: null });
	}
	return out;
}

/**
 * Choose which ranked results to inject: keep those clearing `threshold` on
 * their composite, cap CHATTER at `chatterQuota` regardless of score (so a
 * high-similarity echo can inform but never flood — the penalty bounds rank,
 * the quota bounds count), and stop at `maxResults`.
 *
 * Signature and return shape are intentionally unchanged: the retrieval eval
 * harness (proposal 17) and existing call sites depend on
 * `selectRanked(ranked, maxResults, threshold, chatterQuota): RankedResult[]`.
 * It is a thin projection of explainSelection so selection policy lives in
 * exactly one place.
 */
export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): RankedResult[] {
	return explainSelection(ranked, maxResults, threshold, chatterQuota)
		.filter((e) => e.selected)
		.map((e) => e.result);
}
