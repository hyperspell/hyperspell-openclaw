import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SearchResult } from "../client.ts";
import {
	classifyResult,
	DEFAULT_RANKING,
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
