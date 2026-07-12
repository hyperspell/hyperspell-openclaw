import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { channelIdFromCtx } from "../lib/exclude-channels.ts";
import { resolveUser } from "../lib/sender.ts";
import { isMultiSpeaker } from "../lib/speaker-tracker.ts";
import { log } from "../logger.ts";

type Message = { role?: string; content?: string | unknown };
type ContentItem = { type?: string; text?: string } & Record<string, unknown>;

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/** Sessions where we've already emitted the group-chat attribution warning. */
const warnedGroupTraceSessions = new Set<string>();

/**
 * Strip transport/injection metadata from a text blob before it's stored as a
 * trace memory. Without this the auto-context and emotional-state hooks'
 * prepended wrappers get captured verbatim, extracted as "memory content",
 * and then surface again on the next session's retrieval — a self-amplifying
 * pollution loop.
 */
export function sanitizeTraceText(input: string): string {
	let out = input;
	out = out.replace(
		/<hyperspell-context>[\s\S]*?<\/hyperspell-context>\n?/g,
		"",
	);
	out = out.replace(
		/<hyperspell-emotional-context>[\s\S]*?<\/hyperspell-emotional-context>\n?/g,
		"",
	);
	out = out.replace(
		/<hyperspell-recent-interactions>[\s\S]*?<\/hyperspell-recent-interactions>\n?/g,
		"",
	);
	out = out.replace(
		/<hyperspell-unfinished-loops>[\s\S]*?<\/hyperspell-unfinished-loops>\n?/g,
		"",
	);
	out = out.replace(
		/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\n?/g,
		"",
	);
	out = out.replace(
		/\[Bootstrap pending\][\s\S]*?(?=\n{2,}|\nSystem:|\nSender|$)/g,
		"",
	);
	out = out.replace(
		/\[Startup context loaded by runtime\][\s\S]*?(?:\n\n|$)/g,
		"",
	);
	out = out.replace(
		/\[Untrusted daily memory:[^\]]*\][\s\S]*?END_QUOTED_NOTES\n?/g,
		"",
	);
	out = out.replace(
		/^System(?:\s+\(untrusted\))?:\s*\[[^\]]+\][^\n]*\n?/gm,
		"",
	);
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out;
}

function sanitizeContent(content: unknown): ContentItem[] {
	const items: ContentItem[] =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? (content as ContentItem[])
				: [{ type: "text", text: JSON.stringify(content) }];

	const cleaned: ContentItem[] = [];
	for (const item of items) {
		if (item?.type === "text" && typeof item.text === "string") {
			const text = sanitizeTraceText(item.text);
			if (text.length > 0) cleaned.push({ ...item, text });
		} else if (item) {
			cleaned.push(item);
		}
	}
	return cleaned;
}

/**
 * Convert event.messages into OpenClaw JSONL format for the trace API.
 */
function messagesToJSONL(messages: unknown[], sessionId: string): string {
	const lines: string[] = [];

	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
		}),
	);

	for (const raw of messages as Message[]) {
		if (!raw.role || !raw.content) continue;
		if (raw.role === "system") continue;

		const content = sanitizeContent(raw.content);
		if (content.length === 0) continue;

		const id = crypto.randomUUID().slice(0, 8);

		if (raw.role === "tool" || raw.role === "toolResult") {
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					timestamp: new Date().toISOString(),
					message: {
						role: "toolResult",
						toolCallId: (raw as Record<string, unknown>).toolCallId ?? id,
						toolName: (raw as Record<string, unknown>).toolName ?? "unknown",
						content,
						isError: (raw as Record<string, unknown>).isError ?? false,
					},
				}),
			);
		} else {
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					timestamp: new Date().toISOString(),
					message: { role: raw.role, content },
				}),
			);
		}
	}

	return lines.join("\n");
}

/**
 * Extract and store conversation trace at session end.
 * Runs on `agent_end` — fire-and-forget.
 */
export function buildAutoTraceHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (
		event: Record<string, unknown>,
		ctx?: Record<string, unknown>,
	) => {
		if (event.success === false) {
			log.debug("auto-trace: skipping — agent ended with error");
			return;
		}

		const messages = event.messages as unknown[] | undefined;
		if (!messages || messages.length < MIN_MESSAGES) {
			log.debug(
				`auto-trace: skipping — too few messages (${messages?.length ?? 0})`,
			);
			return;
		}

		// Quick content length check
		const estimate = (messages as Message[])
			.filter((m) => m.content)
			.reduce((acc, m) => acc + String(m.content).length, 0);
		if (estimate < MIN_CONVERSATION_LENGTH) {
			log.debug(
				`auto-trace: skipping — conversation too short (${estimate} chars)`,
			);
			return;
		}

		// The session id lives on the hook CONTEXT, not the agent_end event (same
		// contract issue #42 hit in hot-buffer): reading only event.sessionId
		// yields a fresh random UUID per turn, which breaks multi-speaker
		// detection keying and makes the openclaw_session_id tag useless for
		// cleanup. Prefer ctx; keep event/random as fallbacks.
		const sessionId =
			(ctx?.sessionId as string) ??
			(event.sessionId as string) ??
			crypto.randomUUID();
		const history = messagesToJSONL(messages, sessionId);

		// Warn once per session when multiple speakers have no multiUser config:
		// all turns collapse into a single undifferentiated trace under cfg.userId.
		// Uses both is_group_chat and sender_id drift detection (issue #59).
		if (isMultiSpeaker(sessionId, ctx?.is_group_chat === true) && !cfg.multiUser && !warnedGroupTraceSessions.has(sessionId)) {
			warnedGroupTraceSessions.add(sessionId);
			log.warn(
				"auto-trace: multi-speaker session detected but multiUser is not configured — trace will mix all speakers under cfg.userId with no attribution (see issues #58/#59)",
			);
		}

		// Title from first user message
		const firstUser = (messages as Message[]).find((m) => m.role === "user");
		const title = firstUser?.content
			? String(firstUser.content).slice(0, 80).replace(/\n/g, " ")
			: undefined;

		// Resolve sender → userId so traces land in the right user's space.
		// Falls back to sharedUserId for unknown senders (or undefined in single-user mode).
		const resolved = resolveUser(ctx, cfg);
		const userId = resolved?.userId;

		// Tag traces with the conversation they came from. channelIdFromCtx is the
		// same resolver the quarantine check uses, so tag-time identity matches
		// quarantine-time identity — the purge-channel CLI relies on that parity.
		// session_id is a first-class trace field but is NOT exposed by
		// listMemories, so it's mirrored into metadata for enumeration.
		const channelId = channelIdFromCtx(ctx);

		try {
			const result = await client.sendTrace(history, {
				sessionId,
				title,
				extract: cfg.autoTrace.extract,
				metadata: {
					...cfg.autoTrace.metadata,
					...(channelId ? { openclaw_channel_id: channelId } : {}),
					openclaw_session_id: sessionId,
				},
				userId,
				// Auto-trace captures full conversation text — the most sensitive class
				// of memory. Default to private; users opt into family-visible recall
				// via explicit /remember.
				scope: "private",
			});
			log.info(
				`auto-trace: sent ${result.resourceId} (${messages.length} messages${userId ? `, user=${userId}` : ""})`,
			);
		} catch (err) {
			// Fire-and-forget — never break the session
			log.error("auto-trace failed", err);
		}
	};
}
