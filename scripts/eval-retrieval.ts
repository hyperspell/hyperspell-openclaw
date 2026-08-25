/**
 * Live retrieval eval harness (docs/proposals/17-retrieval-eval-harness.md).
 *
 *   node --experimental-strip-types scripts/eval-retrieval.ts
 *   EVAL_LABEL=before-idea-7 npm run eval:retrieval
 *
 * Pushes every fixture in docs/eval/retrieval-fixtures.jsonl through the REAL
 * pipeline — HyperspellClient.search + rerank + selectRanked with the live
 * install's config — and reports whether the expected memory made the
 * SELECTED set (i.e. would actually have been injected). Appends one line per
 * run to docs/eval/retrieval-results.jsonl (gitignored) and diffs against the
 * previous run.
 *
 * Hits the live Hyperspell API with real credentials: run manually around
 * ranking changes, never from `npm test` or CI. Reads only — never writes
 * memories. The hermetic counterpart (synthetic pools, no network) lives in
 * eval/ and IS part of `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { HyperspellClient, type SearchResult } from "../client.ts";
import { parseConfig, type HyperspellConfig } from "../config.ts";
import { matchFixture, parseFixtures } from "../lib/eval-matchers.ts";
import { excludeFilterFor } from "../lib/filters.ts";
import { rerank, selectRanked } from "../lib/ranking.ts";

const EVAL_DIR = path.join(import.meta.dirname, "../docs/eval");
const FIXTURES = path.join(EVAL_DIR, "retrieval-fixtures.jsonl");
const RESULTS = path.join(EVAL_DIR, "retrieval-results.jsonl");

/** Live install's plugin config by default; env overrides for portability. */
function loadConfig(): HyperspellConfig {
	let raw: Record<string, unknown> = {};
	const live = path.join(process.env.HOME ?? "", ".openclaw/openclaw.json");
	if (fs.existsSync(live)) {
		raw =
			JSON.parse(fs.readFileSync(live, "utf8")).plugins?.entries?.[
				"openclaw-hyperspell"
			]?.config ?? {};
	}
	if (process.env.HYPERSPELL_API_KEY) raw.apiKey = process.env.HYPERSPELL_API_KEY;
	if (process.env.HYPERSPELL_USER_ID) raw.userId = process.env.HYPERSPELL_USER_ID;
	return parseConfig(raw); // same defaults the plugin itself would get
}

type FixtureRun = { query: string; pass: boolean; via?: string; rank?: number };

async function main() {
	const cfg = loadConfig();
	const client = new HyperspellClient(cfg);
	const fixtures = parseFixtures(fs.readFileSync(FIXTURES, "utf8"));
	const run: FixtureRun[] = [];

	for (const f of fixtures) {
		if (f.skip) {
			console.log(`SKIP  ${f.query}`);
			continue;
		}
		// Mirror the hooks/auto-context.ts single-user path step for step, so a
		// PASS means "this memory would have been injected". One deliberate
		// divergence: dropCurrentSession is omitted — the harness has no current
		// session to exclude.
		const limit = cfg.ranking.enabled
			? cfg.maxResults * cfg.ranking.candidateMultiplier
			: cfg.maxResults;
		const results = await client.search(f.query, {
			limit,
			filter: excludeFilterFor(cfg),
		});
		const selected: SearchResult[] = cfg.ranking.enabled
			? selectRanked(
					rerank(results, cfg.ranking),
					cfg.maxResults,
					cfg.relevanceThreshold,
					cfg.ranking.chatterQuota,
					cfg.ranking.dedupThreshold,
					cfg.ranking.elbow,
					cfg.ranking.perFileCap,
				)
			: // Membership rule of formatHighlightBullets (ranking off): top
				// maxResults, doc score AND at least one highlight over threshold.
				results
					.slice(0, cfg.maxResults)
					.filter(
						(r) =>
							(r.score ?? 0) >= cfg.relevanceThreshold &&
							r.highlights.some((h) => h.score >= cfg.relevanceThreshold),
					);

		let hit: { via: string; rank: number } | null = null;
		for (const [i, r] of selected.entries()) {
			const via = matchFixture(r, f);
			if (via) {
				hit = { via, rank: i + 1 };
				break;
			}
		}
		if (hit) {
			console.log(`PASS  ${f.query}  (rank ${hit.rank}, via ${hit.via})`);
			if (f.expectedResourceId && hit.via === "title") {
				console.log(
					"  WARN: matched by title but not resourceId — id may have churned",
				);
			}
		} else {
			console.log(`FAIL  ${f.query}`);
			// The key diagnostic: retrieved-but-ranked-out is a ranking/config
			// problem (most of #66); not-in-pool is a search/indexing problem.
			const inPool = results.find((r) => matchFixture(r, f));
			console.log(
				inPool
					? `  (in candidate pool as "${inPool.title}" score=${inPool.score} — cut by rerank/threshold/quota)`
					: `  (not in top ${limit} from backend at all — a search problem, not a ranking problem)`,
			);
		}
		run.push({ query: f.query, pass: !!hit, via: hit?.via, rank: hit?.rank });
	}

	const passed = run.filter((r) => r.pass).length;
	console.log(`\n${passed}/${run.length} passed`);

	// Regression diff vs the previous run, then append this run. Per-fixture,
	// not aggregate: a pass->fail flip must be explained even if the score holds.
	const prev = fs.existsSync(RESULTS)
		? fs
				.readFileSync(RESULTS, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as { fixtures: FixtureRun[] })
				.at(-1)
		: null;
	if (prev) {
		for (const r of run) {
			const p = prev.fixtures.find((x) => x.query === r.query);
			if (p && p.pass && !r.pass)
				console.log(`REGRESSION: "${r.query}" flipped pass -> fail`);
			if (p && !p.pass && r.pass)
				console.log(`fixed: "${r.query}" flipped fail -> pass`);
		}
	}
	fs.appendFileSync(
		RESULTS,
		`${JSON.stringify({
			at: new Date().toISOString(),
			label: process.env.EVAL_LABEL ?? null, // e.g. "before-idea-7"
			score: `${passed}/${run.length}`,
			config: {
				relevanceThreshold: cfg.relevanceThreshold,
				ranking: cfg.ranking,
				maxResults: cfg.maxResults,
			},
			fixtures: run,
		})}\n`,
	);
	process.exitCode = passed === run.length ? 0 : 1;
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
