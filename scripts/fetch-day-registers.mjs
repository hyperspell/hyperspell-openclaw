#!/usr/bin/env node
// fetch-day-registers.mjs — print the emotional-state registers whose
// extracted_at falls on a given DAY (local time), for external reconciliation
// against a nightly synthesis. Read-only; zero dependencies.
//
// See docs/emotional-state-external-reconciliation.md for the full contract.
// Endpoint facts verified live 2026-07-07; note that GET responses carry only
// the five plain fields — stored metadata is NOT echoed (#116).
//
// Usage:
//   HYPERSPELL_API_KEY=... [HYPERSPELL_USER_ID=...] [REL_ID=...] \
//     node scripts/fetch-day-registers.mjs 2026-07-06

const { HYPERSPELL_API_KEY, HYPERSPELL_USER_ID, REL_ID } = process.env;
const day = process.argv[2]; // e.g. "2026-07-06"

if (!HYPERSPELL_API_KEY || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
	console.error(
		"Usage: HYPERSPELL_API_KEY=... [HYPERSPELL_USER_ID=...] [REL_ID=...] node scripts/fetch-day-registers.mjs YYYY-MM-DD",
	);
	process.exit(1);
}

const url = new URL("https://api.hyperspell.com/emotional-state/recent");
if (REL_ID) url.searchParams.set("relationship_id", REL_ID);
url.searchParams.set("limit", "20"); // server-side max — days older than the last 20 registers are unreachable

const headers = { Authorization: `Bearer ${HYPERSPELL_API_KEY}` };
if (HYPERSPELL_USER_ID) headers["X-As-User"] = HYPERSPELL_USER_ID;

const res = await fetch(url, { headers });
if (!res.ok) throw new Error(`GET /emotional-state/recent -> ${res.status}`);
const all = (await res.json()) ?? [];

// A "day" is a local-time concept for a nightly consolidator; extracted_at is
// UTC — the Date comparison below applies this machine's timezone boundary.
const start = new Date(`${day}T00:00:00`); // local midnight
const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

// GET has no status field: drop pending-extraction placeholders (raw
// role-prefixed transcripts) the same way hooks/emotional-state.ts does.
const isPendingPlaceholder = (s) => /(^|\n)\s*(user|assistant)\s*:/i.test(s ?? "");

const registers = all.filter((r) => {
	const t = new Date(r.extracted_at);
	return t >= start && t < end && !isPendingPlaceholder(r.summary);
});

// registers[] is what your nightly synthesis compares its own day-read against.
console.log(JSON.stringify(registers, null, 2));
