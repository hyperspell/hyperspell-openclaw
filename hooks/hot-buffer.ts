import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { resolveUser } from "../lib/sender.ts";
import { log } from "../logger.ts";
import { sanitizeTraceText } from "./auto-trace.ts";

type Message = { role?: string; content?: string | unknown };
type ContentItem = { type?: string; text?: string } & Record<string, unknown>;

/** Server-side limits from POST /messages (return 422 if exceeded). */
const MAX_CONTENT_CHARS = 512_000;
const MAX_BATCH = 1_000;
const MAX_TOTAL_CHARS = 5_242_880;

/**
 * Per-session set of message_ids already written to the hot buffer this run.
 * `agent_end` fires once per turn with the *full* session history, so without
 * this we'd re-post every prior message each turn. The server upserts (so it's
 * harmless correctness-wise), but re-posting is wasteful — this keeps each turn
 * to just its new messages. Cleared on session_end.
 */
const sentBySession = new Map<string, Set<string>>();

/** Sessions where we've already emitted the group-chat attribution warning. */
const warnedGroupSessions = new Set<string>();

/**
 * Flatten a message's content into a single sanitized text string. Mirrors the
 * auto-trace sanitizer so the hot buffer never captures injected
 * <hyperspell-context>/emotional/orientation wrappers (which would otherwise be
 * consolidated as "memory" and pollute future retrieval).
 */
function extractText(content: unknown): string {
	let raw: string;
	if (typeof content === "string") {
		raw = content;
	} else if (Array.isArray(content)) {
		raw = (content as ContentItem[])
			.filter((i) => i?.type === "text" && typeof i.text === "string")
			.map((i) => i.text as string)
			.join("\n");
	} else {
		raw = "";
	}
	return sanitizeTraceText(raw);
}

/**
 * Deterministic, stable id for a message so retries upsert rather than
 * duplicate. FNV-1a over role+text; prefixed with the role initial to keep
 * user/assistant lines distinct even when content collides.
 */
function messageId(role: string, text: string): string {
	let h = 0x811c9dc5;
	const s = `${role} ${text}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${role[0] ?? "x"}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Write each completed turn to the Hyperspell hot buffer so it's instantly
 * searchable. Runs on `agent_end` — fire-and-forget; a failure here must never
 * break the turn.
 */
export function buildHotBufferHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (
		event: Record<string, unknown>,
		ctx?: Record<string, unknown>,
	) => {
		if (event.success === false) {
			log.debug("hot-buffer: skipping — agent ended with error");
			return;
		}

		const messages = event.messages as Message[] | undefined;
		if (!messages || messages.length === 0) return;

		// X-As-User is mandatory for /messages. Resolve the owner up front and
		// skip (with a clear warning) rather than firing requests that 422.
		const userId = resolveUser(ctx, cfg)?.userId;
		if (!userId) {
			log.warn(
				"hot-buffer: no userId resolved (X-As-User required) — skipping write",
			);
			return;
		}

		// The session id lives on the hook CONTEXT, not the agent_end event
		// (PluginHookAgentEndEvent = { messages, success, error?, durationMs? };
		// PluginHookAgentContext carries sessionId). Reading event.sessionId
		// always yielded undefined → a fresh random resourceId every turn, which
		// (a) defeated the sentBySession dedup so each turn re-posted the entire
		// growing transcript, and (b) scattered a session’s turns across
		// per-turn resources, so nothing could exclude "the current session"
		// (issue #42). Prefer ctx.sessionId; keep event/random as fallbacks.
		const sessionId =
			(ctx?.sessionId as string) ??
			(event.sessionId as string) ??
			crypto.randomUUID();
		const resourceId = sessionId;
		const sent = sentBySession.get(sessionId) ?? new Set<string>();

		// Warn once per session when a group chat has no multiUser config: every
		// turn collapses to cfg.userId with no speaker attribution, feeding the
		// identity-bleed retrieval failure tracked in #58/#59.
		if (ctx?.is_group_chat === true && !cfg.multiUser && !warnedGroupSessions.has(sessionId)) {
			warnedGroupSessions.add(sessionId);
			log.warn(
				"hot-buffer: group chat detected but multiUser is not configured — all turns written under cfg.userId with no speaker attribution (see issues #58/#59)",
			);
		}

		const pending: Array<{
			resourceId: string;
			messageId: string;
			content: string;
		}> = [];
		const pendingIds: string[] = [];

		for (const m of messages) {
			const role = m.role;
			if (role === "user") {
				if (!cfg.hotBuffer.writeUser) continue;
			} else if (role === "assistant") {
				if (!cfg.hotBuffer.writeAssistant) continue;
			} else {
				// Skip system / tool / toolResult — only conversational turns.
				continue;
			}

			let text = extractText(m.content);
			if (text.length === 0) continue;

			if (text.length > MAX_CONTENT_CHARS) {
				log.warn(
					`hot-buffer: truncating ${role} message ${text.length} -> ${MAX_CONTENT_CHARS} chars`,
				);
				text = text.slice(0, MAX_CONTENT_CHARS);
			}

			const id = messageId(role, text);
			if (sent.has(id)) continue;

			pending.push({ resourceId, messageId: id, content: text });
			pendingIds.push(id);
		}

		if (pending.length === 0) return;

		// Chunk by count AND cumulative content size to stay under the 422 limits.
		const batches: Array<typeof pending> = [];
		let batch: typeof pending = [];
		let batchChars = 0;
		for (const item of pending) {
			if (
				batch.length >= MAX_BATCH ||
				(batch.length > 0 && batchChars + item.content.length > MAX_TOTAL_CHARS)
			) {
				batches.push(batch);
				batch = [];
				batchChars = 0;
			}
			batch.push(item);
			batchChars += item.content.length;
		}
		if (batch.length > 0) batches.push(batch);

		try {
			let total = 0;
			for (const b of batches) {
				// Do NOT tag hot rows with metadata: a POST /messages write that
				// carries `metadata` is accepted (200) but the row never becomes
				// retrievable (verified live, post-Hyperspell #1921) — tagging
				// silently breaks hot-buffer recall. The tag isn't needed anyway:
				// untagged rows survive the unconditional {$ne:"agent_end"} exclude
				// (absent-field semantics, #1921) AND are full-text searchable. So
				// we write content only. (Backend follow-up: make /messages metadata
				// not suppress indexing, then this can be reinstated.)
				const result = await client.sendMessages(b, {
					userId,
					source: cfg.hotBuffer.source,
				});
				total += result.count;
			}
			// Only mark as sent after a successful write so a failure retries next turn.
			for (const id of pendingIds) sent.add(id);
			sentBySession.set(sessionId, sent);
			log.info(
				`hot-buffer: wrote ${total} message(s) to ${sessionId} (user=${userId})`,
			);
		} catch (err) {
			// Fire-and-forget — never break the turn.
			log.error("hot-buffer write failed", err);
		}
	};
}

/** Drop per-session state on session end to avoid unbounded growth. */
export function buildHotBufferSessionCleanupHandler() {
	return (event: Record<string, unknown>) => {
		const sessionId = event.sessionId as string | undefined;
		if (sessionId) {
			sentBySession.delete(sessionId);
			warnedGroupSessions.delete(sessionId);
		}
	};
}
