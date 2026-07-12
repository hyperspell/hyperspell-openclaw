import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SearchResult } from "../client.ts";
import { matchFixture, parseFixtures } from "./eval-matchers.ts";

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

test("parseFixtures — skips blanks and // comments, parses fixtures", () => {
	const jsonl = [
		"// header comment",
		"",
		'{ "query": "q1", "expectedTitleContains": "hot buffer" }',
		"  ",
		'{ "query": "q2", "expectedResourceId": "abc", "skip": true }',
	].join("\n");
	const fixtures = parseFixtures(jsonl);
	assert.equal(fixtures.length, 2);
	assert.equal(fixtures[0].query, "q1");
	assert.equal(fixtures[1].skip, true);
});

test("parseFixtures — rejects invalid JSON and matcher-less lines with line numbers", () => {
	assert.throws(() => parseFixtures("{ nope"), /line 1: invalid JSON/);
	assert.throws(
		() => parseFixtures('{ "query": "no matcher" }'),
		/line 1: at least one of/,
	);
	assert.throws(
		() => parseFixtures('{ "expectedResourceId": "x" }'),
		/line 1: "query" is required/,
	);
});

test("matchFixture — id match wins and is reported as 'id'", () => {
	const r = mk({ resourceId: "pHAe7atPhSmMdw", title: "Hot Buffer Notes" });
	assert.equal(
		matchFixture(r, {
			query: "q",
			expectedResourceId: "pHAe7atPhSmMdw",
			expectedTitleContains: "hot buffer",
		}),
		"id",
	);
});

test("matchFixture — OR semantics: wrong id still passes via title, reported as 'title'", () => {
	const r = mk({ resourceId: "NEW-ID-after-resync", title: "Hot Buffer Notes" });
	assert.equal(
		matchFixture(r, {
			query: "q",
			expectedResourceId: "stale-id",
			expectedTitleContains: "hot buffer",
		}),
		"title",
	);
});

test("matchFixture — title matcher scans highlights, case-insensitive", () => {
	const r = mk({
		title: "Unnamed Conversation",
		highlights: [{ id: "h1", score: 0.5, text: "we fixed the Hot Buffer metadata trap" }],
	});
	assert.equal(
		matchFixture(r, { query: "q", expectedTitleContains: "hot buffer" }),
		"title",
	);
	assert.equal(
		matchFixture(r, { query: "q", expectedTitleContains: "cold buffer" }),
		null,
	);
});
