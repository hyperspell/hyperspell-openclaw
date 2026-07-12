import type { SearchResult } from "../client.ts";

/**
 * Fixture matching for the live retrieval eval harness
 * (docs/proposals/17-retrieval-eval-harness.md §3.1) — extracted here so the
 * pure logic joins the hermetic unit suite while the live runner
 * (scripts/eval-retrieval.ts) stays out of `npm test`.
 */

/** One line of docs/eval/retrieval-fixtures.jsonl. */
export type RetrievalFixture = {
	query: string;
	/** Exact match on resourceId — precise but churns on memory-sync re-upload. */
	expectedResourceId?: string;
	/** Case-insensitive substring of title or any highlight — survives re-syncs. */
	expectedTitleContains?: string;
	note?: string;
	addedAt?: string;
	/** Park a fixture without deleting it. */
	skip?: boolean;
};

/**
 * Parse the JSONL fixture file: one JSON object per line; blank lines and
 * `//` comment lines are ignored. Every fixture needs a query and at least
 * one matcher — a matcher-less line would vacuously fail and look like a
 * ranking problem, so reject it at parse time with the line number.
 */
export function parseFixtures(jsonl: string): RetrievalFixture[] {
	const fixtures: RetrievalFixture[] = [];
	for (const [idx, line] of jsonl.split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("//")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`fixtures line ${idx + 1}: invalid JSON`);
		}
		const f = parsed as Partial<RetrievalFixture>;
		if (typeof f.query !== "string" || f.query.trim() === "") {
			throw new Error(`fixtures line ${idx + 1}: "query" is required`);
		}
		if (!f.expectedResourceId && !f.expectedTitleContains) {
			throw new Error(
				`fixtures line ${idx + 1}: at least one of "expectedResourceId" / "expectedTitleContains" is required`,
			);
		}
		fixtures.push(f as RetrievalFixture);
	}
	return fixtures;
}

/**
 * OR-semantics matcher (proposal §3.1): a result satisfies a fixture if the
 * resourceId matches exactly, or the title/any highlight contains the
 * expected substring (case-insensitive). Returns WHICH matcher hit so the
 * runner can warn when only the title matched — the id may have churned.
 */
export function matchFixture(
	r: SearchResult,
	f: RetrievalFixture,
): "id" | "title" | null {
	if (f.expectedResourceId && r.resourceId === f.expectedResourceId) return "id";
	if (f.expectedTitleContains) {
		const needle = f.expectedTitleContains.toLowerCase();
		const hay = [r.title ?? "", ...r.highlights.map((h) => h.text)]
			.join(" ")
			.toLowerCase();
		if (hay.includes(needle)) return "title";
	}
	return null;
}
