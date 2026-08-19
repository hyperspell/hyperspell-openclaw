import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_RANKING } from "../lib/ranking.ts";
import { EVAL_CASES } from "./fixtures.ts";
import { type EvalCase, runCase } from "./harness.ts";

// The regression gate: every eval case must pass against the REAL pipeline
// (rerank + selectRanked). A ranking/weight change that flips a case shows up
// here as a named failure with the full selected-set diff.
for (const c of EVAL_CASES) {
	test(`eval: ${c.name}`, () => {
		const r = runCase(c);
		assert.deepEqual(
			r.failures,
			[],
			`\n${c.name}\n${c.note}\n\n${r.failures.join("\n")}`,
		);
	});
}

test("eval cases have unique names (JSON diffs key on them)", () => {
	const names = EVAL_CASES.map((c) => c.name);
	assert.equal(new Set(names).size, names.length);
});

// Harness self-check (proposal §4 test plan #2): a deliberately-wrong
// expectation MUST fail — proves the harness can't be fooled into passing
// everything.
test("harness reports failures for wrong expectations", () => {
	const c: EvalCase = {
		name: "self-check",
		note: "deliberately wrong",
		pool: [
			{
				resourceId: "note-real",
				title: "Real note",
				source: "vault",
				score: 0.9,
				url: null,
				createdAt: "2026-06-01T12:00:00Z",
				metaSource: null,
				metaSpeakerRole: null,
				metaFilePath: null,
				highlights: [{ id: "h1", score: 0.9, text: "real" }],
			},
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.5,
		expect: {
			mustSelect: ["zzz-no-such-memory-zzz"],
			mustNotSelect: ["note-real"],
			order: [["note-real", "zzz-no-such-memory-zzz"]],
		},
	};
	const r = runCase(c);
	// One failure per violated expectation + the selection diff footer.
	assert.equal(r.failures.length, 4);
	assert.ok(r.failures[0].includes("zzz-no-such-memory-zzz"));
	assert.ok(r.failures[1].includes('NOT in selected set'));
	assert.ok(r.failures[2].includes("order"));
});
