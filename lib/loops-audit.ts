import type { SearchResult } from "../client.ts";

/**
 * Pure logic for the unfinished-loops audit
 * (docs/proposals/04-startup-orientation-loops-tuning.md) — extracted here so
 * parsing/formatting/summary logic joins the hermetic unit suite while the
 * live runner (scripts/audit-loops.ts) stays out of `npm test`, mirroring the
 * lib/eval-matchers.ts + scripts/eval-retrieval.ts split.
 *
 * Nothing here touches the network or the production hook: the audit is
 * read-only observation of what `gatherOrientation`'s loops search returns.
 */

/**
 * Candidate reworded default queries from proposal 04 §3.3 (Candidate A).
 * These are audit probes only — the shipped default in config.ts is untouched
 * until a variant graduates via the rubric's paired-day gate.
 */
export const CANDIDATE_QUERIES = {
	a1: "I'll get back to you, still need to, waiting on, didn't finish, let's pick this up later, promised to follow up",
	a2: "unresolved follow-up: promised, waiting on an answer, blocked, next step, revisit, unfinished task, open question",
} as const;

/**
 * Caps from PR #107's `buildLoopsQuery` sketch
 * (docs/plans/issue-73-static-loops-query.md) — reproduced here ONLY to
 * simulate that candidate remedy side by side with the static query. This is
 * deliberately not imported from production code: #107 is unimplemented by
 * decision (audit-first), so the simulation owns its own copy of the shape.
 */
const LOOPS_TITLE_MAX = 80;
const LOOPS_TOPICS_MAX = 300;

/**
 * Simulate #107's dynamic query: static intent base + recent conversation
 * titles. Empty titles collapse to exactly the base — same graceful
 * degradation the candidate specifies.
 */
export function deriveDynamicQuery(base: string, titles: string[]): string {
	const topics: string[] = [];
	let used = 0;
	for (const raw of titles) {
		const title = raw.replace(/\s+/g, " ").trim().slice(0, LOOPS_TITLE_MAX);
		if (title.length === 0) continue;
		if (used + title.length > LOOPS_TOPICS_MAX) break;
		topics.push(title);
		used += title.length;
	}
	if (topics.length === 0) return base;
	return `${base} — recent topics: ${topics.join("; ")}`;
}

/**
 * Recover titles from a formatted <hyperspell-recent-interactions> block
 * (`- [3d ago] Title — snippet` / hot-buffer shape `- Title`). Parsing the
 * rendered block instead of re-running a private fetch keeps the runner on
 * gatherOrientation's real output; the trade-off (a title containing " — "
 * gets truncated) is acceptable for a simulation input and documented in the
 * rubric.
 */
export function titlesFromRecentBlock(recentBlock: string | null): string[] {
	if (!recentBlock) return [];
	const titles: string[] = [];
	for (const line of recentBlock.split("\n")) {
		const m = /^- (?:\[[^\]]*\] )?(.*)$/.exec(line);
		if (!m) continue;
		const title = m[1].split(" — ")[0].trim();
		if (title.length > 0) titles.push(title);
	}
	return titles;
}

export const SIMULATE_NAMES = [
	"a1",
	"a2",
	"dynamic",
	"after30",
	"after60",
] as const;
export type SimulateName = (typeof SIMULATE_NAMES)[number];

export type AuditArgs = {
	json: boolean;
	query?: string;
	limit?: number;
	after?: string;
	user?: string;
	simulate: SimulateName[];
	summary?: { ledger: string; labels: string };
};

/** Parse CLI args; throws with a usable message on anything malformed. */
export function parseAuditArgs(argv: string[]): AuditArgs {
	const args: AuditArgs = { json: false, simulate: [] };
	const take = (flag: string, i: number): string => {
		const v = argv[i];
		if (v === undefined) throw new Error(`${flag} requires a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "-o": {
				const fmt = take(a, ++i);
				if (fmt !== "json") throw new Error(`unsupported output format "${fmt}" (only: json)`);
				args.json = true;
				break;
			}
			case "--query":
				args.query = take(a, ++i);
				break;
			case "--limit": {
				const n = Number(take(a, ++i));
				if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
				args.limit = n;
				break;
			}
			case "--after":
				args.after = take(a, ++i);
				break;
			case "--user":
				args.user = take(a, ++i);
				break;
			case "--simulate": {
				for (const name of take(a, ++i).split(",").map((s) => s.trim()).filter(Boolean)) {
					if (!(SIMULATE_NAMES as readonly string[]).includes(name)) {
						throw new Error(`unknown --simulate variant "${name}" (known: ${SIMULATE_NAMES.join(", ")})`);
					}
					args.simulate.push(name as SimulateName);
				}
				break;
			}
			case "--summary":
				args.summary = { ledger: take(a, ++i), labels: take(a, ++i) };
				break;
			default:
				throw new Error(`unknown argument "${a}"`);
		}
	}
	return args;
}

/** `--after 30` = 30 days before `now`; anything else must parse as a date. */
export function resolveAfter(value: string, now: Date = new Date()): string {
	if (/^\d+$/.test(value)) {
		const d = new Date(now);
		d.setUTCDate(d.getUTCDate() - Number(value));
		return d.toISOString();
	}
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) throw new Error(`--after "${value}" is neither a day count nor a date`);
	return d.toISOString();
}

export type AuditVariant = { name: string; query: string; after?: string };

/**
 * The variant list for one invocation. The first entry is always the audited
 * primary: named "baseline" only when it is exactly the production values, so
 * ledger lines can't silently mix overridden runs into the baseline series.
 */
export function buildVariants(
	baseQuery: string,
	args: AuditArgs,
	recentTitles: string[],
	now: Date = new Date(),
): AuditVariant[] {
	const overridden = args.query !== undefined || args.after !== undefined || args.limit !== undefined;
	const primary: AuditVariant = {
		name: overridden ? "custom" : "baseline",
		query: baseQuery,
		...(args.after ? { after: resolveAfter(args.after, now) } : {}),
	};
	const variants = [primary];
	for (const name of args.simulate) {
		if (name === "a1" || name === "a2") {
			variants.push({ name, query: CANDIDATE_QUERIES[name] });
		} else if (name === "dynamic") {
			variants.push({ name, query: deriveDynamicQuery(baseQuery, recentTitles) });
		} else {
			const days = name === "after30" ? "30" : "60";
			variants.push({ name, query: baseQuery, after: resolveAfter(days, now) });
		}
	}
	return variants;
}

const round4 = (n: number): number => Number(n.toFixed(4));

export type AuditRow = {
	rank: number;
	resourceId: string;
	title: string | null;
	source: string;
	score: number | null;
	createdAt: string | null;
	highlightCount: number;
	/** Would formatUnfinishedLoops render it (has a first highlight)? */
	rendered: boolean;
	/** Content text — present only when the operator opted in (see runner). */
	snippet?: string;
};

export function toAuditRow(
	r: SearchResult,
	rank: number,
	includeContent: boolean,
): AuditRow {
	// Mirror formatUnfinishedLoops: it renders highlights[0] as returned, not
	// the top-scored highlight, and silently drops no-highlight results.
	const top = r.highlights[0];
	return {
		rank,
		resourceId: r.resourceId,
		title: r.title === null ? null : r.title.slice(0, 120),
		source: r.source,
		score: r.score === null ? null : round4(r.score),
		createdAt: r.createdAt,
		highlightCount: r.highlights.length,
		rendered: top !== undefined,
		...(includeContent && top ? { snippet: top.text.replace(/\s+/g, " ").slice(0, 160) } : {}),
	};
}

/** Count rendered bullets in a formatted loops/recent block. */
export function countBlockBullets(block: string | null): number {
	if (!block) return 0;
	return block.split("\n").filter((l) => l.startsWith("- ")).length;
}

export type AuditRunRecord = {
	ts: string;
	variant: string;
	query: string;
	limit: number;
	after: string | null;
	userId: string | null;
	contentEnabled: boolean;
	resultCount: number;
	renderedCount: number;
	wastedSlots: number;
	/**
	 * Baseline only: do gatherOrientation's block and the diagnostic search
	 * agree (same result count, same bullet count)? The two are separate API
	 * calls moments apart; `false` means the corpus moved between them — rerun
	 * rather than judge that line.
	 */
	blockConsistent: boolean | null;
	results: AuditRow[];
	/** The real formatted block from gatherOrientation; content-gated. */
	asInjected: string | null;
};

export function buildRunRecord(input: {
	ts: string;
	variant: AuditVariant;
	limit: number;
	userId: string | undefined;
	results: SearchResult[];
	includeContent: boolean;
	/** gatherOrientation's loopsBlock, when this variant ran through it. */
	asInjectedBlock: string | null;
	/** gatherOrientation's raw loops result count, when available. */
	gatherLoopsCount: number | null;
}): AuditRunRecord {
	const rows = input.results.map((r, i) => toAuditRow(r, i + 1, input.includeContent));
	const renderedCount = rows.filter((r) => r.rendered).length;
	const blockConsistent =
		input.gatherLoopsCount === null
			? null
			: input.gatherLoopsCount === input.results.length &&
				countBlockBullets(input.asInjectedBlock) === renderedCount;
	return {
		ts: input.ts,
		variant: input.variant.name,
		query: input.variant.query,
		limit: input.limit,
		after: input.variant.after ?? null,
		userId: input.userId ?? null,
		contentEnabled: input.includeContent,
		resultCount: rows.length,
		renderedCount,
		wastedSlots: rows.length - renderedCount,
		blockConsistent,
		results: rows,
		asInjected: input.includeContent ? input.asInjectedBlock : null,
	};
}

export type VariantComparison = {
	overlap: string[];
	onlyBaseline: string[];
	onlyVariant: string[];
};

/** Set-diff of surfaced resourceIds, rank order preserved within each list. */
export function compareVariantSets(
	baseline: AuditRunRecord,
	variant: AuditRunRecord,
): VariantComparison {
	const baseIds = baseline.results.map((r) => r.resourceId);
	const varIds = variant.results.map((r) => r.resourceId);
	const baseSet = new Set(baseIds);
	const varSet = new Set(varIds);
	return {
		overlap: baseIds.filter((id) => varSet.has(id)),
		onlyBaseline: baseIds.filter((id) => !varSet.has(id)),
		onlyVariant: varIds.filter((id) => !baseSet.has(id)),
	};
}

/** JSONL with blank lines and `//` comment lines allowed (fixture-file style). */
export function parseJsonl<T>(text: string): T[] {
	const out: T[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length === 0 || line.startsWith("//")) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			throw new Error(`invalid JSON on line ${i + 1}`);
		}
	}
	return out;
}

export type LoopVerdict = "still-open" | "resolved" | "not-a-loop";
export const LOOP_VERDICTS: readonly LoopVerdict[] = [
	"still-open",
	"resolved",
	"not-a-loop",
];

/** One hand-written label line (schema in docs/loops-audit-rubric.md). */
export type AuditLabel = {
	/** The run's `ts` — labels bind to one run of one variant. */
	ts: string;
	variant: string;
	resourceId: string;
	verdict: LoopVerdict;
	snippetInsufficient?: boolean;
	evidence?: string;
};

export type VariantSummary = {
	variant: string;
	runs: number;
	bullets: number;
	wastedSlots: number;
	labeled: number;
	verdicts: Record<LoopVerdict, number>;
	snippetInsufficient: number;
	/** still-open / labeled rendered bullets; null until something is labeled. */
	hitRate: number | null;
	/**
	 * Fraction of distinct surfaced resourceIds seen in more than half the
	 * runs — the "stuck set" signature from issue #73. Null under 2 runs.
	 */
	repeatRate: number | null;
	/** Age in whole days (run ts − createdAt) per labeled bullet, by verdict. */
	ageDaysByVerdict: Record<LoopVerdict, number[]>;
	/** Days where this variant and baseline both had labeled bullets. */
	pairedDays: number | null;
	/** Of those, days this variant's hit rate beat baseline's (§4.2 gate). */
	pairedWins: number | null;
};

const labelKey = (ts: string, variant: string, resourceId: string): string =>
	`${ts}|${variant}|${resourceId}`;

function emptyVerdictCounts(): Record<LoopVerdict, number> {
	return { "still-open": 0, resolved: 0, "not-a-loop": 0 };
}

function dayHitRate(
	records: AuditRunRecord[],
	labels: Map<string, AuditLabel>,
): number | null {
	let open = 0;
	let labeled = 0;
	for (const rec of records) {
		for (const row of rec.results) {
			if (!row.rendered) continue;
			const label = labels.get(labelKey(rec.ts, rec.variant, row.resourceId));
			if (!label) continue;
			labeled++;
			if (label.verdict === "still-open") open++;
		}
	}
	return labeled === 0 ? null : open / labeled;
}

/** Compute the rubric's metrics from ledger records plus hand labels. */
export function summarizeAudit(
	records: AuditRunRecord[],
	labels: AuditLabel[],
): VariantSummary[] {
	const labelIndex = new Map<string, AuditLabel>();
	for (const l of labels) labelIndex.set(labelKey(l.ts, l.variant, l.resourceId), l);

	const byVariant = new Map<string, AuditRunRecord[]>();
	for (const rec of records) {
		const list = byVariant.get(rec.variant) ?? [];
		list.push(rec);
		byVariant.set(rec.variant, list);
	}

	const perDay = (recs: AuditRunRecord[]): Map<string, AuditRunRecord[]> => {
		const days = new Map<string, AuditRunRecord[]>();
		for (const rec of recs) {
			const day = rec.ts.slice(0, 10);
			const list = days.get(day) ?? [];
			list.push(rec);
			days.set(day, list);
		}
		return days;
	};
	const baselineDays = perDay(byVariant.get("baseline") ?? []);

	const summaries: VariantSummary[] = [];
	for (const [variant, recs] of byVariant) {
		const verdicts = emptyVerdictCounts();
		const ageDaysByVerdict: Record<LoopVerdict, number[]> = {
			"still-open": [],
			resolved: [],
			"not-a-loop": [],
		};
		let bullets = 0;
		let wastedSlots = 0;
		let labeled = 0;
		let snippetInsufficient = 0;
		const seenInRun = new Map<string, number>();
		for (const rec of recs) {
			bullets += rec.renderedCount;
			wastedSlots += rec.wastedSlots;
			for (const id of new Set(rec.results.map((r) => r.resourceId))) {
				seenInRun.set(id, (seenInRun.get(id) ?? 0) + 1);
			}
			for (const row of rec.results) {
				if (!row.rendered) continue;
				const label = labelIndex.get(labelKey(rec.ts, rec.variant, row.resourceId));
				if (!label) continue;
				labeled++;
				verdicts[label.verdict]++;
				if (label.snippetInsufficient) snippetInsufficient++;
				if (row.createdAt) {
					const age = (new Date(rec.ts).getTime() - new Date(row.createdAt).getTime()) / 86_400_000;
					if (Number.isFinite(age)) ageDaysByVerdict[label.verdict].push(Math.max(0, Math.round(age)));
				}
			}
		}

		let repeatRate: number | null = null;
		if (recs.length >= 2 && seenInRun.size > 0) {
			const repeating = [...seenInRun.values()].filter((n) => n > recs.length / 2).length;
			repeatRate = round4(repeating / seenInRun.size);
		}

		let pairedDays: number | null = null;
		let pairedWins: number | null = null;
		if (variant !== "baseline") {
			pairedDays = 0;
			pairedWins = 0;
			for (const [day, dayRecs] of perDay(recs)) {
				const baseRecs = baselineDays.get(day);
				if (!baseRecs) continue;
				const baseRate = dayHitRate(baseRecs, labelIndex);
				const varRate = dayHitRate(dayRecs, labelIndex);
				if (baseRate === null || varRate === null) continue;
				pairedDays++;
				if (varRate > baseRate) pairedWins++;
			}
		}

		summaries.push({
			variant,
			runs: recs.length,
			bullets,
			wastedSlots,
			labeled,
			verdicts,
			snippetInsufficient,
			hitRate: labeled === 0 ? null : round4(verdicts["still-open"] / labeled),
			repeatRate,
			ageDaysByVerdict,
			pairedDays,
			pairedWins,
		});
	}
	// Baseline first, then alphabetical — stable regardless of ledger order.
	summaries.sort((a, b) =>
		a.variant === "baseline" ? -1 : b.variant === "baseline" ? 1 : a.variant.localeCompare(b.variant),
	);
	return summaries;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function formatRunHuman(rec: AuditRunRecord): string {
	const lines = [
		`=== loops audit — ${rec.variant} ===`,
		`query: ${JSON.stringify(rec.query)}`,
		`limit: ${rec.limit}   after: ${rec.after ?? "(none)"}   userId: ${rec.userId ?? "(config default)"}`,
	];
	if (rec.results.length === 0) lines.push("  (no results)");
	for (const r of rec.results) {
		const score = r.score === null ? "     —" : r.score.toFixed(4);
		const when = r.createdAt ? r.createdAt.slice(0, 10) : "          ";
		const state = r.rendered ? "rendered" : "DROPPED: no highlights (wasted slot)";
		lines.push(`  ${r.rank}. ${score}  ${when}  ${r.title ?? `[${r.source}]`}  (${r.resourceId})  [${state}]`);
		if (r.snippet) lines.push(`       ${r.snippet}`);
	}
	lines.push(`rendered: ${rec.renderedCount}/${rec.resultCount}   wasted slots: ${rec.wastedSlots}`);
	if (rec.blockConsistent !== null) {
		lines.push(
			rec.blockConsistent
				? "as-injected block agrees with the diagnostic search"
				: "WARNING: as-injected block and diagnostic search DIVERGED — corpus moved between calls; rerun",
		);
	}
	if (rec.asInjected) lines.push("", rec.asInjected);
	else if (rec.blockConsistent !== null && !rec.contentEnabled) {
		lines.push("(set HYPERSPELL_AUDIT_CONTENT=1 to include snippets + the as-injected block)");
	}
	return lines.join("\n");
}

export function formatComparisonHuman(
	variant: string,
	cmp: VariantComparison,
): string {
	return [
		`--- ${variant} vs baseline ---`,
		`  overlap:       ${cmp.overlap.length === 0 ? "(none)" : cmp.overlap.join(", ")}`,
		`  only baseline: ${cmp.onlyBaseline.length === 0 ? "(none)" : cmp.onlyBaseline.join(", ")}`,
		`  only ${variant}: ${cmp.onlyVariant.length === 0 ? "(none)" : cmp.onlyVariant.join(", ")}`,
	].join("\n");
}

export function formatSummaryHuman(summaries: VariantSummary[]): string {
	const lines: string[] = ["loops audit — summary (rubric: docs/loops-audit-rubric.md)", ""];
	for (const s of summaries) {
		lines.push(`${s.variant}: ${s.runs} run(s), ${s.bullets} bullet(s), ${s.wastedSlots} wasted slot(s)`);
		if (s.labeled === 0) {
			lines.push("  no labeled bullets yet");
		} else {
			lines.push(
				`  hit rate: ${((s.hitRate ?? 0) * 100).toFixed(0)}%  (${s.verdicts["still-open"]} still-open / ${s.labeled} labeled)`,
				`  verdicts: still-open=${s.verdicts["still-open"]} resolved=${s.verdicts.resolved} not-a-loop=${s.verdicts["not-a-loop"]} snippet-insufficient=${s.snippetInsufficient}`,
			);
			for (const v of LOOP_VERDICTS) {
				const m = median(s.ageDaysByVerdict[v]);
				if (m !== null) lines.push(`  median age (${v}): ${m}d over ${s.ageDaysByVerdict[v].length} item(s)`);
			}
		}
		if (s.repeatRate !== null) lines.push(`  repeat rate: ${(s.repeatRate * 100).toFixed(0)}% of surfaced ids appear in >half the runs`);
		if (s.pairedDays !== null) lines.push(`  paired days vs baseline: ${s.pairedWins}/${s.pairedDays} win(s)`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
