/**
 * Loose Threads — read-only audit of the startup-orientation unfinished-loops
 * block (docs/proposals/04-startup-orientation-loops-tuning.md; rubric and
 * owner workflow in docs/loops-audit-rubric.md).
 *
 *   node --experimental-strip-types scripts/audit-loops.ts              # human view
 *   node --experimental-strip-types scripts/audit-loops.ts -o json      # one JSONL line per variant
 *   ... --simulate a1,a2,dynamic,after30,after60                        # candidates, side by side
 *   ... --query "..." --limit N --after 30 --user id                    # ad-hoc overrides
 *   ... --summary <ledger.jsonl> <labels.jsonl>                         # offline metrics, no network
 *
 * Fidelity: the primary run goes through the REAL production path — it calls
 * `gatherOrientation` (hooks/startup-orientation.ts) with the live install's
 * parsed config, so the as-injected <hyperspell-unfinished-loops> block is
 * byte-identical to what a session start would inject, and then repeats the
 * hook's exact underlying `client.search(so.loopsQuery, { limit, userId })`
 * call for per-result diagnostics (resourceId, score, createdAt, dropped
 * slots). Simulated variants change only the query/window inputs; production
 * config and code are never modified. What the script cannot see, by design:
 * `injectedSessions` once-per-turn gating, the multi-speaker skip, and
 * multi-user sender resolution (pass --user to emulate a resolved user) —
 * for a single-user install the search is identical to the hook's.
 *
 * Privacy: memory content (highlight snippets + the as-injected block) is
 * written ONLY when the operator sets HYPERSPELL_AUDIT_CONTENT=1 — setting it
 * is the opt-in, matching the HYPERSPELL_SCORE_LOG precedent in
 * hooks/auto-context.ts. Titles are always included (the rubric needs them to
 * identify resources), so treat any saved ledger as sensitive regardless and
 * delete it after the audit window (see the rubric doc).
 *
 * Hits the live Hyperspell API with real credentials: run manually, never
 * from `npm test` or CI. Search-only — never writes or deletes memories. The
 * pure helpers live in lib/loops-audit.ts and ARE part of `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { HyperspellClient } from "../client.ts";
import { type HyperspellConfig, parseConfig } from "../config.ts";
import { gatherOrientation } from "../hooks/startup-orientation.ts";
import {
	type AuditLabel,
	type AuditRunRecord,
	buildRunRecord,
	buildVariants,
	compareVariantSets,
	formatComparisonHuman,
	formatRunHuman,
	formatSummaryHuman,
	parseAuditArgs,
	parseJsonl,
	summarizeAudit,
	titlesFromRecentBlock,
} from "../lib/loops-audit.ts";

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

async function main() {
	const args = parseAuditArgs(process.argv.slice(2));

	if (args.summary) {
		const records = parseJsonl<AuditRunRecord>(fs.readFileSync(args.summary.ledger, "utf8"));
		const labels = parseJsonl<AuditLabel>(fs.readFileSync(args.summary.labels, "utf8"));
		console.log(formatSummaryHuman(summarizeAudit(records, labels)));
		return;
	}

	const includeContent = process.env.HYPERSPELL_AUDIT_CONTENT === "1";
	const cfg = loadConfig();
	const client = new HyperspellClient(cfg);
	const so = cfg.startupOrientation;
	const userId = args.user; // undefined = client's configured user, like the single-user hook path
	const limit = args.limit ?? so.loopsLimit;
	const baseQuery = args.query ?? so.loopsQuery;

	// The real injection path. Query/limit overrides are applied by cloning the
	// parsed config so the PRODUCTION code (gatherOrientation) still builds the
	// block — the audit never re-implements the hook's fetch or formatting.
	const overridden = args.query !== undefined || args.limit !== undefined;
	const gatherCfg: HyperspellConfig = overridden
		? { ...cfg, startupOrientation: { ...so, loopsQuery: baseQuery, loopsLimit: limit } }
		: cfg;
	const gathered = await gatherOrientation(client, gatherCfg, userId);

	// Recent titles feed only the `dynamic` simulation (#107's candidate shape).
	const recentTitles = titlesFromRecentBlock(gathered.recentBlock);
	const now = new Date();
	const ts = now.toISOString();
	const variants = buildVariants(baseQuery, args, recentTitles, now);

	const records: AuditRunRecord[] = [];
	for (const variant of variants) {
		// Byte-for-byte the hook's loops retrieval (hooks/startup-orientation.ts
		// gatherOrientation): client.search(query, { limit, userId }) — `after`
		// only exists on windowed simulation variants (proposal 04 Candidate B).
		const results = await client.search(variant.query, {
			limit,
			userId,
			...(variant.after ? { after: variant.after } : {}),
		});
		// The gatherOrientation cross-check only applies to the primary variant
		// when it ran the same unwindowed search the hook would.
		const isGatherComparable = variant === variants[0] && variant.after === undefined;
		records.push(
			buildRunRecord({
				ts,
				variant,
				limit,
				userId,
				results,
				includeContent,
				asInjectedBlock: isGatherComparable ? gathered.loopsBlock : null,
				gatherLoopsCount: isGatherComparable ? gathered.loopsCount : null,
			}),
		);
	}

	if (args.json) {
		// One deterministic JSONL line per variant — append to a ledger with `>>`.
		for (const rec of records) console.log(JSON.stringify(rec));
		return;
	}

	for (const rec of records) {
		console.log(formatRunHuman(rec));
		console.log("");
	}
	for (const rec of records.slice(1)) {
		console.log(formatComparisonHuman(rec.variant, compareVariantSets(records[0], rec)));
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(2);
});
