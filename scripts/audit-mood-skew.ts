/**
 * Mood-retrieval skew audit — does emotional-state's mood skew bleed into
 * retrieval? (docs/proposals/10-mood-retrieval-skew-audit.md, idea #10 from
 * #66.) Strictly READ-ONLY: enumerates and searches, never writes or deletes.
 *
 *   node --experimental-strip-types scripts/audit-mood-skew.ts            # all 3 phases + verdict
 *   node --experimental-strip-types scripts/audit-mood-skew.ts --mood     # mood timeline only (review labels first)
 *   node --experimental-strip-types scripts/audit-mood-skew.ts --census   # corpus census by source × week
 *   node --experimental-strip-types scripts/audit-mood-skew.ts --probe    # neutral-query retrieval probe
 *   ... -o json                                                           # machine-readable, one JSON object
 *   ... --user <id> --probe-limit 25 --snapshot-limit 200                 # overrides
 *
 * Phases (proposal 10): (1) mood timeline from GET /emotional-state/recent —
 * each week auto-labeled heavy/light/mixed by a keyword lexicon that the
 * operator MUST manually confirm before trusting the verdict; (2) census of
 * the whole corpus via memories.list bucketed by openclaw_source × ISO week,
 * with explicit created_at-coverage reporting; (3) a fixed panel of 12
 * neutral probe queries measuring which weeks' resources dominate results.
 * The verdict normalizes both signals against hot-buffer message counts
 * (conversation volume) and judges them against the proposal's
 * pre-registered thresholds. Fewer than 3 heavy + 3 light labeled weeks =
 * insufficient data, full stop.
 *
 * Privacy: snapshot summaries are printed ONLY when the operator sets
 * HYPERSPELL_AUDIT_CONTENT=1 (the HYPERSPELL_SCORE_LOG / audit-loops
 * precedent) — the manual label review requires it, so run the --mood phase
 * with it set, then treat the saved output as sensitive.
 *
 * Hits the live Hyperspell API with real credentials: run manually, never
 * from `npm test` or CI, and coordinate with the corpus owner first (it
 * enumerates the whole corpus and runs a dozen searches). The pure helpers
 * live in lib/mood-skew-audit.ts and ARE part of `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { HyperspellClient } from "../client.ts";
import { type HyperspellConfig, parseConfig } from "../config.ts";
import {
	buildCensus,
	buildMoodTimeline,
	buildProbeStats,
	buildVerdict,
	type Census,
	type CensusResource,
	type ClassifiedSnapshot,
	classifySnapshots,
	formatCensus,
	formatMoodTimeline,
	formatProbe,
	formatSnapshotReview,
	formatVerdict,
	PROBE_QUERIES,
	type ProbeHit,
	type ProbeStats,
	parseSkewArgs,
} from "../lib/mood-skew-audit.ts";

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
	if (process.env.HYPERSPELL_API_KEY)
		raw.apiKey = process.env.HYPERSPELL_API_KEY;
	if (process.env.HYPERSPELL_USER_ID)
		raw.userId = process.env.HYPERSPELL_USER_ID;
	return parseConfig(raw); // same defaults the plugin itself would get
}

async function main() {
	const args = parseSkewArgs(process.argv.slice(2));
	const includeContent = process.env.HYPERSPELL_AUDIT_CONTENT === "1";
	const cfg = loadConfig();
	const client = new HyperspellClient(cfg);
	const userId = args.user; // undefined = client's configured user
	const runAll = args.mood && args.census && args.probe;

	// The census pass also powers the probe's resourceId → week join, so it
	// runs whenever the probe does — but its table only prints for --census.
	let census: Census | null = null;
	if (args.census || args.probe) {
		const resources: CensusResource[] = [];
		for await (const m of client.listMemories({ userId })) {
			resources.push({ resourceId: m.resourceId, metadata: m.metadata });
		}
		census = buildCensus(resources);
	}

	// Phase 1 — mood timeline. Preferred path is /emotional-state/recent;
	// on 404 (endpoint not deployed) summaries are unreachable and the mood
	// phase reports that instead of guessing labels from anything else.
	let classified: ClassifiedSnapshot[] | null = null;
	let snapshotNote: string | null = null;
	if (args.mood) {
		const recent = await client.getRecentEmotionalStates(
			cfg.relationshipId,
			args.snapshotLimit,
		);
		if (recent === null) {
			snapshotNote =
				"GET /emotional-state/recent unavailable (404) — no summaries to label; mood timeline skipped";
		} else {
			classified = classifySnapshots(
				recent.map((r) => ({
					resourceId: r.resourceId,
					summary: r.summary,
					extractedAt: r.extractedAt,
				})),
			);
			snapshotNote =
				recent.length >= args.snapshotLimit
					? `fetched ${recent.length} snapshots — hit the requested cap; deepen with --snapshot-limit`
					: `fetched ${recent.length} snapshots`;
		}
	}
	const timeline = classified === null ? null : buildMoodTimeline(classified);

	// Phase 3 — fixed neutral panel, no date bounds: we want the ranker's
	// natural preference, exactly as production retrieval would see it.
	let probe: ProbeStats | null = null;
	if (args.probe && census !== null) {
		const hits: ProbeHit[] = [];
		for (const query of PROBE_QUERIES) {
			const results = await client.search(query, {
				limit: args.probeLimit,
				userId,
			});
			results.forEach((r, i) => {
				hits.push({
					query,
					rank: i + 1,
					resourceId: r.resourceId,
					score: r.score,
					createdAt: r.createdAt,
				});
			});
		}
		probe = buildProbeStats(hits, census.weekOf);
	}

	const verdict =
		runAll && timeline !== null && census !== null && probe !== null
			? buildVerdict(timeline, census, probe)
			: null;

	if (args.json) {
		// Summaries are content — included only under the same opt-in as human mode.
		const snapshots = classified?.map((s) => ({
			resourceId: s.resourceId,
			extractedAt: s.extractedAt,
			week: s.week,
			heavyHits: s.heavyHits,
			lightHits: s.lightHits,
			label: s.label,
			...(includeContent ? { summary: s.summary } : {}),
		}));
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				userId: userId ?? null,
				contentEnabled: includeContent,
				snapshotNote,
				snapshots: snapshots ?? null,
				timeline,
				census:
					census === null || !args.census
						? null
						: {
								rows: census.rows,
								undated: census.undated,
								totals: census.totals,
								total: census.total,
								dated: census.dated,
								datedViaSessionId: census.datedViaSessionId,
								snapshotResourcesVisible: census.snapshotResourcesVisible,
							},
				probe,
				verdict,
			}),
		);
		return;
	}

	if (args.mood) {
		if (snapshotNote) console.log(snapshotNote);
		if (classified !== null && timeline !== null) {
			console.log(formatSnapshotReview(classified, includeContent));
			console.log("");
			console.log(formatMoodTimeline(timeline));
		}
		console.log("");
	}
	if (args.census && census !== null) {
		console.log(formatCensus(census));
		console.log("");
	}
	if (args.probe && probe !== null) {
		console.log(formatProbe(probe));
		console.log("");
	}
	if (verdict !== null) {
		console.log(formatVerdict(verdict));
	} else if (runAll) {
		console.log(
			"combined verdict skipped: mood timeline unavailable (see note above)",
		);
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(2);
});
