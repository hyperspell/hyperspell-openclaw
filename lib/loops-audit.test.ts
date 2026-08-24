import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SearchResult } from "../client.ts";
import {
	type AuditLabel,
	type AuditRunRecord,
	buildRunRecord,
	buildVariants,
	CANDIDATE_QUERIES,
	compareVariantSets,
	countBlockBullets,
	deriveDynamicQuery,
	parseAuditArgs,
	parseJsonl,
	resolveAfter,
	summarizeAudit,
	titlesFromRecentBlock,
	toAuditRow,
} from "./loops-audit.ts";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function makeResult(overrides?: Partial<SearchResult>): SearchResult {
	return {
		resourceId: "r1",
		title: "A pending thing",
		source: "vault",
		score: 0.71239,
		metaSource: null,
		metaSpeakerRole: null,
		metaFilePath: null,
		metaWriter: null,
		url: null,
		createdAt: "2026-07-01T00:00:00.000Z",
		highlights: [{ id: "h1", score: 0.7, text: "I said I'd\nfollow up on this" }],
		...overrides,
	};
}

test("parseAuditArgs — defaults and full flag set", () => {
	assert.deepEqual(parseAuditArgs([]), { json: false, simulate: [] });
	const args = parseAuditArgs([
		"-o", "json",
		"--query", "q",
		"--limit", "5",
		"--after", "30",
		"--user", "alice",
		"--simulate", "a1, dynamic",
	]);
	assert.equal(args.json, true);
	assert.equal(args.query, "q");
	assert.equal(args.limit, 5);
	assert.equal(args.after, "30");
	assert.equal(args.user, "alice");
	assert.deepEqual(args.simulate, ["a1", "dynamic"]);
});

test("parseAuditArgs — rejects unknown flags, bad formats, bad variants", () => {
	assert.throws(() => parseAuditArgs(["--nope"]), /unknown argument/);
	assert.throws(() => parseAuditArgs(["-o", "csv"]), /unsupported output format/);
	assert.throws(() => parseAuditArgs(["--limit", "zero"]), /positive integer/);
	assert.throws(() => parseAuditArgs(["--simulate", "a3"]), /unknown --simulate variant/);
	assert.throws(() => parseAuditArgs(["--query"]), /requires a value/);
});

test("parseAuditArgs — summary mode takes ledger and labels paths", () => {
	const args = parseAuditArgs(["--summary", "ledger.jsonl", "labels.jsonl"]);
	assert.deepEqual(args.summary, { ledger: "ledger.jsonl", labels: "labels.jsonl" });
});

test("resolveAfter — day counts are relative to now, dates pass through", () => {
	assert.equal(resolveAfter("30", NOW), "2026-06-12T12:00:00.000Z");
	assert.equal(resolveAfter("2026-06-01", NOW), "2026-06-01T00:00:00.000Z");
	assert.throws(() => resolveAfter("someday", NOW), /neither a day count nor a date/);
});

test("deriveDynamicQuery — #107 shape: base + capped recent topics", () => {
	assert.equal(deriveDynamicQuery("base", []), "base");
	assert.equal(
		deriveDynamicQuery("base", ["  Venice   setup ", "", "D&D quarantine"]),
		"base — recent topics: Venice setup; D&D quarantine",
	);
	// Per-title cap (80) and total cap (300) keep the query bounded.
	const long = "x".repeat(500);
	const q = deriveDynamicQuery("base", Array.from({ length: 10 }, () => long));
	assert.ok(q.length < 500, `query stays bounded, got ${q.length}`);
	assert.ok(q.startsWith("base"));
});

test("titlesFromRecentBlock — parses both hot-buffer and trace bullet shapes", () => {
	assert.deepEqual(titlesFromRecentBlock(null), []);
	const block = [
		"<hyperspell-recent-interactions>",
		"Your last 7 days of conversations…",
		"",
		"- Venice image provider setup",
		"- [3d ago] D&D quarantine — we talked about walls",
		"</hyperspell-recent-interactions>",
	].join("\n");
	assert.deepEqual(titlesFromRecentBlock(block), [
		"Venice image provider setup",
		"D&D quarantine",
	]);
});

test("buildVariants — baseline only by default; named simulations attach", () => {
	const base = "open tasks pending";
	const plain = buildVariants(base, parseAuditArgs([]), [], NOW);
	assert.deepEqual(plain, [{ name: "baseline", query: base }]);

	const args = parseAuditArgs(["--simulate", "a1,a2,dynamic,after30,after60"]);
	const variants = buildVariants(base, args, ["Topic one"], NOW);
	assert.deepEqual(variants.map((v) => v.name), [
		"baseline", "a1", "a2", "dynamic", "after30", "after60",
	]);
	assert.equal(variants[1].query, CANDIDATE_QUERIES.a1);
	assert.equal(variants[2].query, CANDIDATE_QUERIES.a2);
	assert.equal(variants[3].query, `${base} — recent topics: Topic one`);
	assert.equal(variants[4].after, "2026-06-12T12:00:00.000Z");
	assert.equal(variants[5].after, "2026-05-13T12:00:00.000Z");
});

test("buildVariants — overridden primary is named custom, never baseline", () => {
	const variants = buildVariants("q", parseAuditArgs(["--after", "30"]), [], NOW);
	assert.equal(variants[0].name, "custom");
	assert.equal(variants[0].after, "2026-06-12T12:00:00.000Z");
});

test("toAuditRow — mirrors formatUnfinishedLoops drop rule; gates snippets", () => {
	const rendered = toAuditRow(makeResult(), 1, false);
	assert.equal(rendered.rendered, true);
	assert.equal(rendered.score, 0.7124);
	assert.ok(!("snippet" in rendered), "content off ⇒ no snippet key");

	const withContent = toAuditRow(makeResult(), 1, true);
	assert.equal(withContent.snippet, "I said I'd follow up on this");

	const dropped = toAuditRow(makeResult({ highlights: [] }), 2, true);
	assert.equal(dropped.rendered, false);
	assert.ok(!("snippet" in dropped));
});

test("buildRunRecord — rendered/wasted counts and gather cross-check", () => {
	const block = [
		"<hyperspell-unfinished-loops>",
		"Possible open threads…",
		"",
		"- A pending thing: I said I'd follow up on this",
		"</hyperspell-unfinished-loops>",
	].join("\n");
	const results = [makeResult(), makeResult({ resourceId: "r2", highlights: [] })];
	const rec = buildRunRecord({
		ts: NOW.toISOString(),
		variant: { name: "baseline", query: "q" },
		limit: 3,
		userId: undefined,
		results,
		includeContent: false,
		asInjectedBlock: block,
		gatherLoopsCount: 2,
	});
	assert.equal(rec.resultCount, 2);
	assert.equal(rec.renderedCount, 1);
	assert.equal(rec.wastedSlots, 1);
	assert.equal(rec.blockConsistent, true);
	assert.equal(rec.asInjected, null, "content off ⇒ block withheld from the record");

	const diverged = buildRunRecord({
		ts: NOW.toISOString(),
		variant: { name: "baseline", query: "q" },
		limit: 3,
		userId: undefined,
		results,
		includeContent: true,
		asInjectedBlock: block,
		gatherLoopsCount: 3, // gather saw one more result than the diagnostic call
	});
	assert.equal(diverged.blockConsistent, false);
	assert.equal(diverged.asInjected, block);

	const simulated = buildRunRecord({
		ts: NOW.toISOString(),
		variant: { name: "a1", query: "q2" },
		limit: 3,
		userId: undefined,
		results: [],
		includeContent: false,
		asInjectedBlock: null,
		gatherLoopsCount: null,
	});
	assert.equal(simulated.blockConsistent, null);
});

test("countBlockBullets", () => {
	assert.equal(countBlockBullets(null), 0);
	assert.equal(countBlockBullets("<x>\nheader\n\n- one\n- two\n</x>"), 2);
});

test("compareVariantSets — overlap and one-sided ids in rank order", () => {
	const rec = (ids: string[]): AuditRunRecord =>
		buildRunRecord({
			ts: NOW.toISOString(),
			variant: { name: "x", query: "q" },
			limit: 3,
			userId: undefined,
			results: ids.map((id) => makeResult({ resourceId: id })),
			includeContent: false,
			asInjectedBlock: null,
			gatherLoopsCount: null,
		});
	const cmp = compareVariantSets(rec(["a", "b", "c"]), rec(["c", "d"]));
	assert.deepEqual(cmp, { overlap: ["c"], onlyBaseline: ["a", "b"], onlyVariant: ["d"] });
});

test("parseJsonl — skips blanks and // comments, reports bad lines", () => {
	assert.deepEqual(parseJsonl<{ a: number }>('// note\n\n{"a":1}\n{"a":2}\n'), [
		{ a: 1 },
		{ a: 2 },
	]);
	assert.throws(() => parseJsonl("{oops"), /line 1/);
});

test("summarizeAudit — hit rate, verdicts, ages, repeat rate, paired wins", () => {
	const run = (ts: string, variant: string, ids: string[]): AuditRunRecord =>
		buildRunRecord({
			ts,
			variant: { name: variant, query: "q" },
			limit: 3,
			userId: undefined,
			results: ids.map((id) => makeResult({ resourceId: id })),
			includeContent: false,
			asInjectedBlock: null,
			gatherLoopsCount: null,
		});
	const d1 = "2026-07-10T09:00:00.000Z";
	const d2 = "2026-07-11T09:00:00.000Z";
	const records = [
		run(d1, "baseline", ["a", "b"]),
		run(d1, "a1", ["a", "c"]),
		run(d2, "baseline", ["a", "b"]),
		run(d2, "a1", ["d", "e"]),
	];
	const label = (ts: string, variant: string, resourceId: string, verdict: AuditLabel["verdict"]): AuditLabel =>
		({ ts, variant, resourceId, verdict });
	const labels = [
		label(d1, "baseline", "a", "resolved"),
		label(d1, "baseline", "b", "not-a-loop"),
		label(d1, "a1", "a", "resolved"),
		label(d1, "a1", "c", "still-open"),
		label(d2, "baseline", "a", "resolved"),
		label(d2, "baseline", "b", "not-a-loop"),
		label(d2, "a1", "d", "still-open"),
		{ ...label(d2, "a1", "e", "still-open"), snippetInsufficient: true },
	];

	const [baseline, a1] = summarizeAudit(records, labels);
	assert.equal(baseline.variant, "baseline");
	assert.equal(baseline.runs, 2);
	assert.equal(baseline.labeled, 4);
	assert.equal(baseline.hitRate, 0);
	// Both baseline runs surfaced the same {a, b} — the stuck-set signature.
	assert.equal(baseline.repeatRate, 1);
	assert.equal(baseline.pairedDays, null);

	assert.equal(a1.variant, "a1");
	assert.equal(a1.hitRate, 0.75);
	assert.deepEqual(a1.verdicts, { "still-open": 3, resolved: 1, "not-a-loop": 0 });
	assert.equal(a1.snippetInsufficient, 1);
	// a, c, d, e each seen once across 2 runs ⇒ nothing repeats.
	assert.equal(a1.repeatRate, 0);
	assert.equal(a1.pairedDays, 2);
	assert.equal(a1.pairedWins, 2);
	// created 2026-07-01, run 2026-07-10/11 ⇒ 9- and 10-day-old labeled items.
	assert.deepEqual(a1.ageDaysByVerdict["still-open"].sort(), [10, 10, 9].sort());
});
