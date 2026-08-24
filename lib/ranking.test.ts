import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SearchResult } from "../client.ts";
import {
	classifyResult,
	DEFAULT_RANKING,
	DEFAULT_ELBOW,
	explainSelection,
	kindTally,
	nearDuplicate,
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
	metaSource: null,
	metaSpeakerRole: null,
	metaFilePath: null,
	metaWriter: null,
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

// ---- recency decay (proposal 07) ----

const NOW = Date.parse("2026-07-01T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

test("recency — same relevance, different ages: the fresh curated note ranks first (#66's case)", () => {
	const old = mk({ title: "Editor config", resourceId: "old", score: 0.6, createdAt: daysAgo(730) });
	const fresh = mk({ title: "Editor config", resourceId: "fresh", score: 0.6, createdAt: daysAgo(2) });
	// Old-first input: the assertion proves reordering, not input order.
	const out = rerank([old, fresh], DEFAULT_RANKING, NOW);
	assert.deepEqual(out.map((r) => r.resourceId), ["fresh", "old"]);
	// Curated gap ≈ maxPenalty × curatedFactor × (decay(2d) − decay(730d)) ≈ 0.049
	const gap = out[0]._composite - out[1]._composite;
	assert.ok(gap > 0.045 && gap < 0.055, `expected ~0.049 gap, got ${gap}`);
});

test("recency — old-but-still-true curated beats shallow-but-recent chatter (the risk case)", () => {
	const truth = mk({ title: "2024-06-01 — Writing Notes", resourceId: "note", score: 0.55, createdAt: daysAgo(730) });
	const echo = mk({
		title: "Unnamed Conversation",
		resourceId: UUID,
		score: 0.62,
		createdAt: daysAgo(1),
		highlights: [{ id: "h", text: "you have the book inside you", score: 0.62 }],
	});
	const out = rerank([echo, truth], DEFAULT_RANKING, NOW);
	assert.equal(out[0].resourceId, "note", "aged kept truth still outranks the fresh echo");
	// note: 0.55 + 0.2 − ~0.05 ≈ 0.70 ; echo: 0.62 − 0.2 − ~0.001 ≈ 0.42
	assert.ok(Math.abs(out[0]._composite - 0.7) < 0.005);
	assert.ok(Math.abs(out[1]._composite - 0.419) < 0.005);
});

test("recency — createdAt null or unparseable: no penalty (fail open)", () => {
	const base = { title: "A note", resourceId: "n", score: 0.6 };
	const atNow = scoreResult(mk({ ...base, createdAt: new Date(NOW).toISOString() }), DEFAULT_RANKING, NOW);
	const noDate = scoreResult(mk({ ...base, createdAt: null }), DEFAULT_RANKING, NOW);
	const badDate = scoreResult(mk({ ...base, createdAt: "not-a-date" }), DEFAULT_RANKING, NOW);
	assert.equal(noDate.composite, atNow.composite);
	assert.equal(badDate.composite, atNow.composite);
});

test("recency — halfLife 0 or maxPenalty 0 disables the term exactly", () => {
	const ancient = mk({ title: "A note", resourceId: "n", score: 0.6, createdAt: daysAgo(3650) });
	const off1 = scoreResult(ancient, { ...DEFAULT_RANKING, recencyHalfLifeDays: 0 }, NOW);
	const off2 = scoreResult(ancient, { ...DEFAULT_RANKING, recencyMaxPenalty: 0 }, NOW);
	// Today's exact formula: 0.6 + curationBoost 0.2
	assert.equal(off1.composite, 0.8);
	assert.equal(off2.composite, 0.8);
});

test("recency — the cap holds: an arbitrarily old result loses at most recencyMaxPenalty", () => {
	const relic = mk({ title: null, resourceId: UUID, score: 0.6, createdAt: daysAgo(365 * 50) });
	const { composite } = scoreResult(relic, DEFAULT_RANKING, NOW);
	const penalty = 0.6 - DEFAULT_RANKING.chatterPenalty - composite;
	// 1e-9 tolerance: the penalty is reconstructed by float subtraction here.
	assert.ok(penalty <= DEFAULT_RANKING.recencyMaxPenalty + 1e-9, "never exceeds the cap");
	assert.ok(penalty > 0.099, "asymptotically close to the cap");
});

test("recency — kept memory ages at the curated factor (half the chatter penalty)", () => {
	const at = daysAgo(365);
	const curatedNote = mk({ title: "Kept note", resourceId: "k", score: 0.6, createdAt: at });
	const echo = mk({ title: "Unnamed Conversation", resourceId: UUID, score: 0.6, createdAt: at });
	const curPenalty = 0.6 + DEFAULT_RANKING.curationBoost - scoreResult(curatedNote, DEFAULT_RANKING, NOW).composite;
	const chatPenalty = 0.6 - DEFAULT_RANKING.chatterPenalty - scoreResult(echo, DEFAULT_RANKING, NOW).composite;
	assert.ok(Math.abs(curPenalty - chatPenalty * DEFAULT_RANKING.recencyCuratedFactor) < 1e-9);
});

test("recency — future timestamps clamp to zero age: no accidental boost", () => {
	const base = { title: "A note", resourceId: "n", score: 0.6 };
	const future = scoreResult(mk({ ...base, createdAt: daysAgo(-1) }), DEFAULT_RANKING, NOW);
	const present = scoreResult(mk({ ...base, createdAt: new Date(NOW).toISOString() }), DEFAULT_RANKING, NOW);
	assert.equal(future.composite, present.composite);
});

// ---- source weighting (proposal 11) ----

test("sourceWeights — identical title+relevance: unweighted ties, weighted differentiates", () => {
	const notionDoc = mk({
		title: "Q3 retrieval roadmap",
		resourceId: "notion-abc123",
		source: "notion" as SearchResult["source"],
		score: 0.6,
	});
	const slackAside = mk({
		title: "Q3 retrieval roadmap",
		resourceId: "slack-C042-p1699",
		source: "slack" as SearchResult["source"],
		score: 0.6,
	});

	// Default {}: both classify curated, exact composite tie (today's behavior).
	const plain = rerank([slackAside, notionDoc], DEFAULT_RANKING);
	assert.ok(Math.abs(plain[0]._composite - plain[1]._composite) < 1e-9);

	// Weighted: the Notion doc clearly outranks the same-topic Slack aside.
	const w = { ...DEFAULT_RANKING, sourceWeights: { notion: 1.15, slack: 0.85 } };
	const out = rerank([slackAside, notionDoc], w);
	assert.equal(out[0].source, "notion");
	// notion: 0.6×1.15 + 0.2 = 0.89 ; slack: 0.6×0.85 + 0.2 = 0.71
	assert.ok(Math.abs(out[0]._composite - 0.89) < 1e-9);
	assert.ok(Math.abs(out[1]._composite - 0.71) < 1e-9);
	// _base stays the unweighted relevance for debuggability.
	assert.equal(out[0]._base, 0.6);
});

test("sourceWeights — unlisted and unknown sources default to neutral 1.0", () => {
	const w = { ...DEFAULT_RANKING, sourceWeights: { notion: 1.15 } };
	const vaultNote = mk({ title: "Writing Notes", resourceId: "mem-1", score: 0.5 }); // source: vault, unlisted
	const future = mk({
		title: "Linear ticket",
		resourceId: "lin-1",
		source: "linear" as SearchResult["source"], // a source this plugin has never heard of
		score: 0.5,
	});
	for (const r of [vaultNote, future]) {
		const { composite } = scoreResult(r, w);
		assert.ok(Math.abs(composite - (0.5 + w.curationBoost)) < 1e-9, "weight is exactly 1.0");
	}
});

test("sourceWeights — weight multiplies base only: kind adjustments keep their magnitude", () => {
	// Pins the multiplier-on-base decision (proposal 11 §3.1): a slack 0.8
	// weight must NOT shrink the chatterPenalty for slack results.
	const echo = mk({
		title: "Unnamed Conversation",
		resourceId: UUID,
		source: "slack" as SearchResult["source"],
		score: 0.5,
	});
	const w = { ...DEFAULT_RANKING, sourceWeights: { slack: 0.8 } };
	const { composite } = scoreResult(echo, w);
	// 0.5×0.8 − 0.2 = 0.20 — the full penalty, not 0.8× of it.
	assert.ok(Math.abs(composite - (0.5 * 0.8 - DEFAULT_RANKING.chatterPenalty)) < 1e-9);
});

test("sourceWeights — empty map is a strict no-op (default behavior unchanged)", () => {
	const r = mk({ title: "A note", resourceId: "n", score: 0.47 });
	const { composite } = scoreResult(r, DEFAULT_RANKING);
	assert.ok(Math.abs(composite - 0.67) < 1e-9, "0.47 + 0.2, bit-identical to pre-weighting");
});

// ---- diversity / near-duplicate dedup (proposal 09) ----

const rankedH = (
	kind: RankedResult["_kind"],
	composite: number,
	id: string,
	text: string,
): RankedResult => ({
	...mk({ resourceId: id, title: `note ${id}`, highlights: [{ id: "h", text, score: composite }] }),
	_kind: kind,
	_base: composite,
	_composite: composite,
});

const THEME =
	"Heath finally confronts Junii about the Omuerta binding and what it cost Tevre on the night of storms";

test("selectRanked — five near-identical curated hits: default-off floods, dedup collapses to one", () => {
	const five = [
		rankedH("curated", 0.9, "d1", THEME),
		rankedH("curated", 0.88, "d2", `2026-02-09 — ${THEME}`),
		rankedH("curated", 0.86, "d3", `${THEME}. She kept the letter.`),
		rankedH("curated", 0.84, "d4", THEME.replace("finally", "at last")),
		rankedH("curated", 0.82, "d5", THEME),
	];
	// Backward compat: the omitted parameter reproduces today's flood exactly.
	assert.equal(selectRanked(five, 4, 0.6, 2).length, 4, "status quo floods the slots");
	const sel = selectRanked(five, 4, 0.6, 2, 0.8);
	assert.equal(sel.length, 1);
	assert.equal(sel[0].resourceId, "d1", "highest-ranked copy wins");
});

test("selectRanked — freed slot goes to genuinely different lower-scored content", () => {
	const list = [
		rankedH("curated", 0.9, "d1", THEME),
		rankedH("curated", 0.88, "d2", `2026-02-09 — ${THEME}`),
		rankedH("curated", 0.86, "d3", `${THEME}. She kept the letter.`),
		rankedH("curated", 0.7, "k1", "Grocery run Thursday; Alinea prefers oat milk and dark rye"),
	];
	const sel = selectRanked(list, 2, 0.6, 2, 0.8);
	assert.deepEqual(
		sel.map((r) => r.resourceId),
		["d1", "k1"],
		"duplicates are skipped with continue, not break — k1 fills the freed slot",
	);
});

test("selectRanked — a diversity-skipped chatter item does not consume chatter quota", () => {
	const list = [
		rankedH("chatter", 0.9, "c1", THEME),
		rankedH("chatter", 0.88, "c2", `${THEME}.`), // near-dup of c1 → diversity-skipped
		rankedH("chatter", 0.86, "c3", "we argued about whether the sandbox should allow git push"),
		rankedH("curated", 0.7, "k1", "Grocery run Thursday; Alinea prefers oat milk and dark rye"),
	];
	const sel = selectRanked(list, 10, 0.6, 2, 0.8);
	// If the quota were charged before the dedup skip, c2 would burn slot 2 and c3 would be blocked.
	assert.deepEqual(sel.map((r) => r.resourceId), ["c1", "c3", "k1"]);
	assert.equal(sel.filter((r) => r._kind === "chatter").length, 2);
});

test("selectRanked — over-quota chatter does not shadow later results in the dedup set", () => {
	const list = [
		rankedH("chatter", 0.9, "c1", "morning chatter about coffee and half-remembered dreams"),
		rankedH("chatter", 0.88, "c2", "afternoon chatter about trains and the queue at the station"),
		rankedH("chatter", 0.86, "c3", THEME), // over quota (quota=2) → skipped, key NOT recorded
		rankedH("curated", 0.8, "k1", THEME), // must still be accepted
	];
	const sel = selectRanked(list, 10, 0.6, 2, 0.8);
	assert.deepEqual(sel.map((r) => r.resourceId), ["c1", "c2", "k1"]);
});

test("explainSelection — cut attribution: duplicate reads 'near-duplicate'; past a full cap it reads 'max-results'", () => {
	const dupWithinCap = [
		rankedH("curated", 0.9, "d1", THEME),
		rankedH("curated", 0.88, "d2", `${THEME}.`),
	];
	assert.deepEqual(
		explainSelection(dupWithinCap, 5, 0.6, 2, 0.8).map((e) => e.cut),
		[null, "near-duplicate"],
	);
	// Cap already full: the dup would have been cut regardless — the cap, not
	// the dedup, was the binding constraint (same semantics as chatter-quota).
	const dupPastCap = [
		rankedH("curated", 0.9, "a", "an entirely different first memory about the garden"),
		rankedH("curated", 0.88, "d2", `${THEME}.`),
		rankedH("curated", 0.86, "d3", THEME),
	];
	assert.deepEqual(
		explainSelection(dupPastCap, 1, 0.6, 2, 0.8).map((e) => e.cut),
		[null, "max-results", "max-results"],
	);
});

test("nearDuplicate — containment counts, tiny keys require equality, 0 disables", () => {
	assert.ok(nearDuplicate(THEME, `${THEME} and more happened after, much more, that evening`, 0.8));
	assert.ok(!nearDuplicate("the writing notes", THEME, 0.8), "short key needs exact match");
	assert.ok(!nearDuplicate(THEME, THEME, 0), "threshold 0 disables");
	assert.ok(nearDuplicate("The Writing Notes!", "the writing notes", 0.8), "tiny keys: exact set equality matches");
	assert.ok(!nearDuplicate("", THEME, 0.8), "empty key never duplicates");
});

// ---- elbow cutoff (proposal 13) ----

const ELBOW = { enabled: true, minResults: 3, gapRatio: 2.5, minGap: 0.05 };

test("selectRanked — elbow: stops at a clear score cliff before maxResults", () => {
	const list = [
		ranked("curated", 0.85, "a"),
		ranked("curated", 0.82, "b"),
		ranked("curated", 0.8, "c"),
		ranked("other", 0.55, "d"), // gap 0.25 vs meanGap 0.025 → cliff
		ranked("other", 0.53, "e"),
		ranked("other", 0.52, "f"),
	];
	const sel = selectRanked(list, 10, 0.4, 2, 0, ELBOW);
	assert.deepEqual(sel.map((r) => r.resourceId), ["a", "b", "c"]);
	// Attribution: everything past the cliff reads "elbow".
	const ex = explainSelection(list, 10, 0.4, 2, 0, ELBOW);
	assert.deepEqual(ex.map((e) => e.cut), [null, null, null, "elbow", "elbow", "elbow"]);
});

test("selectRanked — elbow: gradual decline falls through to maxResults/threshold unchanged", () => {
	const list = [0.85, 0.8, 0.75, 0.7, 0.65, 0.6].map((s, i) => ranked("curated", s, `g${i}`));
	const withElbow = selectRanked(list, 5, 0.4, 2, 0, ELBOW);
	const without = selectRanked(list, 5, 0.4, 2);
	assert.deepEqual(withElbow, without, "no cliff → byte-identical selection");
	assert.equal(withElbow.length, 5, "still fills to maxResults");
});

test("selectRanked — elbow: minResults floor holds even across a huge early gap", () => {
	const list = [
		ranked("curated", 0.95, "a"),
		ranked("curated", 0.4, "b"), // 0.55 drop — but floor not met yet
		ranked("curated", 0.38, "c"),
		ranked("curated", 0.37, "d"),
	];
	const sel = selectRanked(list, 10, 0.3, 2, 0, ELBOW);
	assert.ok(sel.length >= 3, "never cut below the floor");
	assert.deepEqual(sel.slice(0, 3).map((r) => r.resourceId), ["a", "b", "c"]);
});

test("selectRanked — elbow: flat plateau never fires (minGap guards the meanGap-0 case)", () => {
	const list = ["a", "b", "c", "d", "e"].map((id) => ranked("curated", 0.7, id));
	const sel = selectRanked(list, 5, 0.4, 2, 0, ELBOW);
	assert.equal(sel.length, 5, "meanGap 0 makes the ratio test trivially true; minGap still blocks");
});

test("selectRanked — elbow: a cliff sitting exactly at the floor fires on the first eligible check", () => {
	const list = [
		ranked("curated", 0.85, "a"),
		ranked("curated", 0.84, "b"),
		ranked("curated", 0.83, "c"),
		ranked("other", 0.5, "d"), // first check at kept==3 — fires immediately
	];
	const sel = selectRanked(list, 10, 0.4, 2, 0, ELBOW);
	assert.deepEqual(sel.map((r) => r.resourceId), ["a", "b", "c"]);
});

test("selectRanked — elbow disabled or omitted: behavior identical to today", () => {
	const list = [
		ranked("curated", 0.85, "a"),
		ranked("curated", 0.82, "b"),
		ranked("curated", 0.8, "c"),
		ranked("other", 0.55, "d"),
	];
	const plain = selectRanked(list, 10, 0.4, 2);
	assert.deepEqual(selectRanked(list, 10, 0.4, 2, 0, { ...ELBOW, enabled: false }), plain);
	assert.deepEqual(selectRanked(list, 10, 0.4, 2, 0, DEFAULT_ELBOW), plain, "shipped default is off");
	assert.equal(plain.length, 4);
});

// ---- origin-aware classification + per-file diversity (scale report 2026-08-18) ----

test("classify — origin metadata beats the title heuristic: a consolidator-TITLED hot-buffer resource is still chatter", () => {
	// Titled + non-UUID id would read curated under the shape heuristic — the
	// exact loophole that hands conversation echoes the curation boost.
	const titledEcho = mk({
		resourceId: "consolidated-session-77",
		title: "Tuesday planning chat",
		metaSource: "hot_buffer",
	});
	assert.equal(classifyResult(titledEcho, []), "chatter");
	assert.equal(classifyResult(mk({ ...titledEcho, metaSource: "agent_end" }), []), "chatter");
});

test("classify — agent-authored writes route to process: the agent never holds the curation boost on its own notes", () => {
	// A titled, non-UUID remember-tool note — pre-2026-08 this classified
	// curated (+0.2, half-speed decay): the author-blind classifier.
	const agentNote = { title: "Plugin deploy checklist", resourceId: "aB3xYz9", metaWriter: "agent" as const };
	assert.equal(classifyResult(mk(agentNote), []), "process");
	// The user's /remember writes KEEP the boost.
	assert.equal(classifyResult(mk({ ...agentNote, metaWriter: "user" }), []), "curated");
	// Unstamped legacy rows fail OPEN to the title heuristic — never punish
	// missing data (same rule as recencyPenalty and sourceWeight).
	assert.equal(classifyResult(mk({ ...agentNote, metaWriter: null }), []), "curated");
});

test("classify — authorship routing yields to stronger evidence: story and chatter outrank the writer stamp", () => {
	// Story match wins regardless of writer (deliberate: storyTerms protect
	// the manuscript; flagged for the tuning window, not changed here).
	assert.equal(
		classifyResult(mk({ title: "Mira notes", resourceId: "aB3xYz9", metaWriter: "agent" }), ["mira"]),
		"story",
	);
	// Conversation-origin evidence wins: an agent-writer row tagged hot_buffer
	// is chatter (penalized), not process (neutral).
	assert.equal(
		classifyResult(mk({ title: "t", resourceId: "aB3xYz9", metaWriter: "agent", metaSource: "hot_buffer" }), []),
		"chatter",
	);
});

test("classify — emotional_state origin tag routes to process (C1 future-proofing: register prose must never classify curated if the backend ever indexes that store)", () => {
	assert.equal(
		classifyResult(mk({ title: "Register: warm, tired", resourceId: "aB3xYz9", metaSource: "emotional_state" }), []),
		"process",
	);
});

test("classify — processPaths marks the agent's own synced files as process, case-insensitively", () => {
	const r = mk({
		resourceId: "ws-abc123",
		title: "thoughts-log — part 33",
		metaSource: "memory_sync_section",
		metaFilePath: "/Users/x/workspace/Thoughts-Log.md",
	});
	assert.equal(classifyResult(r, [], ["thoughts-log.md"]), "process");
	// Same result without the config match stays curated (titled, non-UUID).
	assert.equal(classifyResult(r, [], ["brainstem/"]), "curated");
	assert.equal(classifyResult(r, []), "curated");
});

test("classify — story terms still win over process (operator terms are the strongest signal)", () => {
	const r = mk({
		resourceId: "ws-abc123",
		title: "thoughts-log — Omuerta notes",
		metaFilePath: "/ws/thoughts-log.md",
	});
	assert.equal(classifyResult(r, ["omuerta"], ["thoughts-log.md"]), "story");
});

test("scoreResult — process is neutral: no curation boost, full-speed recency decay", () => {
	const now = Date.parse("2026-08-18T00:00:00Z");
	const old = "2026-02-18T00:00:00Z"; // ~183 days: two half-lives at the default 90
	const w = { ...DEFAULT_RANKING, processPaths: ["thoughts-log.md"] };
	const curated = scoreResult(
		mk({ resourceId: "note-1", title: "Journal", score: 0.8, createdAt: old }),
		w,
		now,
	);
	const process = scoreResult(
		mk({
			resourceId: "ws-1",
			title: "thoughts-log — part 33",
			score: 0.8,
			createdAt: old,
			metaFilePath: "/ws/thoughts-log.md",
		}),
		w,
		now,
	);
	assert.equal(curated.kind, "curated");
	assert.equal(process.kind, "process");
	// Same base, but the process result gets no +0.2 boost and decays at the
	// full factor — the crowding failure inverted.
	assert.ok(curated.composite > process.composite + w.curationBoost - 1e-9);
});

const rankedFile = (
	composite: number,
	id: string,
	text: string,
	filePath: string | null,
): RankedResult => ({
	...mk({
		resourceId: id,
		title: `note ${id}`,
		metaFilePath: filePath,
		highlights: [{ id: "h", text, score: composite }],
	}),
	_kind: "curated",
	_base: composite,
	_composite: composite,
});

test("explainSelection — perFileCap: a third distinct section of one file is cut 'file-cap'; other files pass", () => {
	const list = [
		rankedFile(0.9, "s1", "the plan for the harbor market opens with three long stalls", "/ws/log.md"),
		rankedFile(0.88, "s2", "a completely different passage about winter travel by rail", "/ws/log.md"),
		rankedFile(0.86, "s3", "yet another unrelated musing on kitchen repairs and paint", "/ws/log.md"),
		rankedFile(0.84, "d1", "an independent document about the garden fence project", "/ws/other.md"),
	];
	const ex = explainSelection(list, 10, 0.5, 5, 0.8, undefined, 2);
	assert.deepEqual(
		ex.map((e) => e.cut),
		[null, null, "file-cap", null],
	);
});

test("explainSelection — perFileCap 0 (and results without a file path) never cap", () => {
	const list = [
		rankedFile(0.9, "s1", "the plan for the harbor market opens with three long stalls", "/ws/log.md"),
		rankedFile(0.88, "s2", "a completely different passage about winter travel by rail", "/ws/log.md"),
		rankedFile(0.86, "s3", "yet another unrelated musing on kitchen repairs and paint", "/ws/log.md"),
		rankedFile(0.84, "n1", "no file path on this one so the cap cannot apply", null),
	];
	assert.equal(explainSelection(list, 10, 0.5, 5, 0.8).filter((e) => e.selected).length, 4);
	const capped = explainSelection(list, 10, 0.5, 5, 0.8, undefined, 2);
	assert.equal(capped.filter((e) => e.selected).length, 3, "cap binds only the pathed file");
	assert.equal(capped[3].selected, true, "pathless result unaffected");
});

test("explainSelection — a near-duplicate cut does not charge the file slot (only selected results consume)", () => {
	const same = "Heath finally confronts Junii about the Omuerta binding and what it cost Tevre";
	const list = [
		rankedFile(0.9, "s1", same, "/ws/log.md"),
		rankedFile(0.88, "s2", same, "/ws/log.md"), // near-duplicate of s1
		rankedFile(0.86, "s3", "a completely different passage about winter travel by rail", "/ws/log.md"),
		rankedFile(0.84, "s4", "yet another unrelated musing on kitchen repairs and paint", "/ws/log.md"),
	];
	const ex = explainSelection(list, 10, 0.5, 5, 0.8, undefined, 2);
	assert.deepEqual(
		ex.map((e) => e.cut),
		[null, "near-duplicate", null, "file-cap"],
		"the dup was never charged, so s3 fits under the cap and s4 is the overflow",
	);
});

test("classify — speaker-role metadata marks a conversation row even without openclaw_source (backfilled rows)", () => {
	// Live 2026-08-18: attribution-backfilled hot rows carry openclaw_speaker_*
	// but no openclaw_source, and have content-derived titles + UUID ids —
	// the shape heuristic read them as 'other', dodging the chatter penalty.
	const backfilled = mk({
		resourceId: "a6f8d42b-ea6b-45bd-9c0d-1e2f3a4b5c6d",
		title: "[Agent]: Goodnight.",
		metaSource: null,
		metaSpeakerRole: "assistant",
	});
	assert.equal(classifyResult(backfilled, []), "chatter");
});
