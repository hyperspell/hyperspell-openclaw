/**
 * Pure logic for the mood-retrieval skew audit
 * (docs/proposals/10-mood-retrieval-skew-audit.md) — extracted here so the
 * classification/bucketing/verdict logic joins the hermetic unit suite while
 * the live runner (scripts/audit-mood-skew.ts) stays out of `npm test`,
 * mirroring the lib/loops-audit.ts + scripts/audit-loops.ts split.
 *
 * Nothing here touches the network. The audit is read-only observation of
 * three live surfaces: the emotional-state snapshot timeline, the corpus
 * census by `openclaw_source` × ISO week, and a fixed neutral probe panel.
 */

// ---------------------------------------------------------------------------
// Phase 1 — mood timeline
// ---------------------------------------------------------------------------

/**
 * Keyword lexicons from proposal 10 §Phase 1. Deliberately small: this is a
 * first-pass auto-label whose only job is to make the operator's manual
 * review of every summary faster — the review, not the lexicon, is the
 * ground truth. Inflections are included so "grieving"/"sadness" hit; word
 * boundaries stop "light" matching "lightning" and "sad" matching "sadness"
 * without its own entry.
 */
export const HEAVY_TERMS = [
	"grief",
	"grieving",
	"loss",
	"mourning",
	"ache",
	"aching",
	"heaviness",
	"heavy",
	"sad",
	"sadness",
	"sorrow",
	"tired",
	"weary",
	"strained",
	"fragile",
	"wounded",
	"tender",
] as const;

export const LIGHT_TERMS = [
	"warm",
	"warmth",
	"playful",
	"easy",
	"ease",
	"curious",
	"energized",
	"light",
	"lighter",
	"steady",
	"bright",
	"joy",
	"joyful",
] as const;

export type MoodLabel = "heavy" | "light" | "neutral";
export type WeekLabel = "heavy" | "light" | "mixed" | "unknown";

function countTermHits(text: string, terms: readonly string[]): number {
	let hits = 0;
	for (const term of terms) {
		hits += text.match(new RegExp(`\\b${term}\\b`, "gi"))?.length ?? 0;
	}
	return hits;
}

export function classifySummary(summary: string): {
	heavyHits: number;
	lightHits: number;
	score: number;
	label: MoodLabel;
} {
	const heavyHits = countTermHits(summary, HEAVY_TERMS);
	const lightHits = countTermHits(summary, LIGHT_TERMS);
	const score = heavyHits - lightHits;
	return {
		heavyHits,
		lightHits,
		score,
		label: score > 0 ? "heavy" : score < 0 ? "light" : "neutral",
	};
}

/** UTC Monday of the date's ISO week, as YYYY-MM-DD; null on unparseable input. */
export function weekStartOf(iso: string): string | null {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const day = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
}

export type MoodSnapshot = {
	resourceId: string;
	summary: string;
	extractedAt: string;
};

export type ClassifiedSnapshot = MoodSnapshot & {
	week: string | null;
	heavyHits: number;
	lightHits: number;
	label: MoodLabel;
};

export function classifySnapshots(
	snapshots: MoodSnapshot[],
): ClassifiedSnapshot[] {
	return snapshots.map((s) => {
		const { heavyHits, lightHits, label } = classifySummary(s.summary);
		return {
			...s,
			week: weekStartOf(s.extractedAt),
			heavyHits,
			lightHits,
			label,
		};
	});
}

export type MoodWeekRow = {
	week: string;
	snapshots: number;
	heavy: number;
	light: number;
	neutral: number;
	label: WeekLabel;
};

/** Week label: strict-majority heavy/light, else mixed. Undated snapshots drop. */
export function buildMoodTimeline(
	classified: ClassifiedSnapshot[],
): MoodWeekRow[] {
	const byWeek = new Map<
		string,
		{ heavy: number; light: number; neutral: number }
	>();
	for (const s of classified) {
		if (s.week === null) continue;
		const agg = byWeek.get(s.week) ?? { heavy: 0, light: 0, neutral: 0 };
		agg[s.label]++;
		byWeek.set(s.week, agg);
	}
	return [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([week, agg]) => {
			const snapshots = agg.heavy + agg.light + agg.neutral;
			const label: WeekLabel =
				agg.heavy * 2 > snapshots
					? "heavy"
					: agg.light * 2 > snapshots
						? "light"
						: "mixed";
			return { week, snapshots, ...agg, label };
		});
}

// ---------------------------------------------------------------------------
// Phase 2 — corpus census by source × week
// ---------------------------------------------------------------------------

export const SOURCE_BUCKETS = [
	"hot_buffer",
	"agent_end",
	"command",
	"memory_sync",
	"emotional_state",
	"other",
] as const;
export type SourceBucket = (typeof SOURCE_BUCKETS)[number];

function emptyCounts(): Record<SourceBucket, number> {
	return {
		hot_buffer: 0,
		agent_end: 0,
		command: 0,
		memory_sync: 0,
		emotional_state: 0,
		other: 0,
	};
}

/**
 * `openclaw_source` is the pipeline discriminator every write path stamps
 * (hooks/hot-buffer.ts, client.sendTrace, client.addMemory, sync/markdown.ts).
 * Emotional-state snapshots are the exception: storeEmotionalState stamps
 * `source: "openclaw_agent_end"` (hooks/emotional-state.ts), a different key —
 * checked after openclaw_source so the two can never shadow each other.
 */
export function bucketSource(metadata: Record<string, unknown>): SourceBucket {
	const src = metadata.openclaw_source;
	if (src === "hot_buffer") return "hot_buffer";
	if (src === "agent_end") return "agent_end";
	if (src === "command") return "command";
	if (src === "memory_sync" || src === "memory_sync_section")
		return "memory_sync";
	if (metadata.source === "openclaw_agent_end") return "emotional_state";
	return "other";
}

/**
 * Week of a listed resource. `created_at` coverage in the list payload is one
 * of the open questions this audit answers (proposal 10 §Phase 2), so the
 * fallback — a date embedded in `openclaw_session_id` — is tracked separately
 * and reported, never silently mixed in.
 */
export function resourceWeek(metadata: Record<string, unknown>): {
	week: string | null;
	via: "created_at" | "session_id" | null;
} {
	const created = metadata.created_at;
	if (typeof created === "string") {
		const week = weekStartOf(created);
		if (week !== null) return { week, via: "created_at" };
	}
	const sid = metadata.openclaw_session_id;
	if (typeof sid === "string") {
		const embedded = /(\d{4}-\d{2}-\d{2})/.exec(sid);
		if (embedded) {
			const week = weekStartOf(embedded[1]);
			if (week !== null) return { week, via: "session_id" };
		}
	}
	return { week: null, via: null };
}

export type CensusResource = {
	resourceId: string;
	metadata: Record<string, unknown>;
};

export type CensusWeekRow = {
	week: string;
	counts: Record<SourceBucket, number>;
	total: number;
};

export type Census = {
	/** Dated weeks only, sorted ascending. */
	rows: CensusWeekRow[];
	/** Resources with no recoverable week, by source bucket. */
	undated: Record<SourceBucket, number>;
	totals: Record<SourceBucket, number>;
	total: number;
	dated: number;
	datedViaSessionId: number;
	/** Do emotional-state snapshot resources appear in memories.list at all? */
	snapshotResourcesVisible: boolean;
	/** resourceId → week, for joining Phase-3 probe hits without createdAt. */
	weekOf: Map<string, string>;
};

export function buildCensus(resources: CensusResource[]): Census {
	const byWeek = new Map<string, Record<SourceBucket, number>>();
	const undated = emptyCounts();
	const totals = emptyCounts();
	const weekOf = new Map<string, string>();
	let dated = 0;
	let datedViaSessionId = 0;

	for (const r of resources) {
		const bucket = bucketSource(r.metadata);
		totals[bucket]++;
		const { week, via } = resourceWeek(r.metadata);
		if (week === null) {
			undated[bucket]++;
			continue;
		}
		dated++;
		if (via === "session_id") datedViaSessionId++;
		weekOf.set(r.resourceId, week);
		const counts = byWeek.get(week) ?? emptyCounts();
		counts[bucket]++;
		byWeek.set(week, counts);
	}

	const rows: CensusWeekRow[] = [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([week, counts]) => ({
			week,
			counts,
			total: SOURCE_BUCKETS.reduce((sum, b) => sum + counts[b], 0),
		}));

	return {
		rows,
		undated,
		totals,
		total: resources.length,
		dated,
		datedViaSessionId,
		snapshotResourcesVisible: totals.emotional_state > 0,
		weekOf,
	};
}

// ---------------------------------------------------------------------------
// Phase 3 — retrieval probe
// ---------------------------------------------------------------------------

/**
 * Fixed neutral panel from proposal 10 §Phase 3 — deliberately mundane and
 * NOT emotion-themed, because heavy weeks winning emotion-adjacent queries
 * would be correct retrieval, not skew. Committed with the code so reruns are
 * comparable; do not edit between runs of the same audit window.
 */
export const PROBE_QUERIES = [
	"what did we decide about the plugin config",
	"plans for the weekend",
	"cooking dinner",
	"book recommendation",
	"how the project is going",
	"morning routine",
	"travel plans",
	"something funny that happened",
	"what David is working on",
	"health and sleep",
	"music we talked about",
	"errands and chores",
] as const;

export type ProbeHit = {
	query: string;
	rank: number;
	resourceId: string;
	score: number | null;
	createdAt: string | null;
};

export type ProbeWeekRow = {
	week: string;
	slots: number;
	/** Fraction of ALL returned result slots (unknown-week slots included). */
	resultShare: number;
	meanScore: number | null;
};

export type ProbeStats = {
	rows: ProbeWeekRow[];
	totalSlots: number;
	unknownSlots: number;
	queries: number;
};

const round2 = (n: number): number => Number(n.toFixed(2));
const round4 = (n: number): number => Number(n.toFixed(4));

function mean(xs: number[]): number | null {
	if (xs.length === 0) return null;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Mean after dropping the single largest value; null under 2 points. */
function meanDropMax(xs: number[]): number | null {
	if (xs.length < 2) return null;
	const maxIdx = xs.indexOf(Math.max(...xs));
	return mean(xs.filter((_, i) => i !== maxIdx));
}

export function buildProbeStats(
	hits: ProbeHit[],
	weekOf: ReadonlyMap<string, string>,
): ProbeStats {
	const byWeek = new Map<string, { slots: number; scores: number[] }>();
	const queries = new Set<string>();
	let unknownSlots = 0;
	for (const hit of hits) {
		queries.add(hit.query);
		// createdAt (search echoes metadata.created_at) first, else census join.
		const week =
			(hit.createdAt !== null ? weekStartOf(hit.createdAt) : null) ??
			weekOf.get(hit.resourceId) ??
			null;
		if (week === null) {
			unknownSlots++;
			continue;
		}
		const agg = byWeek.get(week) ?? { slots: 0, scores: [] };
		agg.slots++;
		if (hit.score !== null) agg.scores.push(hit.score);
		byWeek.set(week, agg);
	}
	const totalSlots = hits.length;
	const rows: ProbeWeekRow[] = [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([week, agg]) => ({
			week,
			slots: agg.slots,
			resultShare: totalSlots === 0 ? 0 : round4(agg.slots / totalSlots),
			meanScore:
				agg.scores.length === 0 ? null : round4(mean(agg.scores) as number),
		}));
	return { rows, totalSlots, unknownSlots, queries: queries.size };
}

// ---------------------------------------------------------------------------
// Combined verdict
// ---------------------------------------------------------------------------

export type VerdictRow = {
	week: string;
	label: WeekLabel;
	hotBufferMsgs: number;
	/** Derived resources: auto-trace (agent_end) + emotional-state snapshots. */
	derived: number;
	derivedPer100: number | null;
	corpusShare: number | null;
	resultShare: number;
	lift: number | null;
	meanScore: number | null;
};

export type VerdictOutcome =
	| "insufficient-data"
	| "confirmed-skew"
	| "no-real-skew"
	| "ambiguous";

export type Verdict = {
	rows: VerdictRow[];
	heavyWeeks: number;
	lightWeeks: number;
	/** Heavy/light mean of derived-per-100-hot-buffer-messages. */
	volumeRatio: number | null;
	volumeRatioDropMax: number | null;
	heavyMeanLift: number | null;
	heavyMeanLiftDropMax: number | null;
	lightMeanLift: number | null;
	outcome: VerdictOutcome;
	reasons: string[];
};

/**
 * Pre-registered decision rule from proposal 10 §Test plan — thresholds were
 * fixed before any data was seen, so the outcome can't be argued into
 * existence. Confirmed skew requires BOTH a volume-or-lift signal AND the
 * effect being visible on the neutral panel (heavy mean lift > 1.0): the
 * lift/share numbers come only from the neutral probe queries, so a
 * volume-only signal that never surfaces in neutral retrieval stays
 * ambiguous, not confirmed. The guide pins the drop-the-max-week fallback at
 * 1.3× for volume; the same 1.3× floor is applied to the lift survival check
 * (the guide says "surviving removal" without a number).
 */
export function buildVerdict(
	timeline: MoodWeekRow[],
	census: Census,
	probe: ProbeStats,
): Verdict {
	const labelByWeek = new Map<string, WeekLabel>(
		timeline.map((r) => [r.week, r.label]),
	);
	const censusByWeek = new Map(census.rows.map((r) => [r.week, r]));
	const probeByWeek = new Map(probe.rows.map((r) => [r.week, r]));
	const weeks = [
		...new Set([
			...labelByWeek.keys(),
			...censusByWeek.keys(),
			...probeByWeek.keys(),
		]),
	].sort();

	const rows: VerdictRow[] = weeks.map((week) => {
		const c = censusByWeek.get(week);
		const p = probeByWeek.get(week);
		const hotBufferMsgs = c?.counts.hot_buffer ?? 0;
		const derived =
			(c?.counts.agent_end ?? 0) + (c?.counts.emotional_state ?? 0);
		const corpusShare =
			c !== undefined && census.dated > 0
				? round4(c.total / census.dated)
				: null;
		const resultShare = p?.resultShare ?? 0;
		return {
			week,
			label: labelByWeek.get(week) ?? "unknown",
			hotBufferMsgs,
			derived,
			derivedPer100:
				hotBufferMsgs > 0
					? Number(((derived / hotBufferMsgs) * 100).toFixed(1))
					: null,
			corpusShare,
			resultShare,
			lift:
				corpusShare !== null && corpusShare > 0
					? round2(resultShare / corpusShare)
					: null,
			meanScore: p?.meanScore ?? null,
		};
	});

	const heavyRows = rows.filter((r) => r.label === "heavy");
	const lightRows = rows.filter((r) => r.label === "light");
	const heavyWeeks = heavyRows.length;
	const lightWeeks = lightRows.length;

	const per100 = (rs: VerdictRow[]): number[] =>
		rs.map((r) => r.derivedPer100).filter((v): v is number => v !== null);
	const lifts = (rs: VerdictRow[]): number[] =>
		rs.map((r) => r.lift).filter((v): v is number => v !== null);

	const heavyVolMean = mean(per100(heavyRows));
	const lightVolMean = mean(per100(lightRows));
	const heavyVolDropMax = meanDropMax(per100(heavyRows));
	const ratio = (a: number | null, b: number | null): number | null =>
		a !== null && b !== null && b > 0 ? round2(a / b) : null;
	const volumeRatio = ratio(heavyVolMean, lightVolMean);
	const volumeRatioDropMax = ratio(heavyVolDropMax, lightVolMean);

	const heavyMeanLiftRaw = mean(lifts(heavyRows));
	const heavyMeanLift =
		heavyMeanLiftRaw === null ? null : round2(heavyMeanLiftRaw);
	const heavyMeanLiftDropMaxRaw = meanDropMax(lifts(heavyRows));
	const heavyMeanLiftDropMax =
		heavyMeanLiftDropMaxRaw === null ? null : round2(heavyMeanLiftDropMaxRaw);
	const lightMeanLiftRaw = mean(lifts(lightRows));
	const lightMeanLift =
		lightMeanLiftRaw === null ? null : round2(lightMeanLiftRaw);

	const reasons: string[] = [];
	let outcome: VerdictOutcome;
	if (heavyWeeks < 3 || lightWeeks < 3) {
		outcome = "insufficient-data";
		reasons.push(
			`need >=3 heavy AND >=3 light labeled weeks (have ${heavyWeeks} heavy, ${lightWeeks} light) — rerun after 4-6 more weeks of data`,
		);
	} else {
		const volumeSkew =
			volumeRatio !== null &&
			volumeRatio >= 1.5 &&
			volumeRatioDropMax !== null &&
			volumeRatioDropMax >= 1.3;
		const liftSkew =
			heavyMeanLift !== null &&
			lightMeanLift !== null &&
			heavyMeanLift >= 1.5 &&
			lightMeanLift <= 1.0 &&
			heavyMeanLiftDropMax !== null &&
			heavyMeanLiftDropMax >= 1.3;
		const panelVisible = heavyMeanLift !== null && heavyMeanLift > 1.0;
		reasons.push(
			`volume: heavy/light derived-per-100-msgs ratio = ${volumeRatio ?? "n/a"} (threshold 1.5; drop-max ${volumeRatioDropMax ?? "n/a"}, threshold 1.3) — ${volumeSkew ? "SKEW" : "no skew"}`,
			`lift: heavy mean ${heavyMeanLift ?? "n/a"} (threshold 1.5; drop-max ${heavyMeanLiftDropMax ?? "n/a"}, threshold 1.3), light mean ${lightMeanLift ?? "n/a"} (threshold <=1.0) — ${liftSkew ? "SKEW" : "no skew"}`,
			`neutral-panel visibility: heavy mean lift ${heavyMeanLift ?? "n/a"} ${panelVisible ? ">" : "<="} 1.0 — ${panelVisible ? "visible" : "not visible"}`,
		);
		if ((volumeSkew || liftSkew) && panelVisible) {
			outcome = "confirmed-skew";
		} else {
			const liftRatio = ratio(heavyMeanLift, lightMeanLift);
			const within20 = (v: number | null): boolean =>
				v !== null && v >= 0.8 && v <= 1.2;
			if (within20(volumeRatio) && within20(liftRatio)) {
				outcome = "no-real-skew";
				reasons.push(
					`volume ratio ${volumeRatio} and lift ratio ${liftRatio} both within +/-20% — heavy and light weeks retrieve proportionally`,
				);
			} else {
				outcome = "ambiguous";
				reasons.push(
					"between the confirmed and no-skew bands — record these numbers and rerun after 4-6 more weeks",
				);
			}
		}
	}

	return {
		rows,
		heavyWeeks,
		lightWeeks,
		volumeRatio,
		volumeRatioDropMax,
		heavyMeanLift,
		heavyMeanLiftDropMax,
		lightMeanLift,
		outcome,
		reasons,
	};
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export type SkewArgs = {
	json: boolean;
	mood: boolean;
	census: boolean;
	probe: boolean;
	user?: string;
	probeLimit: number;
	snapshotLimit: number;
};

/** Parse CLI args; throws with a usable message on anything malformed. */
export function parseSkewArgs(argv: string[]): SkewArgs {
	const args: SkewArgs = {
		json: false,
		mood: false,
		census: false,
		probe: false,
		probeLimit: 25,
		snapshotLimit: 200,
	};
	const take = (flag: string, i: number): string => {
		const v = argv[i];
		if (v === undefined) throw new Error(`${flag} requires a value`);
		return v;
	};
	const takeInt = (flag: string, i: number): number => {
		const n = Number(take(flag, i));
		if (!Number.isInteger(n) || n < 1)
			throw new Error(`${flag} must be a positive integer`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--mood":
				args.mood = true;
				break;
			case "--census":
				args.census = true;
				break;
			case "--probe":
				args.probe = true;
				break;
			case "-o": {
				const fmt = take(a, ++i);
				if (fmt !== "json")
					throw new Error(`unsupported output format "${fmt}" (only: json)`);
				args.json = true;
				break;
			}
			case "--user":
				args.user = take(a, ++i);
				break;
			case "--probe-limit":
				args.probeLimit = takeInt(a, ++i);
				break;
			case "--snapshot-limit":
				args.snapshotLimit = takeInt(a, ++i);
				break;
			default:
				throw new Error(`unknown argument "${a}"`);
		}
	}
	// No phase flag = the full audit (all three phases + combined verdict).
	if (!args.mood && !args.census && !args.probe) {
		args.mood = true;
		args.census = true;
		args.probe = true;
	}
	return args;
}

// ---------------------------------------------------------------------------
// Human formatting
// ---------------------------------------------------------------------------

function renderTable(header: string[], rows: string[][]): string {
	const all = [header, ...rows];
	const widths = header.map((_, i) =>
		Math.max(...all.map((r) => (r[i] ?? "").length)),
	);
	return all
		.map((r) =>
			r
				.map((c, i) => (c ?? "").padEnd(widths[i]))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

const pct = (v: number | null): string =>
	v === null ? "—" : `${(v * 100).toFixed(1)}%`;
const num = (v: number | null): string => (v === null ? "—" : String(v));

export function formatSnapshotReview(
	classified: ClassifiedSnapshot[],
	includeContent: boolean,
): string {
	const lines = [
		"mood snapshots — auto-labels for MANUAL review (the lexicon is a first pass, your eyes are the ground truth):",
	];
	for (const s of classified) {
		const head = `  ${s.week ?? "(undated)"}  ${s.label.padEnd(7)} (heavy ${s.heavyHits} / light ${s.lightHits})  ${s.resourceId}`;
		lines.push(
			includeContent
				? `${head}\n      ${s.summary.replace(/\s+/g, " ").slice(0, 240)}`
				: head,
		);
	}
	if (!includeContent) {
		lines.push(
			"  (set HYPERSPELL_AUDIT_CONTENT=1 to print the summaries — required for the manual label review)",
		);
	}
	return lines.join("\n");
}

export function formatMoodTimeline(rows: MoodWeekRow[]): string {
	if (rows.length === 0) return "mood timeline: no dated snapshots";
	return `mood timeline:\n${renderTable(
		["week", "snapshots", "heavy", "light", "neutral", "label"],
		rows.map((r) => [
			r.week,
			String(r.snapshots),
			String(r.heavy),
			String(r.light),
			String(r.neutral),
			r.label,
		]),
	)}`;
}

export function formatCensus(census: Census): string {
	const header = ["week", ...SOURCE_BUCKETS, "total"];
	const rows = census.rows.map((r) => [
		r.week,
		...SOURCE_BUCKETS.map((b) => String(r.counts[b])),
		String(r.total),
	]);
	const undatedTotal = SOURCE_BUCKETS.reduce(
		(s, b) => s + census.undated[b],
		0,
	);
	rows.push([
		"(undated)",
		...SOURCE_BUCKETS.map((b) => String(census.undated[b])),
		String(undatedTotal),
	]);
	rows.push([
		"TOTAL",
		...SOURCE_BUCKETS.map((b) => String(census.totals[b])),
		String(census.total),
	]);
	const coverage = census.total === 0 ? null : census.dated / census.total;
	return [
		`corpus census (${census.total} resources):`,
		renderTable(header, rows),
		`dated: ${census.dated}/${census.total} (${pct(coverage)}) — ${census.datedViaSessionId} via session-id fallback, ${undatedTotal} undated`,
		`snapshot resources visible via memories.list: ${census.snapshotResourcesVisible ? "yes" : "no"}`,
	].join("\n");
}

export function formatProbe(stats: ProbeStats): string {
	return [
		`retrieval probe (${stats.queries} queries, ${stats.totalSlots} result slots, ${stats.unknownSlots} undatable):`,
		renderTable(
			["week", "slots", "resultShare", "meanScore"],
			stats.rows.map((r) => [
				r.week,
				String(r.slots),
				pct(r.resultShare),
				num(r.meanScore),
			]),
		),
	].join("\n");
}

export function formatVerdict(verdict: Verdict): string {
	const lines = [
		"combined verdict (thresholds pre-registered in docs/proposals/10-mood-retrieval-skew-audit.md):",
		renderTable(
			[
				"week",
				"label",
				"msgs(hot_buffer)",
				"derived",
				"derived/100msgs",
				"corpusShare",
				"resultShare",
				"lift",
				"meanScore",
			],
			verdict.rows.map((r) => [
				r.week,
				r.label,
				String(r.hotBufferMsgs),
				String(r.derived),
				num(r.derivedPer100),
				pct(r.corpusShare),
				pct(r.resultShare),
				num(r.lift),
				num(r.meanScore),
			]),
		),
		"",
		`heavy weeks: ${verdict.heavyWeeks}   light weeks: ${verdict.lightWeeks}`,
		`volume ratio (heavy/light derived-per-100-msgs): ${num(verdict.volumeRatio)} (drop-max: ${num(verdict.volumeRatioDropMax)})`,
		`mean lift: heavy ${num(verdict.heavyMeanLift)} (drop-max: ${num(verdict.heavyMeanLiftDropMax)})   light ${num(verdict.lightMeanLift)}`,
		"",
		`OUTCOME: ${verdict.outcome}`,
		...verdict.reasons.map((r) => `  - ${r}`),
	];
	return lines.join("\n");
}
