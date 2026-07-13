import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	bucketSource,
	buildCensus,
	buildMoodTimeline,
	buildProbeStats,
	buildVerdict,
	type Census,
	type ClassifiedSnapshot,
	classifySnapshots,
	classifySummary,
	formatCensus,
	formatMoodTimeline,
	formatSnapshotReview,
	formatVerdict,
	type MoodWeekRow,
	PROBE_QUERIES,
	type ProbeHit,
	type ProbeStats,
	parseSkewArgs,
	resourceWeek,
	weekStartOf,
} from "./mood-skew-audit.ts";

test("classifySummary — lexicon hits, word boundaries, case-insensitivity", () => {
	const heavy = classifySummary(
		"A week of Grief and loss; she sounded tired and fragile.",
	);
	assert.equal(heavy.label, "heavy");
	assert.equal(heavy.heavyHits, 4);
	assert.equal(heavy.lightHits, 0);

	const light = classifySummary(
		"Warm, playful, and easy — curious about everything.",
	);
	assert.equal(light.label, "light");
	assert.equal(light.score, -4);

	// Boundaries: "lightning" must not hit "light", "lossless" must not hit "loss".
	const neutral = classifySummary(
		"Lightning storms and lossless audio came up.",
	);
	assert.equal(neutral.heavyHits, 0);
	assert.equal(neutral.lightHits, 0);
	assert.equal(neutral.label, "neutral");

	// Ties are neutral, not arbitrarily assigned.
	assert.equal(classifySummary("sad but warm").label, "neutral");
});

test("weekStartOf — UTC Monday of the ISO week; null on garbage", () => {
	assert.equal(weekStartOf("2026-06-10T15:30:00.000Z"), "2026-06-08"); // Wednesday → Monday
	assert.equal(weekStartOf("2026-06-08T00:00:00.000Z"), "2026-06-08"); // Monday stays
	assert.equal(weekStartOf("2026-06-14T23:59:59.000Z"), "2026-06-08"); // Sunday belongs to prior Monday
	assert.equal(weekStartOf("not a date"), null);
});

test("classifySnapshots + buildMoodTimeline — majority labels, undated dropped", () => {
	const snap = (id: string, extractedAt: string, summary: string) => ({
		resourceId: id,
		summary,
		extractedAt,
	});
	const classified = classifySnapshots([
		snap("s1", "2026-06-08T10:00:00Z", "grief and heaviness all day"),
		snap("s2", "2026-06-09T10:00:00Z", "still mourning, tired"),
		snap("s3", "2026-06-10T10:00:00Z", "a warm easy evening"),
		snap("s4", "2026-06-15T10:00:00Z", "playful and light"),
		snap("s5", "2026-06-16T10:00:00Z", "curious, energized"),
		snap("s6", "2026-06-22T10:00:00Z", "sad morning, warm afternoon"), // tie → neutral
		snap("s7", "garbage-date", "grief"), // undated → dropped from timeline
	]);
	assert.equal(classified[6].week, null);

	const timeline = buildMoodTimeline(classified);
	assert.deepEqual(
		timeline.map((r) => [r.week, r.snapshots, r.label]),
		[
			["2026-06-08", 3, "heavy"], // 2 heavy of 3 = strict majority
			["2026-06-15", 2, "light"],
			["2026-06-22", 1, "mixed"], // lone neutral snapshot → mixed
		],
	);
});

test("bucketSource — every write path's discriminator maps to its bucket", () => {
	assert.equal(bucketSource({ openclaw_source: "hot_buffer" }), "hot_buffer");
	assert.equal(bucketSource({ openclaw_source: "agent_end" }), "agent_end");
	assert.equal(bucketSource({ openclaw_source: "command" }), "command");
	assert.equal(bucketSource({ openclaw_source: "memory_sync" }), "memory_sync");
	assert.equal(
		bucketSource({ openclaw_source: "memory_sync_section" }),
		"memory_sync",
	);
	// Emotional-state snapshots stamp `source` (hooks/emotional-state.ts), not openclaw_source.
	assert.equal(
		bucketSource({ source: "openclaw_agent_end" }),
		"emotional_state",
	);
	assert.equal(bucketSource({}), "other");
	assert.equal(bucketSource({ openclaw_source: "something_new" }), "other");
});

test("resourceWeek — created_at first, session-id date fallback, else null", () => {
	assert.deepEqual(resourceWeek({ created_at: "2026-06-10T00:00:00Z" }), {
		week: "2026-06-08",
		via: "created_at",
	});
	assert.deepEqual(
		resourceWeek({ openclaw_session_id: "agent:main:2026-06-11-abc" }),
		{
			week: "2026-06-08",
			via: "session_id",
		},
	);
	// created_at wins over an embedded session date when both exist.
	assert.equal(
		resourceWeek({
			created_at: "2026-06-01T00:00:00Z",
			openclaw_session_id: "x-2026-06-11",
		}).via,
		"created_at",
	);
	assert.deepEqual(resourceWeek({ openclaw_session_id: "no-date-here" }), {
		week: null,
		via: null,
	});
	assert.deepEqual(resourceWeek({}), { week: null, via: null });
});

const res = (
	id: string,
	metadata: Record<string, unknown>,
): { resourceId: string; metadata: Record<string, unknown> } => ({
	resourceId: id,
	metadata,
});

test("buildCensus — week × source matrix, coverage counters, snapshot visibility", () => {
	const census = buildCensus([
		res("h1", {
			openclaw_source: "hot_buffer",
			created_at: "2026-06-09T01:00:00Z",
		}),
		res("h2", {
			openclaw_source: "hot_buffer",
			openclaw_session_id: "s-2026-06-10",
		}),
		res("t1", {
			openclaw_source: "agent_end",
			created_at: "2026-06-10T01:00:00Z",
		}),
		res("e1", {
			source: "openclaw_agent_end",
			created_at: "2026-06-16T01:00:00Z",
		}),
		res("u1", { openclaw_source: "hot_buffer" }), // undated
		res("x1", {}), // untagged AND undated
	]);
	assert.equal(census.total, 6);
	assert.equal(census.dated, 4);
	assert.equal(census.datedViaSessionId, 1);
	assert.equal(census.snapshotResourcesVisible, true);
	assert.deepEqual(
		census.rows.map((r) => r.week),
		["2026-06-08", "2026-06-15"],
	);
	assert.equal(census.rows[0].counts.hot_buffer, 2);
	assert.equal(census.rows[0].counts.agent_end, 1);
	assert.equal(census.rows[0].total, 3);
	assert.equal(census.rows[1].counts.emotional_state, 1);
	assert.equal(census.undated.hot_buffer, 1);
	assert.equal(census.undated.other, 1);
	assert.equal(census.totals.hot_buffer, 3);
	assert.equal(census.weekOf.get("h2"), "2026-06-08");
	assert.equal(census.weekOf.has("u1"), false);

	const noSnapshots = buildCensus([
		res("h1", { openclaw_source: "hot_buffer" }),
	]);
	assert.equal(noSnapshots.snapshotResourcesVisible, false);
});

test("PROBE_QUERIES — fixed neutral panel, committed and non-empty", () => {
	assert.equal(PROBE_QUERIES.length, 12);
	assert.ok(
		new Set(PROBE_QUERIES).size === PROBE_QUERIES.length,
		"no duplicate queries",
	);
});

const hit = (
	query: string,
	rank: number,
	resourceId: string,
	score: number | null,
	createdAt: string | null,
): ProbeHit => ({ query, rank, resourceId, score, createdAt });

test("buildProbeStats — week via createdAt, census join, unknown slots", () => {
	const weekOf = new Map([["joined", "2026-06-15"]]);
	const stats = buildProbeStats(
		[
			hit("q1", 1, "a", 0.9, "2026-06-09T00:00:00Z"),
			hit("q1", 2, "b", 0.5, "2026-06-10T00:00:00Z"),
			hit("q2", 1, "joined", 0.7, null), // dated via census join
			hit("q2", 2, "mystery", null, null), // undatable
		],
		weekOf,
	);
	assert.equal(stats.queries, 2);
	assert.equal(stats.totalSlots, 4);
	assert.equal(stats.unknownSlots, 1);
	assert.deepEqual(stats.rows, [
		{ week: "2026-06-08", slots: 2, resultShare: 0.5, meanScore: 0.7 },
		{ week: "2026-06-15", slots: 1, resultShare: 0.25, meanScore: 0.7 },
	]);
});

test("buildProbeStats — null scores excluded from meanScore, not from shares", () => {
	const stats = buildProbeStats(
		[
			hit("q", 1, "a", null, "2026-06-09T00:00:00Z"),
			hit("q", 2, "b", 0.4, "2026-06-09T00:00:00Z"),
		],
		new Map(),
	);
	assert.deepEqual(stats.rows, [
		{ week: "2026-06-08", slots: 2, resultShare: 1, meanScore: 0.4 },
	]);
});

// --- verdict fixtures -------------------------------------------------------

/** Six labeled weeks with controllable derived counts and probe shares. */
function verdictInputs(spec: {
	/** [hotBufferMsgs, derived, probeSlots] per week, heavy weeks first. */
	heavy: Array<[number, number, number]>;
	light: Array<[number, number, number]>;
}): { timeline: MoodWeekRow[]; census: Census; probe: ProbeStats } {
	// Week keys must be real UTC Mondays: the census re-derives the week from
	// created_at, so a non-Monday key here would silently miss the join.
	const monday = (i: number): string =>
		new Date(Date.UTC(2026, 0, 5 + 7 * i)).toISOString().slice(0, 10);
	const weeks: Array<{
		week: string;
		label: "heavy" | "light";
		msgs: number;
		derived: number;
		slots: number;
	}> = [];
	let w = 0;
	for (const [msgs, derived, slots] of spec.heavy) {
		weeks.push({ week: monday(w++), label: "heavy", msgs, derived, slots });
	}
	for (const [msgs, derived, slots] of spec.light) {
		weeks.push({ week: monday(w++), label: "light", msgs, derived, slots });
	}
	const timeline: MoodWeekRow[] = weeks.map((x) => ({
		week: x.week,
		snapshots: 1,
		heavy: x.label === "heavy" ? 1 : 0,
		light: x.label === "light" ? 1 : 0,
		neutral: 0,
		label: x.label,
	}));
	const resources = weeks.flatMap((x) => [
		...Array.from({ length: x.msgs }, (_, i) =>
			res(`${x.week}-h${i}`, {
				openclaw_source: "hot_buffer",
				created_at: `${x.week}T00:00:00Z`,
			}),
		),
		...Array.from({ length: x.derived }, (_, i) =>
			res(`${x.week}-t${i}`, {
				openclaw_source: "agent_end",
				created_at: `${x.week}T00:00:00Z`,
			}),
		),
	]);
	const census = buildCensus(resources);
	const hits: ProbeHit[] = weeks.flatMap((x) =>
		Array.from({ length: x.slots }, (_, i) =>
			hit("q", i + 1, `${x.week}-h${i}`, 0.5, `${x.week}T00:00:00Z`),
		),
	);
	return { timeline, census, probe: buildProbeStats(hits, census.weekOf) };
}

test("buildVerdict — fewer than 3 heavy or 3 light weeks is insufficient data", () => {
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 5, 10],
			[100, 5, 10],
		],
		light: [
			[100, 5, 10],
			[100, 5, 10],
			[100, 5, 10],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.equal(verdict.outcome, "insufficient-data");
	assert.equal(verdict.heavyWeeks, 2);
	assert.equal(verdict.lightWeeks, 3);
	assert.match(verdict.reasons[0], />=3 heavy/);
});

test("buildVerdict — confirmed skew via lift (heavy over-represented on neutral panel)", () => {
	// Equal volume everywhere; heavy weeks eat 2x their corpus share of results.
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 5, 24],
			[100, 5, 20],
			[100, 5, 22],
		],
		light: [
			[100, 5, 6],
			[100, 5, 4],
			[100, 5, 4],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.equal(verdict.outcome, "confirmed-skew");
	assert.ok(
		(verdict.heavyMeanLift ?? 0) >= 1.5,
		`heavy lift ${verdict.heavyMeanLift}`,
	);
	assert.ok(
		(verdict.lightMeanLift ?? 9) <= 1.0,
		`light lift ${verdict.lightMeanLift}`,
	);
});

test("buildVerdict — volume skew alone without panel visibility stays ambiguous", () => {
	// Heavy weeks produce 3x derived per message, but retrieval slots stay
	// flat (heavy lift lands just under 1.0) — the guide's BOTH condition
	// means a volume-only signal cannot confirm.
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 15, 10],
			[100, 15, 10],
			[100, 15, 10],
		],
		light: [
			[100, 5, 10],
			[100, 5, 10],
			[100, 5, 10],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.equal(verdict.volumeRatio, 3);
	assert.ok(
		(verdict.heavyMeanLift ?? 9) <= 1.0,
		`heavy lift ${verdict.heavyMeanLift}`,
	);
	assert.equal(verdict.outcome, "ambiguous");
});

test("buildVerdict — single-outlier heavy week does not confirm (drop-max rule)", () => {
	// One heavy week with an extreme derived rate; the other heavy weeks match
	// light weeks. Dropping the max heavy week must kill the volume signal.
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 40, 12],
			[100, 5, 12],
			[100, 5, 12],
		],
		light: [
			[100, 5, 12],
			[100, 5, 12],
			[100, 5, 12],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.ok((verdict.volumeRatio ?? 0) >= 1.5, "raw ratio looks like skew");
	assert.ok(
		(verdict.volumeRatioDropMax ?? 9) < 1.3,
		"drop-max exposes the outlier",
	);
	assert.notEqual(verdict.outcome, "confirmed-skew");
});

test("buildVerdict — proportional heavy and light weeks are no real skew", () => {
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 5, 12],
			[100, 5, 13],
			[100, 5, 12],
		],
		light: [
			[100, 5, 12],
			[100, 5, 11],
			[100, 5, 12],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.equal(verdict.outcome, "no-real-skew");
});

test("buildVerdict — rows join label, volume, share, and lift per week", () => {
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 10, 12],
			[100, 10, 12],
			[100, 10, 12],
		],
		light: [
			[100, 10, 12],
			[100, 10, 12],
			[100, 10, 12],
		],
	});
	const verdict = buildVerdict(timeline, census, probe);
	assert.equal(verdict.rows.length, 6);
	const row = verdict.rows[0];
	assert.equal(row.label, "heavy");
	assert.equal(row.hotBufferMsgs, 100);
	assert.equal(row.derived, 10);
	assert.equal(row.derivedPer100, 10);
	// 110 of 660 dated resources, 12 of 72 slots ⇒ lift 1.
	assert.equal(row.corpusShare, 0.1667);
	assert.equal(row.resultShare, 0.1667);
	assert.equal(row.lift, 1);
});

test("buildVerdict — census weeks missing from the timeline are label unknown", () => {
	const { census, probe } = verdictInputs({
		heavy: [[100, 5, 12]],
		light: [[100, 5, 12]],
	});
	const verdict = buildVerdict([], census, probe);
	assert.ok(verdict.rows.every((r) => r.label === "unknown"));
	assert.equal(verdict.outcome, "insufficient-data");
});

test("parseSkewArgs — no phase flags means the full audit", () => {
	const args = parseSkewArgs([]);
	assert.equal(args.mood && args.census && args.probe, true);
	assert.equal(args.json, false);
	assert.equal(args.probeLimit, 25);
	assert.equal(args.snapshotLimit, 200);
});

test("parseSkewArgs — individual phases, json, and overrides", () => {
	const mood = parseSkewArgs(["--mood"]);
	assert.deepEqual([mood.mood, mood.census, mood.probe], [true, false, false]);

	const args = parseSkewArgs([
		"--census",
		"--probe",
		"-o",
		"json",
		"--user",
		"alice",
		"--probe-limit",
		"10",
		"--snapshot-limit",
		"50",
	]);
	assert.deepEqual([args.mood, args.census, args.probe], [false, true, true]);
	assert.equal(args.json, true);
	assert.equal(args.user, "alice");
	assert.equal(args.probeLimit, 10);
	assert.equal(args.snapshotLimit, 50);
});

test("parseSkewArgs — rejects unknown flags and malformed values", () => {
	assert.throws(() => parseSkewArgs(["--nope"]), /unknown argument/);
	assert.throws(
		() => parseSkewArgs(["-o", "csv"]),
		/unsupported output format/,
	);
	assert.throws(
		() => parseSkewArgs(["--probe-limit", "zero"]),
		/positive integer/,
	);
	assert.throws(() => parseSkewArgs(["--user"]), /requires a value/);
});

test("formatSnapshotReview — summaries only under the content opt-in", () => {
	const classified: ClassifiedSnapshot[] = classifySnapshots([
		{
			resourceId: "s1",
			summary: "grief-soaked and tired",
			extractedAt: "2026-06-09T00:00:00Z",
		},
	]);
	const withheld = formatSnapshotReview(classified, false);
	assert.ok(
		!withheld.includes("grief-soaked"),
		"content off ⇒ summary withheld",
	);
	assert.match(withheld, /HYPERSPELL_AUDIT_CONTENT=1/);
	assert.match(withheld, /heavy/);

	const shown = formatSnapshotReview(classified, true);
	assert.ok(shown.includes("grief-soaked and tired"));
});

test("format helpers — tables carry the guide's headline columns", () => {
	const { timeline, census, probe } = verdictInputs({
		heavy: [
			[100, 10, 12],
			[100, 10, 12],
			[100, 10, 12],
		],
		light: [
			[100, 10, 12],
			[100, 10, 12],
			[100, 10, 12],
		],
	});
	assert.match(
		formatMoodTimeline(timeline),
		/week\s+snapshots\s+heavy\s+light/,
	);
	const censusOut = formatCensus(census);
	assert.match(censusOut, /snapshot resources visible via memories.list: no/);
	assert.match(censusOut, /dated: 660\/660/);
	const verdictOut = formatVerdict(buildVerdict(timeline, census, probe));
	assert.match(verdictOut, /msgs\(hot_buffer\)/);
	assert.match(verdictOut, /OUTCOME: no-real-skew/);
	assert.match(verdictOut, /volume ratio/);
});
