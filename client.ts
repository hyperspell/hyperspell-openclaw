import Hyperspell from "hyperspell";
import type {
	HyperspellConfig,
	HyperspellSource,
	ScopeName,
} from "./config.ts";
import { normalizeScope } from "./config.ts";
import { dropQuarantined, overfetchLimit } from "./lib/quarantine.ts";
import { log } from "./logger.ts";

export type Highlight = {
	id: string;
	score: number;
	text: string;
};

export type SearchResult = {
	resourceId: string;
	title: string | null;
	source: HyperspellSource;
	score: number | null;
	url: string | null;
	createdAt: string | null;
	/** metadata.openclaw_source when echoed — the plugin's write-pipeline tag
	 * (hot_buffer / agent_end / memory_sync / memory_sync_section / …). Origin
	 * truth for classification: a consolidator-titled session resource still
	 * reads as a conversation echo through this, not as curated memory. */
	metaSource: string | null;
	/** metadata.openclaw_speaker_role when echoed. Only hot-buffer writes (and
	 * the attribution backfill) stamp it, so its mere presence marks a
	 * conversation row — backfilled rows verified live 2026-08-18 to carry
	 * speaker tags but NO openclaw_source, and would otherwise dodge the
	 * origin-based chatter rule. */
	metaSpeakerRole: string | null;
	/** metadata.file_path when echoed — the workspace file a synced section
	 * came from. Keys ranking's per-file diversity cap and processPaths. */
	metaFilePath: string | null;
	/** Who authored the memory's content: "agent" | "user", else null.
	 * Primary signal is the openclaw_writer stamp (written from 2026-08 on);
	 * legacy rows fall back to metadata.source, which has distinguished the
	 * agent's remember TOOL ("openclaw_tool") from the user's /remember
	 * COMMAND ("openclaw_command") since the initial release — written since
	 * January, read by nothing until now. Null = unknown, and ranking MUST
	 * fail open on null (treat as today's behavior, never strip a boost on
	 * missing data). Note the legacy signal marks the write SURFACE, not
	 * strictly authorship — good enough for retrieval weighting, not for
	 * attribution claims. */
	metaWriter: "agent" | "user" | null;
	highlights: Highlight[];
};

export type SearchWithAnswerResult = {
	answer: string | null;
	documents: SearchResult[];
};

export type TriageResult = SearchResult & {
	/** True when the resource is on the quarantineResources list — visible
	 * here (and only here) so the audit view shows what quarantine covers. */
	quarantined: boolean;
};

export type Integration = {
	id: string;
	name: string;
	provider: HyperspellSource;
	icon: string | null;
};

export type Connection = {
	id: string;
	integrationId: string;
	label: string | null;
	provider: HyperspellSource;
};

export type EmotionalStateResponse = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
  status: string
}

export type EmotionalStateLatest = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
  /**
   * Echo of store-time metadata — Postmark's `channelId` (#74), future depth
   * signals (#68). Absent until the backend echoes stored metadata on
   * emotional-state GETs (issue #116), and on legacy rows stored without it.
   */
  metadata?: Record<string, unknown>
}

const API_BASE_URL = "https://api.hyperspell.com"

/**
 * The backend metadata echo must be a plain object to map onto
 * `EmotionalStateLatest.metadata`; anything else (absent, null, array,
 * scalar) is dropped so a malformed echo can't poison callers.
 */
function isMetadataObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string metadata value by key, or null — non-strings are dropped so a
 * malformed echo can't poison classification. */
function metaString(
	metadata: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const v = metadata?.[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** Resolve authorship for SearchResult.metaWriter — openclaw_writer stamp
 * first, legacy metadata.source surface tag as the retroactive fallback. */
function writerOf(
	metadata: Record<string, unknown> | null | undefined,
): "agent" | "user" | null {
	const stamped = metaString(metadata, "openclaw_writer");
	if (stamped === "agent" || stamped === "user") return stamped;
	const legacy = metaString(metadata, "source");
	if (legacy === "openclaw_tool") return "agent";
	if (legacy === "openclaw_command") return "user";
	return null;
}

export class HyperspellClient {
	private client: Hyperspell;
	private config: HyperspellConfig;

	constructor(config: HyperspellConfig) {
		this.config = config;
		this.client = new Hyperspell({
			apiKey: config.apiKey,
			userID: config.userId,
		});
		log.info(
			`client initialized${config.userId ? ` for user ${config.userId}` : ""}`,
		);
		if (config.quarantineResources.length > 0) {
			// One startup line so an active quarantine is never invisible: it
			// changes what every retrieval path can recall.
			log.info(
				`retrieval quarantine active for ${config.quarantineResources.length} resource(s)`,
			);
		}
	}

	private rawHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey}`,
		};
		if (this.config.userId) {
			headers["X-As-User"] = this.config.userId;
		}
		return headers;
	}

	private requestOptions(userId?: string) {
		if (!userId) return undefined;
		return { headers: { "X-As-User": userId } };
	}

	async search(
		query: string,
		options?: {
			limit?: number;
			sources?: HyperspellSource[];
			after?: string;
			before?: string;
			userId?: string;
			filter?: Record<string, unknown>;
		},
	): Promise<SearchResult[]> {
		const limit = options?.limit ?? this.config.maxResults;
		const sources =
			options?.sources ??
			(this.config.sources.length > 0 ? this.config.sources : undefined);
		// Quarantined resources are dropped post-fetch (client-side by design —
		// see lib/quarantine.ts); over-fetch so the drop doesn't eat pool slots,
		// then trim back to the requested limit below.
		const quarantine = this.config.quarantineResources;
		const fetchLimit = overfetchLimit(limit, quarantine.length);

		log.debugRequest("memories.search", {
			query,
			limit,
			sources,
			after: options?.after,
			before: options?.before,
			userId: options?.userId,
			filter: options?.filter,
		});

		const response = await this.client.memories.search(
			{
				query,
				sources,
				options: {
					max_results: fetchLimit,
					...(options?.after ? { after: options.after } : {}),
					...(options?.before ? { before: options.before } : {}),
					...(options?.filter ? { filter: options.filter } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		const mapped: SearchResult[] = response.documents.map((doc) => {
			const raw = doc as typeof doc & {
				highlights?: Array<{ id: string; score: number; text: string }>;
			};
			return {
				resourceId: doc.resource_id,
				title: doc.title ?? null,
				source: doc.source as HyperspellSource,
				score: doc.score ?? null,
				url: (doc.metadata?.url as string | null) ?? null,
				createdAt: (doc.metadata?.created_at as string | null) ?? null,
				metaSource: metaString(doc.metadata, "openclaw_source"),
				metaSpeakerRole: metaString(doc.metadata, "openclaw_speaker_role"),
				metaFilePath: metaString(doc.metadata, "file_path"),
			metaWriter: writerOf(doc.metadata),
				highlights: (raw.highlights ?? []).map((h) => ({
					id: h.id,
					score: h.score,
					text: h.text,
				})),
			};
		});
		const results = dropQuarantined(
			mapped,
			quarantine,
			(r) => r.resourceId,
			"search",
		).slice(0, limit);

		log.debugResponse("memories.search", { count: results.length });
		return results;
	}

	async searchRaw(
		query: string,
		options?: {
			limit?: number;
			sources?: HyperspellSource[];
			after?: string;
			before?: string;
			userId?: string;
			filter?: Record<string, unknown>;
		},
	): Promise<Record<string, unknown>> {
		const limit = options?.limit ?? this.config.maxResults;
		const sources =
			options?.sources ??
			(this.config.sources.length > 0 ? this.config.sources : undefined);
		const quarantine = this.config.quarantineResources;
		const fetchLimit = overfetchLimit(limit, quarantine.length);

		log.debugRequest("memories.search (raw)", {
			query,
			limit,
			sources,
			after: options?.after,
			before: options?.before,
			userId: options?.userId,
			filter: options?.filter,
		});

		const response = await this.client.memories.search(
			{
				query,
				sources,
				options: {
					max_results: fetchLimit,
					...(options?.after ? { after: options.after } : {}),
					...(options?.before ? { before: options.before } : {}),
					...(options?.filter ? { filter: options.filter } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		const documents = dropQuarantined(
			response.documents,
			quarantine,
			(doc) => doc.resource_id,
			"search (raw)",
		).slice(0, limit);

		log.debugResponse("memories.search (raw)", {
			count: documents.length,
		});

		return { ...response, documents } as unknown as Record<string, unknown>;
	}

	async searchWithAnswer(
		query: string,
		options?: {
			limit?: number;
			sources?: HyperspellSource[];
			userId?: string;
			filter?: Record<string, unknown>;
		},
	): Promise<SearchWithAnswerResult> {
		const limit = options?.limit ?? this.config.maxResults;
		const sources =
			options?.sources ??
			(this.config.sources.length > 0 ? this.config.sources : undefined);

		log.debugRequest("memories.search (with answer)", {
			query,
			limit,
			sources,
			userId: options?.userId,
			filter: options?.filter,
		});

		const response = await this.client.memories.search(
			{
				query,
				sources,
				answer: true,
				options: {
					max_results: limit,
					...(options?.filter ? { filter: options.filter } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		const mapped: SearchResult[] = response.documents.map((doc) => ({
			resourceId: doc.resource_id,
			title: doc.title ?? null,
			source: doc.source as HyperspellSource,
			score: doc.score ?? null,
			url: (doc.metadata?.url as string | null) ?? null,
			createdAt: (doc.metadata?.created_at as string | null) ?? null,
			metaSource: metaString(doc.metadata, "openclaw_source"),
			metaSpeakerRole: metaString(doc.metadata, "openclaw_speaker_role"),
			metaFilePath: metaString(doc.metadata, "file_path"),
			metaWriter: writerOf(doc.metadata),
			highlights: [],
		}));
		const documents = dropQuarantined(
			mapped,
			this.config.quarantineResources,
			(r) => r.resourceId,
			"search (with answer)",
		);
		// The answer is synthesized SERVER-side from the pre-drop pool, so if a
		// quarantined record was in it, the answer itself may carry that record's
		// content — discard it rather than let quarantine leak through synthesis.
		const tainted = documents.length < mapped.length;
		if (tainted && response.answer) {
			log.warn(
				"search (with answer): answer discarded — synthesized from a pool containing quarantined resource(s)",
			);
		}

		log.debugResponse("memories.search (with answer)", {
			count: documents.length,
			hasAnswer: !!response.answer && !tainted,
		});

		return {
			answer: tainted ? null : (response.answer ?? null),
			documents,
		};
	}

	/**
	 * Audit-view search for the vault-triage tool — the ONLY retrieval path
	 * that does not drop quarantined resources (lib/quarantine.ts is enforced
	 * on every other read). Quarantine is reactive by construction: a bad
	 * record is normally discovered only by being injected. This view exists
	 * so bad records can be hunted proactively; hits on the quarantine list
	 * come back FLAGGED, never silently mixed in.
	 */
	async searchTriage(
		query: string,
		options?: {
			limit?: number;
			sources?: HyperspellSource[];
			after?: string;
			before?: string;
			userId?: string;
		},
	): Promise<TriageResult[]> {
		const limit = options?.limit ?? this.config.maxResults;
		const sources =
			options?.sources ??
			(this.config.sources.length > 0 ? this.config.sources : undefined);

		log.debugRequest("memories.search (triage)", {
			query,
			limit,
			sources,
			after: options?.after,
			before: options?.before,
			userId: options?.userId,
		});

		const response = await this.client.memories.search(
			{
				query,
				sources,
				options: {
					max_results: limit,
					...(options?.after ? { after: options.after } : {}),
					...(options?.before ? { before: options.before } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		const quarantined = new Set(this.config.quarantineResources);
		const results: TriageResult[] = response.documents.map((doc) => {
			const raw = doc as typeof doc & {
				highlights?: Array<{ id: string; score: number; text: string }>;
			};
			return {
				resourceId: doc.resource_id,
				title: doc.title ?? null,
				source: doc.source as HyperspellSource,
				score: doc.score ?? null,
				url: (doc.metadata?.url as string | null) ?? null,
				createdAt: (doc.metadata?.created_at as string | null) ?? null,
				metaSource: metaString(doc.metadata, "openclaw_source"),
				metaSpeakerRole: metaString(doc.metadata, "openclaw_speaker_role"),
				metaFilePath: metaString(doc.metadata, "file_path"),
			metaWriter: writerOf(doc.metadata),
				highlights: (raw.highlights ?? []).map((h) => ({
					id: h.id,
					score: h.score,
					text: h.text,
				})),
				quarantined: quarantined.has(doc.resource_id),
			};
		});

		log.debugResponse("memories.search (triage)", { count: results.length });
		return results;
	}

	async addMemory(
		text: string,
		options?: {
			title?: string;
			resourceId?: string;
			collection?: string;
			date?: string;
			metadata?: Record<string, string | number | boolean>;
			userId?: string;
			scope?: ScopeName;
		},
	): Promise<{ resourceId: string }> {
		log.debugRequest("memories.add", {
			textLength: text.length,
			title: options?.title,
			resourceId: options?.resourceId,
			collection: options?.collection,
			date: options?.date,
			userId: options?.userId,
			scope: options?.scope,
		});

		const result = await this.client.memories.add(
			{
				text,
				title: options?.title,
				resource_id: options?.resourceId,
				collection: options?.collection,
				date: options?.date,
				metadata: {
					openclaw_source: "command",
					...options?.metadata,
					...(options?.userId ? { openclaw_user: options.userId } : {}),
					...(options?.scope
						? { openclaw_scope: normalizeScope(options.scope) }
						: {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		log.debugResponse("memories.add", { resourceId: result.resource_id });
		return { resourceId: result.resource_id };
	}

	async listIntegrations(): Promise<Integration[]> {
		log.debugRequest("integrations.list", {});

		const response = await this.client.integrations.list();

		const integrations: Integration[] = response.integrations.map((int) => ({
			id: int.id,
			name: int.name,
			provider: int.provider as HyperspellSource,
			icon: int.icon,
		}));

		log.debugResponse("integrations.list", { count: integrations.length });
		return integrations;
	}

	async getConnectUrl(
		integrationId: string,
		options?: { userId?: string },
	): Promise<{ url: string; expiresAt: string }> {
		log.debugRequest("integrations.connect", { integrationId });

		const response = await this.client.integrations.connect(
			integrationId,
			undefined,
			this.requestOptions(options?.userId),
		);

		log.debugResponse("integrations.connect", { url: response.url });
		return {
			url: response.url,
			expiresAt: response.expires_at,
		};
	}

	async *listMemories(options?: {
		source?: HyperspellSource;
		collection?: string;
		pageSize?: number;
		userId?: string;
	}): AsyncGenerator<{
		resourceId: string;
		source: HyperspellSource;
		title: string | null;
		metadata: Record<string, unknown>;
	}> {
		log.debugRequest("memories.list", {
			source: options?.source,
			collection: options?.collection,
			userId: options?.userId,
		});

		const params: Record<string, unknown> = {
			size: options?.pageSize ?? 100,
		};
		if (options?.source) params.source = options.source;
		if (options?.collection) params.collection = options.collection;

		for await (const memory of this.client.memories.list(
			params as any,
			this.requestOptions(options?.userId),
		)) {
			yield {
				resourceId: memory.resource_id,
				source: memory.source as HyperspellSource,
				title: memory.title ?? null,
				metadata: (memory.metadata ?? {}) as Record<string, unknown>,
			};
		}
	}

	async getMemory(
		resourceId: string,
		source: HyperspellSource,
		options?: { userId?: string },
	): Promise<Record<string, unknown>> {
		log.debugRequest("memories.get", { resourceId, source });

		const response = await this.client.memories.get(
			resourceId,
			{ source },
			this.requestOptions(options?.userId),
		);
		const raw = response as unknown as Record<string, unknown>;

		log.debugResponse("memories.get", { resourceId, hasData: "data" in raw });
		return raw;
	}

	/**
	 * Delete a memory by resource id. Memory-sync uploads land in the "vault"
	 * source (user-added documents), so that is the default. Best-effort: a
	 * 404 (already gone) is treated as success so callers can prune their
	 * local manifest unconditionally.
	 */
	async deleteMemory(
		resourceId: string,
		options?: { source?: HyperspellSource; userId?: string },
	): Promise<{ deleted: boolean }> {
		const source = options?.source ?? "vault";
		log.debugRequest("memories.delete", { resourceId, source });

		try {
			await this.client.memories.delete(
				resourceId,
				{ source },
				this.requestOptions(options?.userId),
			);
			log.debugResponse("memories.delete", { resourceId, deleted: true });
			return { deleted: true };
		} catch (err) {
			const status = (err as { status?: number })?.status;
			if (status === 404) {
				log.debug(`Memory ${resourceId} already absent (404) — treating as deleted`);
				return { deleted: true };
			}
			log.error(`Failed to delete memory ${resourceId}`, err);
			return { deleted: false };
		}
	}

	async sendTrace(
		history: string,
		options?: {
			sessionId?: string;
			title?: string;
			extract?: Array<"procedure" | "memory" | "mood">;
			metadata?: Record<string, string | number | boolean>;
			userId?: string;
			scope?: ScopeName;
		},
	): Promise<{ resourceId: string; status: string }> {
		log.debugRequest("sessions.add", {
			historyLength: history.length,
			sessionId: options?.sessionId,
			extract: options?.extract,
			userId: options?.userId,
			scope: options?.scope,
		});

		const result = await this.client.sessions.add(
			{
				history,
				session_id: options?.sessionId,
				title: options?.title,
				format: "openclaw",
				// Cast: SDK 0.35 typing accepts only ["procedure" | "memory"], but the
				// backend's mood extractor (hyperspell/hyperspell#581) accepts "mood".
				// Remove this cast once the OpenAPI spec is updated.
				extract: (options?.extract ?? ["procedure"]) as Array<
					"procedure" | "memory"
				>,
				metadata: {
					openclaw_source: "agent_end",
					...options?.metadata,
					...(options?.userId ? { openclaw_user: options.userId } : {}),
					...(options?.scope
						? { openclaw_scope: normalizeScope(options.scope) }
						: {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		log.debugResponse("sessions.add", {
			resourceId: result.resource_id,
			status: result.status,
		});
		return { resourceId: result.resource_id, status: result.status };
	}

	/**
	 * POST /messages — the real-time hot buffer. Rows are full-text searchable
	 * the instant they're inserted (a Postgres GENERATED tsvector, no embedding
	 * wait) and auto-consolidated server-side into vault Resources within ~60s.
	 * The existing search path already unions this buffer with vector results,
	 * so once we write here our turns become searchable immediately.
	 *
	 * Auth: api key + `X-As-User` (REQUIRED — the endpoint 422s without it).
	 * Upsert key is (app_id, user_id, resource_id, message_id), so re-posting an
	 * identical message_id updates `content` only — safe to retry, no duplicates.
	 *
	 * Server-side limits (return 422): per-message content 1..512,000 chars;
	 * batch 1..1,000 messages. Callers should pre-enforce these.
	 */
	async sendMessages(
		messages: Array<{
			resourceId: string;
			messageId: string;
			content: string;
			/** Per-message tags (e.g. speaker attribution) merged over the shared
			 * options.metadata; per-message keys win on collision. */
			metadata?: Record<string, string | number | boolean>;
		}>,
		options?: {
			userId?: string;
			source?: string;
			metadata?: Record<string, string | number | boolean>;
		},
	): Promise<{ count: number }> {
		const userId = options?.userId ?? this.config.userId;
		if (!userId) {
			// X-As-User is mandatory for /messages. Fail loud rather than firing a
			// request we know will 422.
			throw new Error(
				"sendMessages requires a userId (X-As-User) — none configured",
			);
		}
		if (messages.length === 0) return { count: 0 };

		const source = (options?.source ?? "vault").toLowerCase();
		const metadata = options?.metadata;
		const body = {
			source,
			messages: messages.map((m) => {
				// Per-message metadata (Hyperspell #1921): tags hot-buffer rows so
				// retrieval can identify/filter them like /memories/add rows. Persists
				// on the live hot row and is unioned onto the consolidated Resource.
				// Row-specific tags (speaker attribution) merge over the shared batch
				// tags, row keys winning on collision.
				const md = { ...(metadata ?? {}), ...(m.metadata ?? {}) };
				return {
					resource_id: m.resourceId,
					message_id: m.messageId,
					content: m.content,
					...(Object.keys(md).length > 0 ? { metadata: md } : {}),
				};
			}),
		};

		log.debugRequest("messages.create", {
			source,
			count: messages.length,
			userId,
		});

		const res = await fetch(`${API_BASE_URL}/messages`, {
			method: "POST",
			headers: { ...this.rawHeaders(), "X-As-User": userId },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`POST /messages failed (${res.status}): ${text}`);
		}

		const data = await res.json();
		const count = (data?.count as number) ?? messages.length;
		log.debugResponse("messages.create", { count });
		return { count };
	}

	async listConnections(options?: {
		userId?: string;
	}): Promise<Connection[]> {
		log.debugRequest("connections.list", { userId: options?.userId });

		const response = await this.client.connections.list(
			this.requestOptions(options?.userId),
		);

		const connections: Connection[] = response.connections.map((conn) => ({
			id: conn.id,
			integrationId: conn.integration_id,
			label: conn.label,
			provider: conn.provider as HyperspellSource,
		}));

		log.debugResponse("connections.list", { count: connections.length });
		return connections;
	}

	// -- Emotional State (raw fetch -- not in public SDK) -----------------------

	async storeEmotionalState(
		conversation: string,
		options?: {
			sessionId?: string;
			relationshipId?: string;
			metadata?: Record<string, string | number | boolean>;
		},
	): Promise<EmotionalStateResponse> {
		log.debugRequest("emotional-state.store", {
			conversationLength: conversation.length,
			relationshipId: options?.relationshipId,
		});

		const body: Record<string, unknown> = { conversation };
		if (options?.sessionId) body.session_id = options.sessionId;
		if (options?.relationshipId) body.relationship_id = options.relationshipId;
		if (options?.metadata) body.metadata = options.metadata;

		const res = await fetch(`${API_BASE_URL}/emotional-state`, {
			method: "POST",
			headers: this.rawHeaders(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`POST /emotional-state failed (${res.status}): ${text}`);
		}

		const data = await res.json();
		const result: EmotionalStateResponse = {
			resourceId: data.resource_id,
			summary: data.summary,
			extractedAt: data.extracted_at,
			sessionId: data.session_id ?? null,
			relationshipId: data.relationship_id ?? null,
			status: data.status,
		};

		log.debugResponse("emotional-state.store", { resourceId: result.resourceId });
		return result;
	}

	async getEmotionalState(relationshipId?: string): Promise<EmotionalStateLatest | null> {
		log.debugRequest("emotional-state.get", { relationshipId });

		const url = new URL(`${API_BASE_URL}/emotional-state`);
		if (relationshipId) url.searchParams.set("relationship_id", relationshipId);

		const res = await fetch(url.toString(), {
			method: "GET",
			headers: this.rawHeaders(),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`GET /emotional-state failed (${res.status}): ${text}`);
		}

		const data = await res.json();
		if (data === null) {
			log.debugResponse("emotional-state.get", { found: false });
			return null;
		}

		const result: EmotionalStateLatest = {
			resourceId: data.resource_id,
			summary: data.summary,
			extractedAt: data.extracted_at,
			sessionId: data.session_id ?? null,
			relationshipId: data.relationship_id ?? null,
			// Metadata echo maps through only when present and object-shaped —
			// absent today (backend #116) and on legacy rows, so this is invisible
			// until the backend ships the echo.
			...(isMetadataObject(data.metadata) ? { metadata: data.metadata } : {}),
		};

		log.debugResponse("emotional-state.get", { found: true, resourceId: result.resourceId });
		return result;
	}

	/**
	 * The most recent emotional states (newest first), up to `limit` — for
	 * surfacing the recent ARC of how a relationship has felt, not just one
	 * snapshot. Returns `null` when the backend doesn't expose
	 * `/emotional-state/recent` yet (404) so callers can fall back to
	 * `getEmotionalState`. Other non-OK responses throw.
	 */
	async getRecentEmotionalStates(
		relationshipId?: string,
		limit = 3,
	): Promise<EmotionalStateLatest[] | null> {
		log.debugRequest("emotional-state.recent", { relationshipId, limit });

		const url = new URL(`${API_BASE_URL}/emotional-state/recent`);
		if (relationshipId) url.searchParams.set("relationship_id", relationshipId);
		url.searchParams.set("limit", String(limit));

		const res = await fetch(url.toString(), {
			method: "GET",
			headers: this.rawHeaders(),
		});

		if (res.status === 404) {
			// Endpoint not deployed yet — signal the caller to fall back.
			log.debug("emotional-state.recent unavailable (404) — caller falls back to latest");
			return null;
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`GET /emotional-state/recent failed (${res.status}): ${text}`);
		}

		const data = (await res.json()) as Array<Record<string, unknown>> | null;
		const list: EmotionalStateLatest[] = (data ?? []).map((d) => ({
			resourceId: d.resource_id as string,
			summary: (d.summary as string) ?? "",
			extractedAt: (d.extracted_at as string) ?? "",
			sessionId: (d.session_id as string | null) ?? null,
			relationshipId: (d.relationship_id as string | null) ?? null,
			// Same conditional echo as getEmotionalState — see the note there.
			...(isMetadataObject(d.metadata) ? { metadata: d.metadata } : {}),
		}));
		log.debugResponse("emotional-state.recent", { count: list.length });
		return list;
	}

	async deleteEmotionalState(relationshipId?: string): Promise<{ deletedCount: number }> {
		log.debugRequest("emotional-state.delete", { relationshipId });

		const url = new URL(`${API_BASE_URL}/emotional-state`);
		if (relationshipId) url.searchParams.set("relationship_id", relationshipId);

		const res = await fetch(url.toString(), {
			method: "DELETE",
			headers: this.rawHeaders(),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`DELETE /emotional-state failed (${res.status}): ${text}`);
		}

		const data = await res.json();
		const result = { deletedCount: data.deleted_count };

		log.debugResponse("emotional-state.delete", result);
		return result;
	}
}
