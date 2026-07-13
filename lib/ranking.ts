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
	/** Lowercased terms that mark a result as the active story (boosted).
	 * Matched case-insensitively at word boundaries — "mira" matches "Mira's"
	 * but not "admiral" (parseRanking normalizes: trim/lowercase/dedupe). */
	storyTerms: string[];
	/** Fetch this many × maxResults as candidates, so true-but-quiet memory is
	 * in the pool to be re-ranked rather than cut off below the fetch limit. */
	candidateMultiplier: number;
	/** Hard cap on how many CHATTER (auto-saved conversation echo) results may be
	 * injected, regardless of score. A high-similarity echo can clear any penalty;
	 * the quota guarantees it can inform but never flood, keeping slots for real
	 * memory. Penalty alone can't bound the count. */
	chatterQuota: number;
	/** Half-life in days for the recency penalty — a result this old has accrued
	 * half of recencyMaxPenalty. 0 disables the recency term entirely. */
	recencyHalfLifeDays: number;
	/** Ceiling on the recency penalty — the most an arbitrarily old result can
	 * lose. Keeps recency a tiebreaker, never a dominant signal. */
	recencyMaxPenalty: number;
	/** Fraction of the penalty applied to curated/story results (0..1). Kept
	 * memory describes durable truths; it ages slower than chatter. */
	recencyCuratedFactor: number;
	/** Per-source multiplier on BASE relevance (applied before the kind-based
	 * boost/penalty). Keyed by Hyperspell source name; any source not listed —
	 * including sources that don't exist yet — is neutral (1.0). */
	sourceWeights: Record<string, number>;
	/** Token-overlap ratio above which a candidate is skipped as a near-
	 * duplicate of an already-SELECTED result (its slot passes to different
	 * content). 0 disables the check. */
	dedupThreshold: number;
};

export const DEFAULT_RANKING: RankingWeights = {
	enabled: true,
	curationBoost: 0.2,
	chatterPenalty: 0.2,
	storyBoost: 0.15,
	storyTerms: [],
	candidateMultiplier: 3,
	chatterQuota: 2,
	recencyHalfLifeDays: 90,
	recencyMaxPenalty: 0.1,
	recencyCuratedFactor: 0.5,
	sourceWeights: {},
	dedupThreshold: 0.8,
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compiled story-term matchers, cached per storyTerms array instance — the
// config array is built once in parseConfig and stable for the process
// lifetime, so this avoids per-result regex compilation on the hot path.
const matcherCache = new WeakMap<string[], RegExp[]>();

/**
 * One regex per term, anchored at word boundaries so short terms can't
 * false-positive inside longer words ("ada" no longer matches "adaptation";
 * "mira" no longer matches "admiral"). Boundaries are word↔non-word
 * transitions, so possessives and punctuation still match: "mira" hits
 * "Mira's" and "mira-class". `\b` only anchors against word characters, so
 * terms whose edges are punctuation get no anchor there and still match.
 */
function storyMatchers(storyTerms: string[]): RegExp[] {
	let ms = matcherCache.get(storyTerms);
	if (!ms) {
		ms = storyTerms
			.map((t) => t.trim().toLowerCase())
			.filter((t) => t.length > 0)
			.map((term) => {
				const lead = /^\w/.test(term) ? "\\b" : "";
				const tail = /\w$/.test(term) ? "\\b" : "";
				return new RegExp(`${lead}${escapeRe(term)}${tail}`);
			});
		matcherCache.set(storyTerms, ms);
	}
	return ms;
}

/** Count ranked results by kind — the debug-tally shape auto-context logs. */
export function kindTally(results: RankedResult[]): Record<string, number> {
	return results.reduce(
		(acc, r) => ((acc[r._kind] = (acc[r._kind] ?? 0) + 1), acc),
		{} as Record<string, number>,
	);
}

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
		// \n-joined (not space-joined) so a multi-word phrase term can never
		// spuriously match across the seam of two unrelated highlights (terms are
		// escaped literals, so a phrase's inner space cannot match the \n).
		const hay = `${title}\n${r.highlights.map((h) => h.text).join("\n")}`.toLowerCase();
		if (storyMatchers(storyTerms).some((re) => re.test(hay))) return "story";
	}
	const untitled = title === "" || /^unnamed conversation$/i.test(title);
	if (untitled && UUID_RE.test(r.resourceId)) return "chatter";
	if (title !== "" && !UUID_RE.test(r.resourceId)) return "curated";
	return "other";
}

/**
 * Age-based additive penalty: exponential decay with a configurable half-life,
 * capped at recencyMaxPenalty so recency stays a tiebreaker with teeth, never
 * a dominant signal — an infinitely old result loses at most the cap, so it
 * can reorder near-ties but never bury a result that out-relevances a rival
 * by more than the cap. Additive (not a relevance multiplier) to stay on the
 * same tuned scale as the boost/penalty algebra above.
 */
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
	// max(0, …) clamps future timestamps (clock skew) to zero age, never a boost.
	const ageDays = Math.max(0, (now - ts) / 86_400_000);
	const decay = 0.5 ** (ageDays / w.recencyHalfLifeDays);
	// Kept memory (curated/story) is deliberately durable — it ages at the
	// reduced curated factor so old truths keep their edge over old chatter.
	const kept = kind === "curated" || kind === "story";
	const factor = kept ? w.recencyCuratedFactor : 1;
	return w.recencyMaxPenalty * (1 - decay) * factor;
}

/** Weight for a source; anything unlisted or malformed is neutral, never zero.
 * The lookup-time guard is the safety floor: an unrecognized or unweighted
 * source degrades to 1.0 — it never crashes and never zeroes a result out. */
export function sourceWeight(w: RankingWeights, source: string): number {
	const v = w.sourceWeights[source];
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}

/** Composite score + classification for one result. `now` is injectable so
 * tests and the eval harness stay deterministic; runtime callers omit it. */
export function scoreResult(
	r: SearchResult,
	w: RankingWeights,
	now: number = Date.now(),
): { kind: ResultKind; base: number; composite: number } {
	const kind = classifyResult(r, w.storyTerms);
	const base = baseScore(r);
	// The weight multiplies BASE only — kind boosts/penalties stay in the same
	// additive currency regardless of source, so tuning sourceWeights can never
	// silently retune chatterPenalty/curationBoost (proposal 11 §3.1). _base
	// stays unweighted for debuggability; the weight shows only in _composite.
	let composite = base * sourceWeight(w, r.source);
	if (kind === "story")
		composite += w.storyBoost + w.curationBoost; // the story is kept memory too
	else if (kind === "curated") composite += w.curationBoost;
	else if (kind === "chatter") composite -= w.chatterPenalty;
	composite -= recencyPenalty(r.createdAt, kind, w, now);
	return { kind, base, composite };
}

/** Re-rank results by composite score (descending). Pure; stable enough.
 * One `now` per call so every candidate scores against a consistent clock. */
export function rerank(
	results: SearchResult[],
	w: RankingWeights,
	now: number = Date.now(),
): RankedResult[] {
	return results
		.map((r) => {
			const s = scoreResult(r, w, now);
			return Object.assign({}, r, {
				_kind: s.kind,
				_base: s.base,
				_composite: s.composite,
			}) as RankedResult;
		})
		.sort((a, b) => b._composite - a._composite);
}

/** The text a result would lead its injection with: its highest-scored
 * highlight, falling back to the title. Near-duplicate KEYS ≈ near-duplicate
 * injected content, which is exactly what the diversity check must catch. */
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

function tokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter((t) => t.length > 0),
	);
}

/**
 * Token-set OVERLAP COEFFICIENT (|A∩B| / min|A|,|B|), not Jaccard: duplicated
 * memories here typically differ mainly by length (a note vs the doc it
 * quotes), and containment must read as duplication — 10 tokens fully inside
 * 40 scores 1.0 here but only 0.25 under Jaccard. Dependency-free and linear;
 * this runs synchronously in the ranking hot path.
 */
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

/** Why a candidate was cut from injection. Closed set — the tuning analysis
 * (proposal 02) and the chatter-quota instrumentation (proposal 03) both key
 * off it. */
export type SelectionCut =
	| "threshold"
	| "max-results"
	| "near-duplicate"
	| "chatter-quota";

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
	dedupThreshold = 0,
): SelectionExplained[] {
	const out: SelectionExplained[] = [];
	// Dedup state is exactly "what was accepted": only SELECTED results record
	// keys (and only they consume quota), so a skipped candidate — whatever cut
	// it — can never shadow later different-kind content sharing its text, and
	// a diversity-skipped chatter echo never burns a quota slot (proposal 09's
	// double-count invariant).
	const keys: string[] = [];
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
		// After max-results (a dup past a full cap was cut regardless — the cap
		// was binding), before chatter-quota (a dup echo injects nothing, so the
		// quota was not the binding constraint and must not be charged).
		const key = dedupKey(r);
		if (keys.some((k) => nearDuplicate(k, key, dedupThreshold))) {
			out.push({ result: r, selected: false, cut: "near-duplicate" });
			continue;
		}
		if (r._kind === "chatter" && chatter >= chatterQuota) {
			out.push({ result: r, selected: false, cut: "chatter-quota" });
			continue;
		}
		if (r._kind === "chatter") chatter++;
		kept++;
		keys.push(key);
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
	dedupThreshold = 0,
): RankedResult[] {
	return explainSelection(ranked, maxResults, threshold, chatterQuota, dedupThreshold)
		.filter((e) => e.selected)
		.map((e) => e.result);
}
