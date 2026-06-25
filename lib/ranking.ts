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
};

export const DEFAULT_RANKING: RankingWeights = {
	enabled: true,
	curationBoost: 0.2,
	chatterPenalty: 0.2,
	storyBoost: 0.15,
	storyTerms: [],
	candidateMultiplier: 3,
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
