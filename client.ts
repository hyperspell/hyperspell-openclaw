import Hyperspell from "hyperspell";
import type {
	HyperspellConfig,
	HyperspellSource,
	ScopeName,
} from "./config.ts";
import { normalizeScope } from "./config.ts";
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
	highlights: Highlight[];
};

export type SearchWithAnswerResult = {
	answer: string | null;
	documents: SearchResult[];
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
}

const API_BASE_URL = "https://api.hyperspell.com"

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
					max_results: limit,
					...(options?.after ? { after: options.after } : {}),
					...(options?.before ? { before: options.before } : {}),
					...(options?.filter ? { filter: options.filter } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		const results: SearchResult[] = response.documents.map((doc) => {
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
				highlights: (raw.highlights ?? []).map((h) => ({
					id: h.id,
					score: h.score,
					text: h.text,
				})),
			};
		});

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
					max_results: limit,
					...(options?.after ? { after: options.after } : {}),
					...(options?.before ? { before: options.before } : {}),
					...(options?.filter ? { filter: options.filter } : {}),
				},
			},
			this.requestOptions(options?.userId),
		);

		log.debugResponse("memories.search (raw)", {
			count: response.documents.length,
		});

		return response as unknown as Record<string, unknown>;
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

		const documents: SearchResult[] = response.documents.map((doc) => ({
			resourceId: doc.resource_id,
			title: doc.title ?? null,
			source: doc.source as HyperspellSource,
			score: doc.score ?? null,
			url: (doc.metadata?.url as string | null) ?? null,
			createdAt: (doc.metadata?.created_at as string | null) ?? null,
			highlights: [],
		}));

		log.debugResponse("memories.search (with answer)", {
			count: documents.length,
			hasAnswer: !!response.answer,
		});

		return {
			answer: response.answer ?? null,
			documents,
		};
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
		messages: Array<{ resourceId: string; messageId: string; content: string }>,
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
			messages: messages.map((m) => ({
				resource_id: m.resourceId,
				message_id: m.messageId,
				content: m.content,
				// Per-message metadata (Hyperspell #1921): tags hot-buffer rows so
				// retrieval can identify/filter them like /memories/add rows. Persists
				// on the live hot row and is unioned onto the consolidated Resource.
				...(metadata ? { metadata } : {}),
			})),
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
		};

		log.debugResponse("emotional-state.get", { found: true, resourceId: result.resourceId });
		return result;
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
