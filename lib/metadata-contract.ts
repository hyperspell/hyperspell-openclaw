/**
 * The writer/reader handshake for every metadata key this plugin writes.
 *
 * Origin (Fable review + A Linea, 2026-08-24): every failure in that review
 * batch was a key-name or classification mismatch between a writer and a
 * reader — bare `source` vs `openclaw_source` (the emotional-state rows that
 * could never be excluded or classified), `openclaw_tool` written since
 * January and read by nothing, speaker labels that turned conversation echoes
 * into quota-exempt "documents", a mood wrapper absent from the sanitizer's
 * strip list. None of it was algorithmic; six writers and four readers agreed
 * on meanings informally and nothing checked the handshake. This module is
 * the check: the contract test (metadata-contract.test.ts) verifies that
 * every declared writer and reader file really references its key, that every
 * key HAS a reader (or an explicit external justification), and that no
 * `openclaw_`-prefixed token exists in source outside this registry.
 *
 * Rules for adding a key:
 *  - New plugin-owned metadata keys MUST use the `openclaw_` prefix — the
 *    drift scan only discovers prefixed tokens, so an unprefixed key evades
 *    it (that's how `source: "openclaw_agent_end"` hid for months).
 *  - Every key needs a reader. "Nothing reads it yet" is allowed ONLY as an
 *    explicit `{ external: "..." }` entry naming who consumes it and why —
 *    an honest IOU instead of a silent one.
 */

export type MetadataKeyContract = {
	/** What the key means, in one line. */
	meaning: string;
	/** Repo-relative source files that write the key. */
	writtenIn: string[];
	/** Repo-relative source files that read the key, or the external
	 * consumer that does (scripts, backend, operator tooling). */
	readIn: string[] | { external: string };
};

/** Values (not keys) that legitimately match the openclaw_ token scan. */
export const KNOWN_METADATA_VALUES = [
	// Legacy `source` surface tags — written since the initial release,
	// now read back by client.ts writerOf() as the retroactive authorship
	// fallback (openclaw_tool = the agent's remember tool, openclaw_command =
	// the user's /remember slash command).
	"openclaw_tool",
	"openclaw_command",
	// Legacy bare-`source` value on emotional-state rows; read only by the
	// mood-skew audit's bucketing. New rows also carry openclaw_source.
	"openclaw_agent_end",
] as const;

export const METADATA_CONTRACT: Record<string, MetadataKeyContract> = {
	openclaw_source: {
		meaning:
			"Write-pipeline origin tag — THE retrieval discriminator (exclude filter, chatter/process classification, audit bucketing)",
		writtenIn: [
			"client.ts", // addMemory ("command") and sendTrace ("agent_end")
			"hooks/hot-buffer.ts",
			"hooks/mood-weather.ts",
			"hooks/emotional-state.ts",
			"sync/markdown.ts",
		],
		readIn: [
			"client.ts", // echoed into SearchResult.metaSource
			"lib/filters.ts", // excludeFilterFor
			"lib/ranking.ts", // classifyResult via metaSource constants
			"lib/mood-skew-audit.ts",
			"graph/ops.ts", // mood_weather rows skipped by the KG scan
		],
	},
	openclaw_writer: {
		meaning:
			'Authorship stamp: "agent" | "user". Ranking routes agent-authored rows to the neutral process kind (2026-08-24)',
		writtenIn: [
			"tools/remember.ts", // "agent"
			"commands/slash.ts", // "user"
			"hooks/emotional-state.ts", // "agent"
		],
		readIn: ["client.ts"], // writerOf() → SearchResult.metaWriter → ranking
	},
	openclaw_speaker_role: {
		meaning:
			"Per-row speaker role on hot-buffer writes; presence alone marks a conversation row for classification",
		writtenIn: ["hooks/hot-buffer.ts"],
		readIn: ["client.ts"], // metaSpeakerRole → ranking's chatter rule
	},
	openclaw_speaker_name: {
		meaning: "Per-row speaker display label on hot-buffer writes",
		writtenIn: ["hooks/hot-buffer.ts"],
		readIn: {
			external:
				"Operator forensics on raw rows (attribution debugging, issues #58/#59) — no runtime reader; row-level only, unions arbitrarily under consolidation so it MUST NOT be read at resource level",
		},
	},
	openclaw_session_id: {
		meaning:
			"Session the row/trace came from — mirrored into metadata because listMemories does not expose the first-class field",
		writtenIn: ["hooks/hot-buffer.ts", "hooks/auto-trace.ts"],
		readIn: ["lib/mood-skew-audit.ts"], // resourceWeek date fallback; also purge tooling
	},
	openclaw_channel_id: {
		meaning:
			"Conversation/channel the row came from — quarantine-time identity parity for purge-channel",
		writtenIn: [
			"hooks/hot-buffer.ts",
			"hooks/auto-trace.ts",
			"hooks/emotional-state.ts",
			"tools/remember.ts",
		],
		readIn: ["commands/purge-channel.ts"],
	},
	openclaw_user: {
		meaning: "Resolved memory owner on multi-user writes",
		writtenIn: ["client.ts"],
		readIn: ["lib/sender.ts"], // scope filter construction
	},
	openclaw_scope: {
		meaning: "Visibility scope on scoped writes (private/family/…)",
		writtenIn: ["client.ts"],
		readIn: ["lib/sender.ts"], // buildScopeFilter
	},
	openclaw_sync_source: {
		meaning:
			"Which watchPath a synced memory came from (memory/ vs labeled external roots)",
		writtenIn: ["sync/markdown.ts"],
		readIn: {
			external:
				"Operator queries / future per-root retrieval weighting — additive key; openclaw_source stays the pipeline discriminator (see sync/markdown.ts comment)",
		},
	},
	// ---- unprefixed keys (legacy / shared-convention). The drift scan cannot
	// discover these — that is exactly why new keys must take the prefix. ----
	source: {
		meaning:
			"LEGACY write-surface tag (openclaw_tool / openclaw_command / openclaw_agent_end) — predates openclaw_source; kept for audit bucketing of historical rows and as writerOf()'s retroactive authorship fallback",
		writtenIn: [
			"tools/remember.ts",
			"commands/slash.ts",
			"hooks/emotional-state.ts",
		],
		readIn: ["client.ts", "lib/mood-skew-audit.ts"],
	},
	file_path: {
		meaning:
			"Workspace file a synced section came from — keys per-file cap, processPaths, and entity-file detection",
		writtenIn: ["sync/markdown.ts"],
		readIn: ["client.ts", "lib/ranking.ts", "graph/ops.ts"],
	},
	file_name: {
		meaning: "Basename of the synced file (display/debugging)",
		writtenIn: ["sync/markdown.ts"],
		readIn: {
			external: "Operator/vault-export forensics — no runtime reader",
		},
	},
	section_title: {
		meaning: "Heading of the synced section (display/debugging)",
		writtenIn: ["sync/markdown.ts"],
		readIn: {
			external: "Operator/vault-export forensics — no runtime reader",
		},
	},
	content_hash: {
		meaning:
			"Hash of the section content at write time; sync change-detection state lives in the local sync state file, not read back from the backend",
		writtenIn: ["sync/markdown.ts"],
		readIn: {
			external:
				"Backend-side idempotency / operator forensics — runtime dedup uses the local sync state file",
		},
	},
	graph_entity: {
		meaning:
			"Marks a synced entity file so the Memory Network scan never re-feeds its own output",
		writtenIn: ["sync/markdown.ts"],
		readIn: ["graph/ops.ts"],
	},
	channelId: {
		meaning:
			"Medium the emotional register was extracted from (voice/Discord/DM)",
		writtenIn: ["hooks/emotional-state.ts"],
		readIn: {
			external:
				"Analysis/debugging only — #74 register channel signal, deliberately not surfaced at runtime",
		},
	},
};
