import type { EmotionalStateLatest, HyperspellClient } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { resolveCurrentSessionId } from "../lib/session.ts";
import { isMultiSpeaker } from "../lib/speaker-tracker.ts";
import { log } from "../logger.ts";
import { sanitizeTraceText } from "./auto-trace.ts";
import { buildMoodWeatherContext, rollMood } from "./mood-weather.ts";

/** How many recent registers to surface as the "arc" at session start. */
const EMOTIONAL_ARC_LIMIT = 3;

type Message = { role?: string; content?: string | unknown };
type AgentContext = { sessionKey?: string; trigger?: string };

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/**
 * Only REAL human conversations should shape her emotional register. Automated
 * runs — cron check-ins, heartbeats, internal memory passes — are not "how the
 * relationship feels"; counting them lets a throwaway "how's your afternoon?"
 * heartbeat overwrite the register from a deep conversation (the whipsaw).
 * `ctx.trigger` is one of cron|heartbeat|manual|memory|overflow|user; we store
 * only for user-driven turns (and `overflow`, a continuation of a user run).
 */
const NON_CONVERSATIONAL_TRIGGERS = new Set(["cron", "heartbeat", "memory"]);

/**
 * Debounce window: don't re-extract the register on every turn of an active
 * conversation (each store is a backend LLM call, and the latest already carries
 * the full transcript). One snapshot per ~few minutes of real talk is plenty.
 */
const STORE_DEBOUNCE_MS = 3 * 60 * 1000;

/** relationshipId → last successful store time (ms). Module-scoped, per process. */
const lastStoreAt = new Map<string, number>();

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

/** Compact relative time for the arc labels (e.g. "just now", "3h ago", "2d ago"). */
function relativeWhen(iso: string): string {
	if (!iso) return "";
	try {
		const mins = (Date.now() - new Date(iso).getTime()) / 60000;
		if (Number.isNaN(mins)) return "";
		if (mins < 2) return "just now";
		if (mins < 60) return `${Math.floor(mins)}m ago`;
		const hrs = mins / 60;
		if (hrs < 24) return `${Math.floor(hrs)}h ago`;
		const days = hrs / 24;
		if (days < 7) return `${Math.floor(days)}d ago`;
		return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
	} catch {
		return "";
	}
}

/**
 * Prefer the recent ARC (last N registers) so a single shallow read can't
 * misrepresent the relationship. Falls back to the single latest when the
 * backend doesn't expose `/emotional-state/recent` yet (returns null) or errors
 * — so this works before AND after that endpoint deploys.
 */
async function fetchRecentOrLatest(
	client: HyperspellClient,
	cfg: HyperspellConfig,
): Promise<EmotionalStateLatest[]> {
	try {
		const recent = await client.getRecentEmotionalStates(
			cfg.relationshipId,
			EMOTIONAL_ARC_LIMIT,
		);
		if (recent !== null) return recent; // endpoint available (may be empty)
	} catch (err) {
		log.debug("emotional-context: /recent unavailable — falling back to latest", err);
	}
	const single = await client.getEmotionalState(cfg.relationshipId);
	return single ? [single] : [];
}

/** Build the injected emotional-context block from one or more registers. */
function buildEmotionalContext(states: EmotionalStateLatest[]): string {
	const intro =
		states.length > 1
			? "How your relationship with this user has felt across your recent conversations, most recent first. Let the trajectory inform your tone — don't reference it explicitly."
			: "The emotional register of your relationship with this user from your last interaction. Let it inform your tone — don't reference it explicitly.";
	const lines = states.map((s) => {
		const when = relativeWhen(s.extractedAt);
		return when ? `- [${when}] ${s.summary}` : `- ${s.summary}`;
	});
	return [
		"<hyperspell-emotional-context>",
		intro,
		"",
		...lines,
		"</hyperspell-emotional-context>",
	].join("\n");
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
			const states = await fetchRecentOrLatest(client, cfg);

			// Drop raw-transcript placeholders: extraction is async, so for ~10s
			// after a store the register can be the RAW input transcript, not the
			// distilled feeling. Injecting that is useless and pollutes tone.
			const usable = states.filter(
				(s) => s.summary && !looksLikeRawTranscript(s.summary),
			);

			// Mood weather: an exogenous, uncaused session mood that OVERRIDES the
			// arc's tone for this session only. Rolled once per session (gated by
			// the same inject-once cache). Lives purely in the injection path — it is
			// never written back via the store handler, so one random morning can't
			// calcify into the baseline. May clash with the room on purpose.
			const mood = cfg.moodWeatherChance > 0 ? rollMood(cfg.moodWeatherChance) : null;
			const moodBlock = mood ? buildMoodWeatherContext(mood) : "";
			if (mood) {
				log.info(`mood-weather: rolled "${mood.id}" this session`);
			}

			if (usable.length === 0) {
				if (states.length > 0) {
					// State(s) exist but are all still extracting — don't cache, so a
					// later turn re-fetches once extraction completes. (We re-roll the
					// mood then too, which is fine — still at most once per *injected*
					// session, since extraction settles within seconds.)
					log.debug(
						"emotional-context: state(s) still extracting — skipping injection this turn",
					);
					return;
				}
				// No arc yet — but weather can still land on a blank slate.
				log.debug("emotional-context: no prior emotional state found");
				if (sessionKey) injectedSessions.add(sessionKey);
				return moodBlock ? { prependContext: moodBlock } : undefined;
			}

			log.debug(
				`emotional-context: injecting ${usable.length} recent register(s)`,
			);
			// Mood block comes AFTER the arc so it reads as today's override on top
			// of the remembered trajectory — not blended into it.
			const context = moodBlock
				? `${buildEmotionalContext(usable)}\n\n${moodBlock}`
				: buildEmotionalContext(usable);

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
	return async (event: Record<string, unknown>, ctx?: AgentContext) => {
		if (event.success === false) {
			log.debug("emotional-state: skipping — agent ended with error");
			return;
		}

		// Only real human conversations count — skip cron/heartbeat/memory runs so
		// an automated check-in can't overwrite the register from a real talk.
		const trigger = ctx?.trigger;
		if (trigger && NON_CONVERSATIONAL_TRIGGERS.has(trigger)) {
			log.debug(`emotional-state: skipping — non-conversational trigger (${trigger})`);
			return;
		}

		// Skip storing when multiple speakers are present with no multiUser config:
		// the register is keyed to a single relationshipId but the transcript mixes
		// speakers, corrupting "how the relationship feels" with an undifferentiated
		// blend. Uses both is_group_chat and sender_id drift detection (issue #59).
		const sessionId = resolveCurrentSessionId(event, ctx as Record<string, unknown>);
		if (isMultiSpeaker(sessionId, (ctx as Record<string, unknown>)?.is_group_chat === true) && !cfg.multiUser) {
			log.warn(
				"emotional-state: skipping store — multi-speaker session with no multiUser config would corrupt the relationship register with a mixed-speaker transcript (see issue #59)",
			);
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

		// Debounce: at most one snapshot per STORE_DEBOUNCE_MS of active talk.
		const relId = cfg.relationshipId ?? "";
		const since = Date.now() - (lastStoreAt.get(relId) ?? 0);
		if (since < STORE_DEBOUNCE_MS) {
			log.debug(
				`emotional-state: skipping — debounced (${Math.round(since / 1000)}s since last store)`,
			);
			return;
		}

		try {
			const result = await client.storeEmotionalState(transcript, {
				relationshipId: cfg.relationshipId,
				metadata: { source: "openclaw_agent_end" },
			});
			lastStoreAt.set(relId, Date.now());
			log.info(`emotional-state: stored ${result.resourceId}`);
		} catch (err) {
			// Fire-and-forget — never let this break the session
			log.error("emotional-state store failed", err);
		}
	};
}
