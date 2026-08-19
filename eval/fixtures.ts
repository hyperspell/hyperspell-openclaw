import type { SearchResult } from "../client.ts";
import { DEFAULT_RANKING } from "../lib/ranking.ts";
import type { EvalCase } from "./harness.ts";

/**
 * Synthetic, deterministic memory pools shaped like real retrieval moments:
 * hot-buffer conversation echoes (bare session UUIDs, "Unnamed Conversation"
 * titles), curated notes/journals, story/manuscript sections, and the odd
 * unclassifiable row. All scores and timestamps are fixed — no Date.now(),
 * no randomness — so two runs always produce byte-identical output.
 *
 * Score conventions used below (DEFAULT_RANKING):
 *   curated  -> base + 0.20            story -> base + 0.15 + 0.20
 *   chatter  -> base - 0.20            other -> base (untouched)
 */
const FIXED_CREATED_AT = "2026-06-01T12:00:00Z";

// Bare session UUIDs — combined with an untitled/"Unnamed Conversation" title
// these classify as chatter (hot-buffer conversation fragments).
const UUID_A = "3f2c9d1e-8a4b-4c6d-9e0f-1a2b3c4d5e6f";
const UUID_B = "7b8e2f40-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID_C = "9d0f4a62-3e4f-4a5b-9c0d-1e2f3a4b5c6d";
const UUID_D = "5a1b3c85-6d7e-4f80-91a2-b3c4d5e6f708";

function make(over: Partial<SearchResult> & { resourceId: string }): SearchResult {
	return {
		title: null,
		source: "vault",
		score: null,
		url: null,
		createdAt: FIXED_CREATED_AT,
		metaSource: null,
		metaSpeakerRole: null,
		metaFilePath: null,
		highlights: [],
		...over,
	};
}

/** A hot-buffer conversation echo: "Unnamed Conversation" + session UUID. */
function chatter(uuid: string, score: number, text: string): SearchResult {
	return make({
		resourceId: uuid,
		title: "Unnamed Conversation",
		score,
		highlights: [{ id: "h1", score, text }],
	});
}

/** A deliberately-kept memory: real human title, non-UUID resource id. */
function curated(
	id: string,
	title: string,
	score: number,
	text: string,
): SearchResult {
	return make({
		resourceId: id,
		title,
		score,
		highlights: [{ id: "h1", score, text }],
	});
}

/** Curated fixture with an explicit age — for the recency-decay cases, dated
 * relative to the harness clock (EVAL_NOW == FIXED_CREATED_AT). */
function curated2(
	id: string,
	title: string,
	score: number,
	text: string,
	createdAt: string,
): SearchResult {
	return { ...curated(id, title, score, text), createdAt };
}

/** Chatter fixture with an explicit age — see curated2. */
function chatter2(
	uuid: string,
	score: number,
	text: string,
	createdAt: string,
): SearchResult {
	return { ...chatter(uuid, score, text), createdAt };
}

export const EVAL_CASES: EvalCase[] = [
	{
		name: "production defaults: kept note beats a louder chatter echo",
		note:
			"The original Alinea failure: relevance alone buried the Writing Notes " +
			"under a re-saved conversation fragment. With shipped defaults " +
			"(threshold 0.6) the boosted note (0.47 -> 0.67) is injected and the " +
			"penalized echo (0.62 -> 0.42) is dropped entirely.",
		pool: [
			chatter(UUID_A, 0.62, "you have the book inside you"),
			curated(
				"note-writing-2026-02-09",
				"2026-02-09 — Writing Notes",
				0.47,
				"Heath, Junii, Tevre; the Omuerta",
			),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustSelect: ["note-writing-2026-02-09"],
			mustNotSelect: [UUID_A],
		},
	},
	{
		name: "low threshold: echo may inform, but ranks below the kept note",
		note:
			"Same pool with threshold 0.35: both clear the bar, but the composite " +
			"puts the note (0.67) above the raw-louder echo (0.42).",
		pool: [
			chatter(UUID_A, 0.62, "you have the book inside you"),
			curated(
				"note-writing-2026-02-09",
				"2026-02-09 — Writing Notes",
				0.47,
				"Heath, Junii, Tevre; the Omuerta",
			),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.35,
		expect: {
			mustSelect: ["note-writing-2026-02-09", UUID_A],
			order: [["note-writing-2026-02-09", UUID_A]],
		},
	},
	{
		name: "chatter quota caps echoes regardless of score",
		note:
			"Four high-similarity echoes all clear the threshold; quota 2 lets only " +
			"the top two through, and freed slots flow to quieter real memory " +
			"(the 'other' row at 0.45) instead of more chatter.",
		pool: [
			chatter(UUID_A, 0.95, "we should call it The Ruler"),
			chatter(UUID_B, 0.9, "the ruler idea again"),
			chatter(UUID_C, 0.85, "measuring retrieval, remember?"),
			chatter(UUID_D, 0.8, "that eval thing"),
			curated(
				"journal-2026-05-30",
				"Journal — 2026-05-30",
				0.56,
				"decided the eval harness measures selection, not vibes",
			),
			// Untitled but non-UUID id -> "other": no boost, no penalty.
			make({
				resourceId: "import-untitled-clip",
				score: 0.45,
				highlights: [{ id: "h1", score: 0.45, text: "clipped reference text" }],
			}),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.4,
		expect: {
			mustSelect: ["journal-2026-05-30", UUID_A, UUID_B, "import-untitled-clip"],
			mustNotSelect: [UUID_C, UUID_D],
			order: [["journal-2026-05-30", UUID_A]],
		},
	},
	{
		name: "penalty drops a borderline echo below the threshold entirely",
		note:
			"Raw relevance says echo (0.65) > note (0.35); the pipeline says the " +
			"opposite: echo 0.65 - 0.2 = 0.45 < 0.5 is cut, note 0.35 + 0.2 = 0.55 " +
			"clears. Also pins CURRENT behavior: the threshold applies to the " +
			"COMPOSITE, so curation boost can lift a below-threshold base over it.",
		pool: [
			chatter(UUID_B, 0.65, "dreamy echo of the same phrase"),
			curated(
				"note-quiet-truth",
				"Quiet true note",
				0.35,
				"the actual decision, recorded once",
			),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.5,
		expect: {
			mustSelect: ["note-quiet-truth"],
			mustNotSelect: [UUID_B],
		},
	},
	{
		name: "story terms give the strongest lift (title match)",
		note:
			"The active manuscript gets storyBoost + curationBoost (0.5 -> 0.85), " +
			"outranking a higher-base journal (0.6 -> 0.8); the echo (0.7 -> 0.5) " +
			"is cut by the 0.6 threshold.",
		pool: [
			chatter(UUID_C, 0.7, "we talked about storms once"),
			curated(
				"journal-2026-05-30",
				"Journal — 2026-05-30",
				0.6,
				"long day, wrote nothing",
			),
			curated(
				"story-lady-of-storms-ch3",
				"The Lady of Storms — Chapter 3",
				0.5,
				"Tevre watched the harbor drown",
			),
		],
		weights: { ...DEFAULT_RANKING, storyTerms: ["lady of storms"] },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustSelect: ["story-lady-of-storms-ch3", "journal-2026-05-30"],
			mustNotSelect: [UUID_C],
			order: [["story-lady-of-storms-ch3", "journal-2026-05-30"]],
		},
	},
	{
		name: "story term matched in highlight text, not title",
		note:
			"classifyResult scans highlights too: a blandly-titled note whose " +
			"highlight mentions the Omuerta is story (0.4 -> 0.75) and outranks a " +
			"plain curated note with a higher base (0.5 -> 0.7).",
		pool: [
			curated(
				"note-threads",
				"notes on threads",
				0.4,
				"the Omuerta magic system binds debts",
			),
			curated(
				"note-misc",
				"misc notes",
				0.5,
				"grocery-adjacent planning",
			),
		],
		weights: { ...DEFAULT_RANKING, storyTerms: ["omuerta"] },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustSelect: ["note-threads", "note-misc"],
			order: [["note-threads", "note-misc"]],
		},
	},
	{
		name: "word-boundary story matching: short terms don't false-positive inside words",
		note:
			"Boundary semantics (proposal 01 §3.2): storyTerm 'mira' no longer " +
			"substring-matches 'admiral', so the admiral log stays curated " +
			"(0.5 -> 0.7) while Mira's chapter — possessive, still a word " +
			"boundary — is story (0.45 -> 0.8) and outranks it. Under the old " +
			"substring matcher the admiral log was story (0.85) and won.",
		pool: [
			curated(
				"note-admiral",
				"the admiral's log",
				0.5,
				"fleet logistics and rations",
			),
			curated(
				"story-mira-ch2",
				"Mira's chapter — the storm",
				0.45,
				"Mira watched the lamp gutter",
			),
		],
		weights: { ...DEFAULT_RANKING, storyTerms: ["mira"] },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustSelect: ["story-mira-ch2", "note-admiral"],
			order: [["story-mira-ch2", "note-admiral"]],
		},
	},
	{
		name: "null doc score is backed by the best highlight score",
		note:
			"baseScore = max(doc score, best highlight): a synced section with " +
			"score null but a 0.72 highlight ranks from 0.72 (-> 0.92 curated), " +
			"above a 0.65-base note (-> 0.85).",
		pool: [
			make({
				resourceId: "memory-section-ruler",
				title: "MEMORY.md — The Ruler",
				score: null,
				highlights: [
					{ id: "h1", score: 0.72, text: "eval harness measures the selected set" },
					{ id: "h2", score: 0.31, text: "lower-scored sibling highlight" },
				],
			}),
			curated("note-adjacent", "Adjacent note", 0.65, "related but weaker"),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustSelect: ["memory-section-ruler", "note-adjacent"],
			order: [["memory-section-ruler", "note-adjacent"]],
		},
	},
	{
		name: "titled row keyed by a UUID is 'other': no boost, no penalty",
		note:
			"Only real-title + non-UUID ids earn the curation boost. A titled row " +
			"under a bare UUID stays at base (0.55) and is outranked by a true " +
			"curated note with a lower base (0.45 -> 0.65).",
		pool: [
			make({
				resourceId: UUID_D,
				title: "Imported transcript",
				score: 0.55,
				highlights: [{ id: "h1", score: 0.55, text: "imported body text" }],
			}),
			curated("note-kept", "Kept note", 0.45, "deliberately kept"),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.4,
		expect: {
			mustSelect: ["note-kept", UUID_D],
			order: [["note-kept", UUID_D]],
		},
	},
	{
		name: "maxResults caps the selection at the top composites",
		note: "Six qualifying notes, three slots: exactly the top three survive.",
		pool: [
			curated("note-1", "Note 1", 0.9, "one"),
			curated("note-2", "Note 2", 0.85, "two"),
			curated("note-3", "Note 3", 0.8, "three"),
			curated("note-4", "Note 4", 0.75, "four"),
			curated("note-5", "Note 5", 0.7, "five"),
			curated("note-6", "Note 6", 0.65, "six"),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 3,
		threshold: 0.5,
		expect: {
			mustSelect: ["note-1", "note-2", "note-3"],
			mustNotSelect: ["note-4", "note-5", "note-6"],
			order: [
				["note-1", "note-2"],
				["note-2", "note-3"],
			],
		},
	},
	{
		name: "quota-skipped chatter does not consume result slots",
		note:
			"maxResults 3, quota 1: the #2-ranked echo is skipped by the quota and " +
			"its slot passes DOWN to quieter curated memory instead of being burned. " +
			"Composites: c1 0.78 > c2 0.74 (skipped) > k1 0.72 > k2 0.70 > k3 0.68.",
		pool: [
			chatter(UUID_A, 0.98, "loudest echo"),
			chatter(UUID_B, 0.94, "second echo"),
			curated("note-k1", "Kept 1", 0.52, "kept one"),
			curated("note-k2", "Kept 2", 0.5, "kept two"),
			curated("note-k3", "Kept 3", 0.48, "kept three"),
		],
		weights: { ...DEFAULT_RANKING, chatterQuota: 1 },
		maxResults: 3,
		threshold: 0.4,
		expect: {
			mustSelect: [UUID_A, "note-k1", "note-k2"],
			mustNotSelect: [UUID_B, "note-k3"],
			order: [[UUID_A, "note-k1"]],
		},
	},
	{
		name: "nothing clears the bar: empty selection, no injection",
		note:
			"When no composite reaches the threshold, selectRanked returns [] and " +
			"auto-context injects nothing (no ambient banner).",
		pool: [
			chatter(UUID_C, 0.55, "vague echo"),
			curated("note-weak", "Weak note", 0.3, "barely related"),
			make({
				resourceId: "import-weak",
				score: 0.4,
				highlights: [{ id: "h1", score: 0.4, text: "unclassified row" }],
			}),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 10,
		threshold: 0.6,
		expect: {
			mustNotSelect: [UUID_C, "note-weak", "import-weak"],
		},
	},
	{
		name: "elbow cutoff: the narrow query stops at the cliff instead of padding with near-noise",
		note:
			"Proposal 13's core case: three genuinely relevant results (0.82/0.80/" +
			"0.78 composite) then a cliff to a plateau of marginal 0.55-ish results " +
			"that still clear the threshold. With elbow enabled (minResults 3, " +
			"gapRatio 2.5, minGap 0.05) selection stops at 3; without it the " +
			"plateau pads the context to maxResults. Elbow ships OFF by default — " +
			"this case opts in explicitly, exactly like a tuned live config.",
		pool: [
			curated("note-a", "Heath and Junii — the confrontation", 0.62, "Heath confronts Junii at the tower"),
			curated("note-b", "Omuerta binding notes", 0.6, "what the binding cost Tevre"),
			curated("note-c", "Night of storms — draft", 0.58, "the storm scene as written"),
			curated("pad-1", "Weather small talk", 0.35, "it rained again on Tuesday"),
			curated("pad-2", "Errands list", 0.34, "post office then the market"),
			curated("pad-3", "Old bookmark", 0.33, "an article about lighthouses"),
		],
		weights: {
			...DEFAULT_RANKING,
			elbow: { enabled: true, minResults: 3, gapRatio: 2.5, minGap: 0.05 },
		},
		maxResults: 6,
		threshold: 0.5,
		expect: {
			mustSelect: ["note-a", "note-b", "note-c"],
			mustNotSelect: ["pad-1", "pad-2", "pad-3"],
			order: [["note-a", "note-c"]],
		},
	},
	{
		name: "near-duplicate dedup: the re-saved memory yields its slot to different content",
		note:
			"Proposal 09's core case: the same memory exists as a synced doc section " +
			"AND a remembered note — both curated, both clear every gate, and " +
			"pre-dedup the copy displaced the one genuinely different memory. With " +
			"dedupThreshold 0.8 the second copy (date-prefixed, so not string-equal) " +
			"is skipped with continue and the quieter distinct note fills the slot.",
		pool: [
			curated(
				"doc-omuerta",
				"The Lady of Storms — Omuerta notes",
				0.62,
				"Heath finally confronts Junii about the Omuerta binding and what it cost Tevre on the night of storms",
			),
			curated(
				"note-omuerta-copy",
				"2026-02-09 — remembered",
				0.6,
				"2026-02-09 — Heath finally confronts Junii about the Omuerta binding and what it cost Tevre on the night of storms",
			),
			curated(
				"note-grocery",
				"Household notes",
				0.55,
				"Grocery run Thursday; Alinea prefers oat milk and dark rye",
			),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 2,
		threshold: 0.5,
		expect: {
			mustSelect: ["doc-omuerta", "note-grocery"],
			mustNotSelect: ["note-omuerta-copy"],
			order: [["doc-omuerta", "note-grocery"]],
		},
	},
	{
		name: "source weights: the journaled page outranks the same-topic titled aside",
		note:
			"Proposal 11's core case: a Notion doc and a Slack message with the SAME " +
			"title and relevance 0.60 both classify curated and tie exactly under " +
			"default weights. sourceWeights { notion: 1.15, slack: 0.85 } breaks the " +
			"tie by provenance: notion 0.60×1.15+0.20=0.890 > slack 0.60×0.85+0.20=" +
			"0.710. Slack-first input proves reordering.",
		pool: [
			make({
				resourceId: "slack-C042-p1699",
				title: "Q3 retrieval roadmap",
				source: "slack",
				score: 0.6,
				highlights: [{ id: "h1", score: 0.6, text: "roadmap thoughts in passing" }],
			}),
			make({
				resourceId: "notion-roadmap",
				title: "Q3 retrieval roadmap",
				source: "notion",
				score: 0.6,
				highlights: [{ id: "h1", score: 0.6, text: "the authored roadmap page" }],
			}),
		],
		weights: { ...DEFAULT_RANKING, sourceWeights: { notion: 1.15, slack: 0.85 } },
		maxResults: 5,
		threshold: 0.6,
		expect: {
			mustSelect: ["notion-roadmap", "slack-C042-p1699"],
			order: [["notion-roadmap", "slack-C042-p1699"]],
		},
	},
	{
		name: "recency: the fresh near-tie beats the stale one (proposal 07's core case)",
		note:
			"Two curated notes at identical relevance 0.60; one 2 days old, one 2 " +
			"years old (vs the harness clock EVAL_NOW). Recency breaks the tie " +
			"toward the current note: fresh 0.60+0.20−0.001=0.799 > stale " +
			"0.60+0.20−0.050=0.750. Stale-first input proves reordering.",
		pool: [
			curated2("note-stale", "Editor config", 0.6, "uses emacs bindings", "2024-05-31T12:00:00Z"),
			curated2("note-fresh", "Editor config", 0.6, "switched to vim bindings", "2026-05-30T12:00:00Z"),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 5,
		threshold: 0.6,
		expect: {
			mustSelect: ["note-fresh", "note-stale"],
			order: [["note-fresh", "note-stale"]],
		},
	},
	{
		name: "recency: an old kept truth still beats fresh shallow chatter (the risk case)",
		note:
			"The load-bearing guard on the 90-day/0.1-cap/0.5-curated defaults: a " +
			"2-year-old curated note (0.55+0.20−0.050=0.700) must still outrank a " +
			"1-day-old louder echo (0.62−0.20−0.001=0.419). If tuning ever flips " +
			"this, the half-life or cap is wrong — recency must never hand chatter " +
			"back the advantage the penalty/quota took away.",
		pool: [
			chatter2(UUID_D, 0.62, "you should write something today", "2026-05-31T12:00:00Z"),
			curated2("note-truth", "2024-06-01 — Writing Notes", 0.55, "Heath, Junii, Tevre; the Omuerta", "2024-06-01T12:00:00Z"),
		],
		weights: { ...DEFAULT_RANKING },
		maxResults: 5,
		threshold: 0.35,
		expect: {
			mustSelect: ["note-truth", UUID_D],
			order: [["note-truth", UUID_D]],
		},
	},
];
