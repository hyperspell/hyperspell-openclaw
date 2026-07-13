/**
 * The Ruler — standalone eval runner for the composite retrieval ranking.
 *
 *   node --experimental-strip-types eval/run.ts          # human table
 *   node --experimental-strip-types eval/run.ts --json   # full scored dump
 *
 * `--json` (or EVAL_JSON=1) prints the complete ranked/selected output for
 * every case as deterministic JSON — save one run before a ranking change and
 * one after, and `diff` the two files. No snapshot framework, just bytes.
 *
 * The same cases run hermetically in `npm test` via eval/eval.test.ts; this
 * entry point exists for humans tuning weights, not for CI.
 */
import { EVAL_CASES } from "./fixtures.ts";
import { type CaseResult, describeResult, runCase } from "./harness.ts";

const asJson =
	process.argv.includes("--json") || process.env.EVAL_JSON === "1";

const results: Array<{ case: (typeof EVAL_CASES)[number]; result: CaseResult }> =
	EVAL_CASES.map((c) => ({ case: c, result: runCase(c) }));
const failed = results.filter((r) => r.result.failures.length > 0);

if (asJson) {
	// Full before/after dump: config + every candidate's kind/base/composite +
	// whether it made the selected set. Key order and case order are fixed by
	// the fixtures file, so output is byte-stable across runs.
	const dump = results.map(({ case: c, result }) => {
		const selectedIds = new Set(result.selected.map((r) => r.resourceId));
		return {
			name: c.name,
			config: {
				maxResults: c.maxResults,
				threshold: c.threshold,
				weights: c.weights,
			},
			ranked: result.ranked.map((r) => ({
				resourceId: r.resourceId,
				title: r.title,
				kind: r._kind,
				base: r._base,
				composite: r._composite,
				selected: selectedIds.has(r.resourceId),
			})),
			selected: result.selected.map((r) => r.resourceId),
			pass: result.failures.length === 0,
			failures: result.failures,
		};
	});
	console.log(JSON.stringify({ cases: dump }, null, 2));
} else {
	console.log("The Ruler — retrieval ranking eval\n");
	for (const { case: c, result } of results) {
		const status = result.failures.length === 0 ? "PASS" : "FAIL";
		console.log(`${status}  ${c.name}`);
		for (const r of result.selected) {
			console.log(`        ${describeResult(r)}`);
		}
		if (result.selected.length === 0) console.log("        (nothing selected)");
		for (const f of result.failures) console.log(`      ! ${f}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) {
		console.log("re-run with --json to dump full scored output for diffing");
	}
}

process.exitCode = failed.length === 0 ? 0 : 1;
