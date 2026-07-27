import fs from "node:fs";
import path from "node:path";
import type { HyperspellClient } from "../client.ts";
import { getWorkspaceDir } from "../config.ts";
import type { HyperspellConfig } from "../config.ts";
import { channelIdFromCtx } from "../lib/exclude-channels.ts";
import { HOT_BUFFER_SOURCE } from "../lib/filters.ts";
import { resolveUser } from "../lib/sender.ts";
import {
	cleanupSpeakerSession,
	isMultiSpeaker,
	recordSender,
	senderIdFromCtx,
} from "../lib/speaker-tracker.ts";
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
 *
 * This map alone is NOT restart-safe: it's module-scope, in-memory only. A
 * gateway restart wipes it without firing session_end, so the next turn of a
 * still-open session sees an empty set and re-posts the entire transcript to
 * date in one shot (observed live: two 499/503-message flushes right after
 * restarts, vs. the normal 2-10). `loadPersistedSent`/`persistSent` below
 * mirror this map to disk per session so a restart degrades to "reload from
 * disk" instead of "resend everything."
 */
const sentBySession = new Map<string, Set<string>>();

function stateDir(root: string): string {
	return path.join(root, "hot-buffer-sent");
}

function stateFile(root: string, sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(stateDir(root), `${safe}.json`);
}

function loadPersistedSent(root: string, sessionId: string): Set<string> {
	try {
		const raw = fs.readFileSync(stateFile(root, sessionId), "utf-8");
		const ids = JSON.parse(raw) as string[];
		return new Set(ids);
	} catch {
		return new Set();
	}
}

function persistSent(root: string, sessionId: string, sent: Set<string>): void {
	try {
		fs.mkdirSync(stateDir(root), { recursive: true });
		fs.writeFileSync(stateFile(root, sessionId), JSON.stringify([...sent]));
	} catch (err) {
		log.error("hot-buffer: failed to persist sent-id state to disk", err);
	}
}

function deletePersistedSent(root: string, sessionId: string): void {
	try {
		fs.unlinkSync(stateFile(root, sessionId));
	} catch {
		// Nothing to clean up — fine.
	}
}

/** Sessions where we've already emitted the group-chat attribution warning. */
const warnedGroupSessions = new Set<string>();

/**
 * Test-only: drop just the in-memory dedup cache for a session, leaving any
 * persisted-to-disk state untouched. This is what a bare gateway restart
 * looks like (module state wiped, disk state intact) — as opposed to
 * `buildHotBufferSessionCleanupHandler`'s session_end, which clears both on
 * purpose. Not used outside tests.
 */
export function __simulateRestartForTest(sessionId: string): void {
	sentBySession.delete(sessionId);
}

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
	opts?: { stateRoot?: string },
) {
	const stateRoot = opts?.stateRoot ?? getWorkspaceDir();
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
		const resolved = resolveUser(ctx, cfg);
		const userId = resolved?.userId;
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
		// Fall back to disk before assuming "nothing sent yet" — an empty
		// in-memory entry is ambiguous between "brand new session" and "this
		// process restarted mid-session," and treating the latter as the former
		// is exactly the full-transcript-resend bug this guards against.
		let sent = sentBySession.get(sessionId);
		if (!sent) {
			sent = loadPersistedSent(stateRoot, sessionId);
			sentBySession.set(sessionId, sent);
		}

		// Record the current sender for evidence-based multi-speaker detection.
		// isMultiSpeaker() will return true once a second distinct sender_id
		// appears in this session, regardless of whether is_group_chat was set.
		const senderId = senderIdFromCtx(ctx);
		recordSender(sessionId, senderId);

		const groupChat = isMultiSpeaker(sessionId, ctx?.is_group_chat === true);

		// Warn once per session when multiple speakers have no multiUser config.
		if (groupChat && !cfg.multiUser && !warnedGroupSessions.has(sessionId)) {
			warnedGroupSessions.add(sessionId);
			log.warn(
				"hot-buffer: multi-speaker session detected but multiUser is not configured — all turns written under cfg.userId with no speaker attribution (see issues #58/#59)",
			);
		}

		// In multi-speaker single-user mode, prefix each human turn with the sender
		// name so attribution survives in stored text. Metadata on hot-buffer
		// writes suppresses indexing (Hyperspell #1921), so the text content is
		// the only place attribution can land. Only prefix when we have an
		// envelope-derived name — if it equals cfg.userId the sender field was
		// absent and prefixing "alinea:" onto someone else's message would mislead.
		// Escape ] to keep the [Name]: format parseable (issue #59 follow-up).
		const envName =
			resolved?.name && resolved.name !== (cfg.userId ?? "")
				? resolved.name.replace(/\]/g, "").trim()
				: undefined;
		const speakerPrefix =
			groupChat && !cfg.multiUser && envName ? `[${envName}]: ` : undefined;

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
			if (role === "user" && speakerPrefix) text = speakerPrefix + text;
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
			// Tag hot rows so retrieval and cleanup can identify them by origin.
			// Historical note: metadata on POST /messages used to suppress indexing
			// (Hyperspell #1921), so tagging was disabled; verified fixed live
			// 2026-07-02 (docs/filter-dialect-test.mjs: metadata-carrying row is
			// baseline-retrievable AND filterable). The retrieval exclude
			// {openclaw_source:{$ne:"agent_end"}} keeps "hot_buffer" rows.
			// channelIdFromCtx (ctx.channelId, else sessionKey parse) is the same
			// resolver the quarantine check uses — tag-time identity must equal
			// quarantine-time identity or purge-channel misses rows the exclude
			// would have blocked.
			const channelId = channelIdFromCtx(ctx);
			const metadata: Record<string, string> = {
				openclaw_source: HOT_BUFFER_SOURCE,
				openclaw_session_id: sessionId,
				...(channelId ? { openclaw_channel_id: channelId } : {}),
			};
			for (const b of batches) {
				const result = await client.sendMessages(b, {
					userId,
					source: cfg.hotBuffer.source,
					metadata,
				});
				total += result.count;
			}
			// Only mark as sent after a successful write so a failure retries next turn.
			for (const id of pendingIds) sent.add(id);
			sentBySession.set(sessionId, sent);
			persistSent(stateRoot, sessionId, sent);
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
export function buildHotBufferSessionCleanupHandler(opts?: { stateRoot?: string }) {
	const stateRoot = opts?.stateRoot ?? getWorkspaceDir();
	return (event: Record<string, unknown>) => {
		const sessionId = event.sessionId as string | undefined;
		if (sessionId) {
			sentBySession.delete(sessionId);
			warnedGroupSessions.delete(sessionId);
			cleanupSpeakerSession(sessionId);
			deletePersistedSent(stateRoot, sessionId);
		}
	};
}
