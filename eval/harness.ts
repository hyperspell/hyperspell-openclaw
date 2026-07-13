import type { SearchResult } from "../client.ts";
import {
	type RankedResult,
	type RankingWeights,
	rerank,
	selectRanked,
} from "../lib/ranking.ts";

/**
 * The Ruler — deterministic eval cases for the composite retrieval ranking
 * (proposal 17, docs/proposals/17-retrieval-eval-harness.md).
 *
 * Each case pushes a synthetic candidate pool through the REAL production
 * pipeline (`rerank` + `selectRanked` from lib/ranking.ts — imported, never
 * reimplemented, so the harness cannot drift from the code under test) and
 * checks membership/ordering of the SELECTED set — i.e. what auto-context
 * would actually inject.
 *
 * NOTE: mirrors the ranking-enabled single-user path of hooks/auto-context.ts
 * (rerank → selectRanked). Backend search, dropCurrentSession, and the exclude
 * filter happen upstream of the pool and are out of scope here; the live-API
 * runner (scripts/eval-retrieval.ts) covers that end of the pipeline.
 */
/** The harness's fixed clock — equal to the fixtures' FIXED_CREATED_AT, so
 * age-0 results accrue zero recency penalty and every pre-recency case's
 * composite stays byte-identical to the pre-recency pipeline. Recency cases
 * date their fixtures relative to this instant. Never Date.now(): output must
 * be byte-stable across runs and days. */
export const EVAL_NOW = Date.parse("2026-06-01T12:00:00Z");

export type EvalCase = {
	name: string;
	/** Which ranking behavior this case pins, and why it matters. */
	note: string;
	pool: SearchResult[];
	weights: RankingWeights;
	maxResults: number;
	threshold: number;
	expect: {
		/** resourceIds that MUST appear in the selected set. */
		mustSelect?: string[];
		/** resourceIds that MUST NOT appear in the selected set. */
		mustNotSelect?: string[];
		/** [earlier, later] pairs — both must be selected, in this relative order. */
		order?: Array<[string, string]>;
	};
};

export type CaseResult = {
	name: string;
	ranked: RankedResult[];
	selected: RankedResult[];
	failures: string[];
};

/** One-line human description of a ranked result, used in diffs and tables. */
export function describeResult(r: RankedResult): string {
	return `${r.resourceId} (${r._kind}, base ${fmtScore(r._base)} -> composite ${fmtScore(r._composite)})`;
}

function fmtScore(n: number): string {
	// Fixed 4 decimals: readable, deterministic, and fine enough to expose any
	// weight change (weights move in 0.05 steps, float noise is ~1e-16).
	return n.toFixed(4);
}

function selectionDiff(c: EvalCase, selected: RankedResult[]): string {
	const lines = [
		`  selected (${selected.length}/${c.maxResults} max, threshold ${c.threshold}):`,
		...selected.map((r, i) => `    ${i + 1}. ${describeResult(r)}`),
	];
	if (selected.length === 0) lines.push("    (nothing selected)");
	return lines.join("\n");
}

/** Run one eval case through the production pipeline and check expectations. */
export function runCase(c: EvalCase): CaseResult {
	const ranked = rerank(c.pool, c.weights, EVAL_NOW);
	// NOTE: baselined against main's selectRanked(ranked, max, threshold, quota).
	// When the explainSelection refactor of selectRanked lands (proposal/02),
	// this call site (and scripts/eval-retrieval.ts) needs a trivial API sync.
	const selected = selectRanked(
		ranked,
		c.maxResults,
		c.threshold,
		c.weights.chatterQuota,
	);
	const ids = selected.map((r) => r.resourceId);

	const failures: string[] = [];
	for (const id of c.expect.mustSelect ?? []) {
		if (!ids.includes(id)) failures.push(`expected "${id}" in selected set`);
	}
	for (const id of c.expect.mustNotSelect ?? []) {
		if (ids.includes(id)) failures.push(`expected "${id}" NOT in selected set`);
	}
	for (const [earlier, later] of c.expect.order ?? []) {
		const a = ids.indexOf(earlier);
		const b = ids.indexOf(later);
		if (a === -1 || b === -1) {
			failures.push(
				`order [${earlier} < ${later}]: both must be selected (got ${a === -1 ? `"${earlier}" missing` : `"${later}" missing`})`,
			);
		} else if (a >= b) {
			failures.push(
				`order [${earlier} < ${later}]: "${earlier}" ranked #${a + 1}, "${later}" ranked #${b + 1}`,
			);
		}
	}
	if (failures.length > 0) failures.push(selectionDiff(c, selected));

	return { name: c.name, ranked, selected, failures };
}
