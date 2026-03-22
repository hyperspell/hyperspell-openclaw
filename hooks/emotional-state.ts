import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { log } from "../logger.ts";

type Message = { role?: string; content?: string | unknown };

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

function messagesToTranscript(messages: unknown[]): string {
	return (messages as Message[])
		.filter((m) => m.role && m.content)
		.map((m) => {
			const content =
				typeof m.content === "string" ? m.content : JSON.stringify(m.content);
			return `${m.role}: ${content}`;
		})
		.join("\n");
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
