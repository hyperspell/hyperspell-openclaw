import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { log } from "../logger.ts";
import { sanitizeTraceText } from "./auto-trace.ts";

type Message = { role?: string; content?: string | unknown };

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/**
 * Extract readable text from a message content, unwrapping the common
 * `[{ type: "text", text: "..." }]` array shape so sanitizeTraceText can
 * operate on real text (not JSON-stringified content where newlines would
 * be escaped and regex line-anchors wouldn't match).
 */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const item of content) {
			if (
				item &&
				typeof item === "object" &&
				(item as { type?: unknown }).type === "text" &&
				typeof (item as { text?: unknown }).text === "string"
			) {
				texts.push((item as { text: string }).text);
			}
		}
		if (texts.length > 0) return texts.join("\n");
	}
	return "";
}

function messagesToTranscript(messages: unknown[]): string {
	const lines: string[] = [];
	for (const m of messages as Message[]) {
		if (!m.role || !m.content) continue;
		if (m.role === "system") continue;
		const raw = contentToText(m.content);
		if (!raw) continue;
		const cleaned = sanitizeTraceText(raw);
		if (cleaned.length === 0) continue;
		lines.push(`${m.role}: ${cleaned}`);
	}
	return lines.join("\n");
}

/**
 * Fetch emotional state at session start and inject into context.
 * Runs on `before_agent_start`.
 */
export function buildEmotionalStateFetchHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (_event: Record<string, unknown>) => {
		try {
			const state = await client.getEmotionalState(cfg.relationshipId);

			if (!state) {
				log.debug("emotional-context: no prior emotional state found");
				return;
			}

			log.debug(`emotional-context: injecting state from ${state.extractedAt}`);

			const context = [
				"<hyperspell-emotional-context>",
				"The following captures the emotional register of your relationship with this user from your last interaction. Let it inform your tone — don't reference it explicitly.",
				"",
				state.summary,
				"</hyperspell-emotional-context>",
			].join("\n");

			return { prependContext: context };
		} catch (err) {
			log.error("emotional-context fetch failed", err);
			return;
		}
	};
}

/**
 * Extract and store emotional state at session end.
 * Runs on `agent_end` — fire-and-forget.
 */
export function buildEmotionalStateStoreHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (event: Record<string, unknown>) => {
		if (event.success === false) {
			log.debug("emotional-state: skipping — agent ended with error");
			return;
		}

		const messages = event.messages as unknown[] | undefined;
		if (!messages || messages.length < MIN_MESSAGES) {
			log.debug(
				`emotional-state: skipping — too few messages (${messages?.length ?? 0})`,
			);
			return;
		}

		const transcript = messagesToTranscript(messages);
		if (transcript.length < MIN_CONVERSATION_LENGTH) {
			log.debug(
				`emotional-state: skipping — conversation too short (${transcript.length} chars)`,
			);
			return;
		}

		try {
			const result = await client.storeEmotionalState(transcript, {
				relationshipId: cfg.relationshipId,
				metadata: { source: "openclaw_agent_end" },
			});
			log.info(`emotional-state: stored ${result.resourceId}`);
		} catch (err) {
			// Fire-and-forget — never let this break the session
			log.error("emotional-state store failed", err);
		}
	};
}
