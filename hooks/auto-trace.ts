import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { resolveUser } from "../lib/sender.ts";
import { log } from "../logger.ts";

type Message = { role?: string; content?: string | unknown };

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/**
 * Convert event.messages into OpenClaw JSONL format for the trace API.
 */
function messagesToJSONL(messages: unknown[], sessionId: string): string {
	const lines: string[] = [];

	// Session header
	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
		}),
	);

	// Message entries
	for (const raw of messages as Message[]) {
		if (!raw.role || !raw.content) continue;

		const content =
			typeof raw.content === "string"
				? [{ type: "text", text: raw.content }]
				: Array.isArray(raw.content)
					? raw.content
					: [{ type: "text", text: JSON.stringify(raw.content) }];

		const id = crypto.randomUUID().slice(0, 8);

		if (raw.role === "tool" || raw.role === "toolResult") {
			// Tool results use a different structure
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

		const sessionId = (event.sessionId as string) ?? crypto.randomUUID();
		const history = messagesToJSONL(messages, sessionId);

		// Title from first user message
		const firstUser = (messages as Message[]).find((m) => m.role === "user");
		const title = firstUser?.content
			? String(firstUser.content).slice(0, 80).replace(/\n/g, " ")
			: undefined;

		// Resolve sender → userId so traces land in the right user's space.
		// Falls back to sharedUserId for unknown senders (or undefined in single-user mode).
		const resolved = resolveUser(ctx, cfg);
		const userId = resolved?.userId;

		try {
			const result = await client.sendTrace(history, {
				sessionId,
				title,
				extract: cfg.autoTrace.extract,
				metadata: cfg.autoTrace.metadata,
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
