import type { HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { log } from "../logger.ts";
import { sanitizeTraceText } from "./auto-trace.ts";

type Message = { role?: string; content?: string | unknown };
type AgentContext = { sessionKey?: string };

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/**
 * Sessions where emotional context has already been injected this run.
 * Emotional state doesn't change within a session (it's extracted at
 * agent_end and surfaces on the *next* session), so re-fetching and
 * re-injecting on every turn is pure cost — one API call and a few
 * hundred tokens of repeated wrapper per turn.
 *
 * Lifecycle:
 *  - first before_agent_start in a session: fetch, inject, mark.
 *  - subsequent turns in same session: skip (return undefined).
 *  - after_compaction: clear the mark so the next turn re-injects (the
 *    initial injection may have been compacted out of history).
 *  - session_end: clean up to prevent unbounded Set growth.
 */
const injectedSessions = new Set<string>();

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
 * True if a fetched emotional-state `summary` is actually the raw transcript
 * placeholder returned during the async extraction window (status=pending),
 * rather than a distilled emotional register. Real summaries are second-person
 * prose ("Your relationship with this user…"); the placeholder echoes the input
 * conversation, which has role-prefixed lines.
 */
export function looksLikeRawTranscript(summary: string): boolean {
	return /(^|\n)\s*(user|assistant)\s*:/i.test(summary);
}

/**
 * Fetch emotional state on the first agent turn of a session and inject into
 * context. On later turns of the same session, return undefined — the
 * injection from the first turn is already in the conversation history.
 *
 * Runs on `before_agent_start` (which fires every turn).
 */
export function buildEmotionalStateFetchHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.has(sessionKey)) {
			return;
		}

		try {
			const state = await client.getEmotionalState(cfg.relationshipId);

			if (!state) {
				log.debug("emotional-context: no prior emotional state found");
				if (sessionKey) injectedSessions.add(sessionKey);
				return;
			}

			// Extraction is async: for ~10s after a store, GET /emotional-state
			// returns status=pending with `summary` set to the RAW transcript (the
			// input), not the distilled register — and the response carries no
			// status field to check. Detect that placeholder structurally (a real
			// summary is second-person prose; a raw transcript has role-prefixed
			// lines) and DON'T inject it: handing back the raw transcript as
			// "feeling" is useless and pollutes tone. Don't cache, so a later turn
			// re-fetches once extraction has completed.
			if (looksLikeRawTranscript(state.summary)) {
				log.debug(
					"emotional-context: state still extracting (raw-transcript placeholder) — skipping injection this turn",
				);
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

			if (sessionKey) injectedSessions.add(sessionKey);
			return { prependContext: context };
		} catch (err) {
			log.error("emotional-context fetch failed", err);
			return;
		}
	};
}

/**
 * After compaction, the emotional-context block from the first turn may have
 * been trimmed out of history. Clear the cache so the next turn re-injects.
 */
export function buildEmotionalStateCompactionHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.delete(sessionKey)) {
			log.debug(
				`emotional-context: cache cleared after compaction (session=${sessionKey})`,
			);
		}
	};
}

/**
 * Remove session from the inject-once cache when the session ends, to keep the
 * Set from growing unbounded over process lifetime.
 */
export function buildEmotionalStateSessionCleanupHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey) injectedSessions.delete(sessionKey);
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
