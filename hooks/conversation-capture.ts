import type { HyperspellClient } from "../client.ts";
import { CONVERSATION_COLLECTION, type HyperspellConfig } from "../config.ts";
import { log } from "../logger.ts";

const MAX_TRANSCRIPT_CHARS = 10_000;

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "text" &&
				typeof (block as Record<string, unknown>).text === "string"
			) {
				parts.push((block as Record<string, unknown>).text as string);
			}
		}
		return parts.join("\n");
	}
	return "";
}

function findLastMessage(
	messages: ReadonlyArray<Record<string, unknown>>,
	role: "user" | "assistant",
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		if (msg.role !== role) continue;
		const text = extractText(msg.content);
		if (text) return text;
	}
	return null;
}

export function buildConversationCaptureHandler(
	client: HyperspellClient,
	_cfg: HyperspellConfig,
) {
	return async (
		event: Record<string, unknown>,
		ctx?: Record<string, unknown>,
	) => {
		if (event.success === false) return;

		const messages = event.messages as
			| ReadonlyArray<Record<string, unknown>>
			| undefined;
		if (!messages || messages.length === 0) return;

		const userText = findLastMessage(messages, "user");
		const assistantText = findLastMessage(messages, "assistant");
		if (!userText || !assistantText) return;

		const full = `User: ${userText}\n\nAssistant: ${assistantText}`;
		const transcript =
			full.length > MAX_TRANSCRIPT_CHARS
				? full.slice(0, MAX_TRANSCRIPT_CHARS)
				: full;

		const sessionKey = (ctx?.sessionKey as string | undefined) ?? "unknown";
		const turnIndex = Math.floor(messages.length / 2);
		const resourceId = `openclaw_conv_${sessionKey}_${turnIndex}`;

		try {
			await client.addMemory(transcript, {
				collection: CONVERSATION_COLLECTION,
				resourceId,
				metadata: {
					openclaw_source: "conversation",
					session_id: sessionKey,
				},
			});
		} catch (err) {
			log.error("conversation-capture: addMemory failed", err);
		}
	};
}
