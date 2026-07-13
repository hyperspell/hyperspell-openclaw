import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SearchResult } from "../client.ts";
import {
	classifyResult,
	DEFAULT_RANKING,
	explainSelection,
	kindTally,
	rerank,
	type RankedResult,
	scoreResult,
	selectRanked,
} from "./ranking.ts";

const mk = (over: Partial<SearchResult>): SearchResult => ({
	resourceId: "r1",
	title: null,
	source: "vault" as SearchResult["source"],
	score: null,
	url: null,
	createdAt: null,
	highlights: [],
	...over,
});

const UUID = "fccaa5b9-6d65-450c-94c3-a191c5de6f94";

test("classify — hot-buffer chatter: untitled / 'Unnamed Conversation' + bare session UUID", () => {
	assert.equal(classifyResult(mk({ title: "Unnamed Conversation", resourceId: UUID }), []), "chatter");
	assert.equal(classifyResult(mk({ title: null, resourceId: UUID }), []), "chatter");
});

test("classify — curated: real human title, non-UUID id", () => {
	assert.equal(
		classifyResult(mk({ title: "2026-02-09 — Writing Notes", resourceId: "mem-writing-notes" }), []),
		"curated",
	);
});

test("classify — story: matches a story term (title or highlight)", () => {
	assert.equal(
		classifyResult(mk({ title: "writing — The Lady of Storms", resourceId: "x" }), ["lady of storms"]),
		"story",
	);
	assert.equal(
		classifyResult(
			mk({ title: "notes", resourceId: "x", highlights: [{ id: "h", text: "the Omuerta magic system", score: 0.5 }] }),
			["omuerta"],
		),
		"story",
	);
});

test("classify — story matching requires word boundaries: short terms don't match inside words", () => {
	// The substring-era false positives (proposal 01 §3.2): "ada" ⊂ "adaptation",
	// "mira" ⊂ "admiral"/"miracle". Boundary matching rejects all three.
	assert.notEqual(classifyResult(mk({ title: "notes on adaptation strategy", resourceId: "x" }), ["ada"]), "story");
	assert.notEqual(classifyResult(mk({ title: "the admiral's log", resourceId: "x" }), ["mira"]), "story");
	assert.notEqual(classifyResult(mk({ title: "a small miracle", resourceId: "x" }), ["mira"]), "story");
	// ...while true whole-word occurrences still classify as story.
	assert.equal(classifyResult(mk({ title: "Ada's chapter", resourceId: "x" }), ["ada"]), "story");
});

test("classify — story terms match across punctuation boundaries: possessives and hyphenation", () => {
	// Boundaries are word↔non-word transitions, so punctuation adjacent to the
	// term is fine: "Mira's" and "mira-class" both contain the word "mira".
	assert.equal(classifyResult(mk({ title: "Mira's confrontation, draft 2", resourceId: "x" }), ["mira"]), "story");
	assert.equal(classifyResult(mk({ title: "the mira-class vessels", resourceId: "x" }), ["mira"]), "story");
});

test("classify — story matching is case-insensitive and reaches highlights with a null title", () => {
	const r = mk({
		title: null,
		resourceId: UUID,
		highlights: [{ id: "h", text: "THE OMUERTA rises", score: 0.4 }],
	});
	assert.equal(classifyResult(r, ["Omuerta"]), "story");
});

test("classify — multi-word phrase terms still match under boundary rules", () => {
	assert.equal(
		classifyResult(mk({ title: "re: the lady of storms, ch. 4", resourceId: "x" }), ["lady of storms"]),
		"story",
	);
});

test("classify — phrase terms don't match across the seam of two highlights", () => {
	// The \n hay separator (not space) keeps "…the lady" + "of storms…" from
	// stitching into a spurious phrase hit.
	const r = mk({
		title: null,
		resourceId: "x",
		highlights: [
			{ id: "a", text: "spoke to the lady", score: 0.4 },
			{ id: "b", text: "of storms there were many", score: 0.4 },
		],
	});
	assert.notEqual(classifyResult(r, ["lady of storms"]), "story");
});

test("rerank — story term beats chatter at EQUAL base relevance", () => {
	// The core promise of idea #1: topic wins over noise when similarity ties.
	const chatterEcho = mk({
		title: "Unnamed Conversation",
		resourceId: UUID,
		score: 0.5,
		highlights: [{ id: "h", text: "we talked about writing again", score: 0.5 }],
	});
	const story = mk({
		title: null,
		resourceId: "mem-2",
		score: 0.5,
		highlights: [{ id: "h", text: "Junii finally confronts the Omuerta", score: 0.5 }],
	});
	const w = { ...DEFAULT_RANKING, storyTerms: ["omuerta"] };
	const out = rerank([chatterEcho, story], w);
	assert.equal(out[0].resourceId, "mem-2");
	// story: 0.5 + 0.15 + 0.20 = 0.85 ; chatter: 0.5 − 0.20 = 0.30
	assert.ok(Math.abs(out[0]._composite - 0.85) < 1e-9);
	assert.ok(Math.abs(out[1]._composite - 0.3) < 1e-9);
});

test("rerank + selectRanked — corpus: populated storyTerms lift the manuscript above louder chatter (#82)", () => {
	// Realistic pool: paraphrasing hot-buffer echoes vs sectionized manuscript
	// memories titled "<file title> — <section>" (the sync-title synergy) plus a
	// curated note. Empty storyTerms = today's inert default; populated terms
	// must put every manuscript section above every echo.
	const UUID2 = "ab34cd56-1234-4abc-8def-0123456789ab";
	const UUID3 = "cd56ef78-5678-4def-9abc-0123456789cd";
	const pool = [
		mk({
			title: "Unnamed Conversation",
			resourceId: UUID,
			score: 0.98,
			highlights: [{ id: "h", text: "the writing is going so well lately", score: 0.98 }],
		}),
		mk({
			title: "Unnamed Conversation",
			resourceId: UUID2,
			score: 0.97,
			highlights: [{ id: "h", text: "you said Mira should face the storm", score: 0.97 }],
		}),
		mk({
			title: "Unnamed Conversation",
			resourceId: UUID3,
			score: 0.96,
			highlights: [{ id: "h", text: "keep writing those chapters", score: 0.96 }],
		}),
		mk({
			title: "The Lighthouse Keeper — Chapter 3",
			resourceId: "ms-ch3",
			score: 0.55,
			highlights: [{ id: "h", text: "Mira watched the lamp gutter", score: 0.55 }],
		}),
		mk({
			title: "The Lighthouse Keeper — Chapter 4",
			resourceId: "ms-ch4",
			score: 0.52,
			highlights: [{ id: "h", text: "the shoal took the boat", score: 0.52 }],
		}),
		mk({
			title: "2026-06-01 — Plot notes",
			resourceId: "note-plot",
			score: 0.5,
			highlights: [{ id: "h", text: "ending ideas", score: 0.5 }],
		}),
	];

	// Inert default: the manuscript is merely curated (0.55 + 0.2 = 0.75) and
	// the loudest echo still takes the top slot (0.98 − 0.2 = 0.78).
	const inert = rerank(pool, DEFAULT_RANKING);
	assert.equal(inert[0].resourceId, UUID);
	assert.equal(inert[0]._kind, "chatter");
	assert.equal(inert.find((r) => r.resourceId === "ms-ch3")?._kind, "curated");
	assert.equal(inert.find((r) => r.resourceId === "ms-ch4")?._kind, "curated");

	// Populated terms (the manuscript title covers every section via the sync
	// title): both sections classify story, outrank every non-story echo, and
	// survive selection.
	const w = { ...DEFAULT_RANKING, storyTerms: ["lighthouse keeper", "mira"] };
	const out = rerank(pool, w);
	assert.equal(out.find((r) => r.resourceId === "ms-ch3")?._kind, "story");
	assert.equal(out.find((r) => r.resourceId === "ms-ch4")?._kind, "story");
	// UUID2's echo mentions "Mira" so it legitimately classifies story too
	// (story-terms precede the chatter check — risk #4, deliberately unchanged).
	assert.equal(out.find((r) => r.resourceId === UUID2)?._kind, "story");
	const sel = selectRanked(out, 5, 0.6, 2);
	const ids = sel.map((r) => r.resourceId);
	assert.ok(ids.indexOf("ms-ch3") < ids.indexOf(UUID), "chapter 3 outranks the loudest non-story echo");
	assert.ok(ids.includes("ms-ch4"), "chapter 4 survives selection");
	assert.ok(sel.filter((r) => r._kind === "chatter").length <= 2, "quota still bounds true chatter");
});

test("kindTally — counts ranked results by kind", () => {
	const list = [
		ranked("story", 0.9, "s1"),
		ranked("chatter", 0.8, "c1"),
		ranked("chatter", 0.7, "c2"),
		ranked("curated", 0.6, "k1"),
	];
	assert.deepEqual(kindTally(list), { story: 1, chatter: 2, curated: 1 });
	assert.deepEqual(kindTally([]), {});
});

test("rerank — a kept note (0.47) out-ranks a LOUDER conversation echo (0.62)", () => {
	// This is the real Alinea case: relevance alone buried the Writing Notes.
	const note = mk({
		title: "2026-02-09 — Writing Notes",
		resourceId: "mem-1",
		score: 0.47,
		highlights: [{ id: "h", text: "Heath, Junii, Tevre; the Omuerta", score: 0.47 }],
	});
	const echo = mk({
		title: "Unnamed Conversation",
		resourceId: UUID,
		score: 0.62,
		highlights: [{ id: "h", text: "you have the book inside you", score: 0.62 }],
	});
	const ranked = rerank([echo, note], DEFAULT_RANKING);
	assert.equal(ranked[0].resourceId, "mem-1", "curated note rises above the louder echo");
	assert.ok(ranked[0]._composite > ranked[1]._composite);
	// note: 0.47 + 0.20 = 0.67 ; echo: 0.62 − 0.20 = 0.42
	assert.ok(Math.abs(ranked[0]._composite - 0.67) < 1e-9);
	assert.ok(Math.abs(ranked[1]._composite - 0.42) < 1e-9);
});

test("rerank — the story gets the strongest lift", () => {
	const story = mk({
		title: "writing — The Lady of Storms",
		resourceId: "s1",
		score: 0.5,
		highlights: [{ id: "h", text: "the Omuerta", score: 0.5 }],
	});
	const { kind, composite } = scoreResult(story, { ...DEFAULT_RANKING, storyTerms: ["lady of storms"] });
	assert.equal(kind, "story");
	assert.ok(composite >= 0.5 + DEFAULT_RANKING.storyBoost);
});

const ranked = (kind: RankedResult["_kind"], composite: number, id: string): RankedResult => ({
	...mk({ resourceId: id }),
	_kind: kind,
	_base: composite,
	_composite: composite,
});

test("selectRanked — caps chatter at the quota regardless of score, keeps real memory", () => {
	// 4 high-scoring echoes + 1 curated; quota=2 must let only 2 echoes through.
	const list = [
		ranked("chatter", 0.9, "c1"),
		ranked("chatter", 0.85, "c2"),
		ranked("chatter", 0.8, "c3"),
		ranked("curated", 0.7, "k1"),
		ranked("chatter", 0.65, "c4"),
	];
	const sel = selectRanked(list, 10, 0.6, 2);
	assert.equal(sel.filter((r) => r._kind === "chatter").length, 2, "no more than 2 chatter");
	assert.ok(sel.some((r) => r._kind === "curated"), "real memory still surfaces");
	assert.deepEqual(sel.map((r) => r.resourceId), ["c1", "c2", "k1"]);
});

test("selectRanked — drops below-threshold and honors maxResults", () => {
	const list = [ranked("curated", 0.9, "a"), ranked("curated", 0.8, "c"), ranked("other", 0.5, "b")];
	const sel = selectRanked(list, 1, 0.6, 2);
	assert.equal(sel.length, 1, "maxResults respected");
	assert.equal(sel[0].resourceId, "a");
});

// Pre-refactor selectRanked, copied verbatim as the behavior-identity oracle:
// selectRanked is now derived from explainSelection (proposal 02 §3a) and must
// select the exact same set. Domain note: maxResults >= 1 — the old loop's
// check-after-push let ONE item through at maxResults 0, but a 0 config also
// makes the candidate fetch limit 0, so that input is unreachable in prod.
function legacySelectRanked(
	list: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): RankedResult[] {
	const out: RankedResult[] = [];
	let chatter = 0;
	for (const r of list) {
		if (r._composite < threshold) continue;
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) continue;
			chatter++;
		}
		out.push(r);
		if (out.length >= maxResults) break;
	}
	return out;
}

test("explainSelection — behavior identity: selected set matches the pre-refactor selectRanked on varied pools", () => {
	const pools: RankedResult[][] = [
		[],
		// echo flood around the quota
		[
			ranked("chatter", 0.9, "c1"),
			ranked("chatter", 0.85, "c2"),
			ranked("chatter", 0.8, "c3"),
			ranked("curated", 0.7, "k1"),
			ranked("chatter", 0.65, "c4"),
		],
		// below-threshold tail + maxResults pressure
		[ranked("curated", 0.9, "a"), ranked("curated", 0.8, "c"), ranked("other", 0.5, "b")],
		// all four kinds straddling the threshold
		[
			ranked("story", 0.95, "s1"),
			ranked("chatter", 0.9, "c1"),
			ranked("curated", 0.61, "k1"),
			ranked("chatter", 0.6, "c2"),
			ranked("other", 0.6, "o1"),
			ranked("chatter", 0.59, "c3"),
			ranked("curated", 0.4, "k2"),
		],
		// chatter-only pool (quota and cap interact)
		[
			ranked("chatter", 0.7, "c1"),
			ranked("chatter", 0.7, "c2"),
			ranked("chatter", 0.7, "c3"),
			ranked("chatter", 0.7, "c4"),
		],
	];
	const params: Array<[number, number, number]> = [
		[10, 0.6, 2],
		[1, 0.6, 2],
		[3, 0.6, 0],
		[2, 0.5, 1],
		[4, 0.7, 3],
	];
	for (const pool of pools) {
		for (const [max, thr, quota] of params) {
			const label = `pool=[${pool.map((r) => r.resourceId)}] max=${max} thr=${thr} quota=${quota}`;
			const expected = legacySelectRanked(pool, max, thr, quota);
			assert.deepEqual(selectRanked(pool, max, thr, quota), expected, `selectRanked ${label}`);
			assert.deepEqual(
				explainSelection(pool, max, thr, quota)
					.filter((e) => e.selected)
					.map((e) => e.result),
				expected,
				`explainSelection ${label}`,
			);
		}
	}
});

test("explainSelection — annotates every candidate; selected entries carry cut null", () => {
	const list = [ranked("curated", 0.9, "a"), ranked("other", 0.5, "b")];
	const ex = explainSelection(list, 10, 0.6, 2);
	assert.equal(ex.length, list.length, "one entry per candidate, ranked order");
	assert.deepEqual(ex.map((e) => e.result.resourceId), ["a", "b"]);
	assert.deepEqual(ex.map((e) => e.cut), [null, "threshold"]);
});

test("explainSelection — sub-threshold is 'threshold' even when the maxResults cap is already full", () => {
	const list = [ranked("curated", 0.9, "a"), ranked("curated", 0.8, "b"), ranked("curated", 0.5, "low")];
	const ex = explainSelection(list, 1, 0.6, 2);
	assert.deepEqual(ex.map((e) => e.cut), [null, "max-results", "threshold"]);
});

test("explainSelection — third chatter item with quota 2 is cut by 'chatter-quota' (the quota was the binding constraint)", () => {
	// The proposal-03 ask: distinguish "quota bound" from threshold/maxResults cuts.
	const list = [
		ranked("chatter", 0.9, "c1"),
		ranked("chatter", 0.85, "c2"),
		ranked("chatter", 0.8, "c3"),
		ranked("curated", 0.7, "k1"),
	];
	const ex = explainSelection(list, 10, 0.6, 2);
	assert.deepEqual(ex.map((e) => e.cut), [null, null, "chatter-quota", null]);
	assert.deepEqual(
		ex.filter((e) => e.selected).map((e) => e.result.resourceId),
		["c1", "c2", "k1"],
	);
});

test("explainSelection — above-threshold item past maxResults is 'max-results'", () => {
	const list = [ranked("curated", 0.9, "a"), ranked("curated", 0.8, "b"), ranked("curated", 0.7, "c")];
	const ex = explainSelection(list, 2, 0.6, 2);
	assert.deepEqual(ex.map((e) => e.cut), [null, null, "max-results"]);
});

test("explainSelection — chatter past a full maxResults cap reads 'max-results', not 'chatter-quota'", () => {
	// It would have been cut regardless of the quota, so the quota wasn't
	// binding for it — proposal 03 §3.2's correctness property.
	const list = [ranked("curated", 0.9, "k1"), ranked("chatter", 0.8, "c1")];
	const ex = explainSelection(list, 1, 0.6, 2);
	assert.deepEqual(ex.map((e) => e.cut), [null, "max-results"]);
});

test("explainSelection — quota 0 cuts every above-threshold chatter as 'chatter-quota'", () => {
	const list = [ranked("chatter", 0.9, "c1"), ranked("chatter", 0.8, "c2"), ranked("curated", 0.7, "k1")];
	const ex = explainSelection(list, 10, 0.6, 0);
	assert.deepEqual(ex.map((e) => e.cut), ["chatter-quota", "chatter-quota", null]);
});
