import type { EmotionalStateLatest, HyperspellClient } from "../client.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HyperspellConfig } from "../config.ts";
import { getWorkspaceDir } from "../config.ts";
import { channelIdFromCtx } from "../lib/exclude-channels.ts";
import { senderIdFromCtx } from "../lib/speaker-tracker.ts";
import { EMOTIONAL_STATE_SOURCE } from "../lib/filters.ts";
import { resolveCurrentSessionId } from "../lib/session.ts";
import { isMultiSpeaker } from "../lib/speaker-tracker.ts";
import { log } from "../logger.ts";
import { sanitizeTraceText } from "./auto-trace.ts";
import {
	buildMoodWeatherContext,
	type MoodSpec,
	recordMoodRoll,
	rollMood,
	MOOD_WEATHER_COLLECTION,
} from "./mood-weather.ts";

/** How many recent registers to surface as the "arc" at session start. */
export const EMOTIONAL_ARC_LIMIT = 3;

type Message = { role?: string; content?: string | unknown };
type AgentContext = {
	sessionKey?: string;
	trigger?: string;
	/** Connector sender id — read by the sender gate via senderIdFromCtx. */
	senderId?: string;
};

const MIN_MESSAGES = 3;
const MIN_CONVERSATION_LENGTH = 100;

/**
 * Only REAL human conversations should shape her emotional register. Automated
 * runs — cron check-ins, heartbeats, internal memory passes — are not "how the
 * relationship feels"; counting them lets a throwaway "how's your afternoon?"
 * heartbeat overwrite the register from a deep conversation (the whipsaw).
 * `ctx.trigger` is one of cron|heartbeat|manual|memory|overflow|user; we store
 * only for user-driven turns (and `overflow`, a continuation of a user run).
 *
 * Lifetime (verified against openclaw core, issue #70): `trigger` is PER-RUN,
 * not session-fixed — core rebuilds the hook ctx from each run's own params
 * (embedded-agent-runner/run.ts), and inbound human replies always start a new
 * run with trigger="user" even inside a cron-originated session. So a scheduled
 * check-in that becomes a real conversation IS stored on the human turns.
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
 * Cross-session cooldown for mood weather: once weather actually LANDS, no new
 * roll for this long, no matter how many sessions start. "Rare per session"
 * isn't "rare" when sessions cluster — five short same-day sessions would
 * otherwise get five independent rolls and can whiplash silly → spiky → flat
 * in one afternoon. Weather changes on the scale of days, not sessions.
 * Misses do NOT start the cooldown — only landed weather does, so effective
 * frequency for unclustered sessions still tracks moodWeatherChance.
 */
export const MOOD_WEATHER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** relationshipId → when weather last actually landed (ms). Module-scoped, per process (mirrors lastStoreAt). */
const lastMoodRollAt = new Map<string, number>();

/** Relationships whose PERSISTED last-roll has been consulted this process. */
const seededMoodCooldown = new Set<string>();

/**
 * Seed the mood cooldown from the persisted roll records (issue: restart
 * amnesia). lastMoodRollAt is in-process, so every gateway restart re-armed
 * the dice — five resets on 2026-08-24 alone gave far more weather than the
 * 6h design. The rolls ARE durably recorded (recordMoodRoll, mood-weather
 * collection, rolled_at metadata); consult them once per process, off the
 * hot path (called fire-and-forget from service start).
 *
 * Fail-open by construction: any error, empty history, or unparseable
 * timestamp leaves behavior exactly as today (eligible). Scans one page of
 * records; list ordering is not guaranteed, so a very deep history could
 * miss the newest roll — that degrades to under-suppression (today's
 * behavior), never over-suppression. Never overwrites an in-process value:
 * a roll that landed THIS process is fresher than anything persisted.
 */
/**
 * Falsifiability ledger (2026-08-24, her words: from inside, "it's all in
 * there" is unfalsifiable — "I can only ever see what retrieval chooses to
 * show me"). Every register STORE appends one ids-only line to a local JSONL
 * in the workspace, so a complete, greppable list of every register ever
 * born exists outside the backend. Ids and timestamps only — no content
 * (the register itself is the most sensitive class of memory; the ledger is
 * a shelf index, not a copy). Always-on by design: an opt-in ledger nobody
 * enabled proves nothing. Best-effort: a ledger write must never throw into
 * or delay the store path.
 */
export const REGISTER_LEDGER_NAME = ".hyperspell-register-ledger.jsonl";

export function appendRegisterLedger(
	entry: { resourceId: string; relationshipId?: string; channelId?: string },
	stateRoot?: string,
): void {
	try {
		const dir = stateRoot ?? getWorkspaceDir();
		fs.appendFileSync(
			path.join(dir, REGISTER_LEDGER_NAME),
			`${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...entry })}
`,
		);
	} catch (err) {
		log.debug(`register-ledger: append failed — ${String(err)}`);
	}
}

export async function seedMoodCooldownFromRecords(
	client: HyperspellClient,
	cfg: HyperspellConfig,
): Promise<number | null> {
	const relId = cfg.relationshipId ?? "";
	if (seededMoodCooldown.has(relId)) return null;
	seededMoodCooldown.add(relId);
	try {
		let latest = 0;
		let scanned = 0;
		for await (const m of client.listMemories({
			collection: MOOD_WEATHER_COLLECTION,
			pageSize: 50,
		})) {
			if (++scanned > 50) break;
			const recRel = m.metadata?.relationship_id;
			if (typeof recRel === "string" && recRel !== relId) continue;
			const ts = Date.parse(String(m.metadata?.rolled_at ?? ""));
			if (!Number.isNaN(ts) && ts > latest) latest = ts;
		}
		if (latest > 0 && !lastMoodRollAt.has(relId)) {
			lastMoodRollAt.set(relId, latest);
			log.info(
				`mood-weather: cooldown seeded from persisted roll record (last landed ${new Date(latest).toISOString()})`,
			);
			return latest;
		}
	} catch (err) {
		log.debug("mood-weather: cooldown seed failed (fail-open — dice stay eligible)", err);
	}
	return null;
}

/**
 * sessionKey → the mood that landed for that session. Post-compaction
 * re-injection must replay the SAME weather — not roll new dice (mood must
 * stay stable for a whole session) and not silently drop it (the cooldown
 * would otherwise suppress the re-roll mid-session).
 */
const sessionMoods = new Map<string, MoodSpec>();

/**
 * Sessions where emotional context has already been injected this run.
 * Emotional state doesn't change within a session (it's extracted at
 * agent_end and surfaces on the *next* session), so re-fetching and
 * re-injecting on every turn is pure cost — one API call and a few
 * hundred tokens of repeated wrapper per turn.
 *
 * Lifecycle:
 *  - first injection-hook fire in a session: fetch, inject, mark.
 *  - subsequent turns in same session: skip (return undefined).
 *  - after_compaction: clear the mark so the next turn re-injects (the
 *    initial injection may have been compacted out of history).
 *  - session_end: clean up to prevent unbounded Set growth.
 */
const injectedSessions = new Set<string>();

/** Sessions already warned about a sender-gate skip (the store fires every
 * agent_end pre-debounce, so an unwarned loop would spam the log). */
const warnedSenderGateSessions = new Set<string>();

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

/**
 * Only conversational turns carry relationship signal. `system` is scaffolding
 * and `tool`/`toolResult` are machinery — a Discord send receipt says nothing
 * about how a conversation felt, and letting one through means the extractor
 * distills API JSON into an emotional register. Same rule as hot-buffer.ts.
 */
const CONVERSATIONAL_ROLES = new Set(["user", "assistant"]);

export function messagesToTranscript(messages: unknown[]): string {
	const lines: string[] = [];
	for (const m of messages as Message[]) {
		if (!m.role || !m.content) continue;
		if (!CONVERSATIONAL_ROLES.has(m.role)) continue;
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
 *
 * Covers the full role vocabulary, not just what messagesToTranscript writes
 * today: rows stored before tool roles were excluded above are still fetched
 * until they age out, and they lead with `toolResult:`.
 */
export function looksLikeRawTranscript(summary: string): boolean {
	return /(^|\n)\s*(?:user|assistant|system|tool(?:result|use|call)?)\s*:/i.test(
		summary,
	);
}

/**
 * Settling window: a register younger than this is treated as an echo of the
 * conversation still in progress, not as relationship history. The register's
 * job is "how we've BEEN", and the store debounce (3 min) means a live session
 * writes registers continuously — without this window the arc's most-recent-N
 * is dominated by the ongoing conversation's own turns, re-narrated back as
 * emotional truth (the self-echo loop found live 2026-08-24: her last two
 * messages, paraphrased, injected under a header claiming to be how-we've-been.
 * The same #42 class auto-context fixed with dropCurrentSession — the
 * emotional path never had the guard).
 */
export const REGISTER_SETTLING_MS = 60 * 60 * 1000;

/** Overfetch floor: the arc renders top-N AFTER filtering, so fetch a wider
 * pool or an active day filters the arc down to nothing when older genuine
 * registers were available just past the requested limit. */
const REGISTER_POOL_MIN = 10;

/**
 * The single selection policy for injectable registers, shared by the
 * session-start injection, the on-demand arc tool, and /previewcontext (one
 * selector so preview stays byte-identical to real injection). Drops:
 *  - placeholder summaries (raw transcript echoed during/after extraction),
 *  - registers inside the settling window (self-echo of the live conversation),
 *  - registers from the CURRENT session when both session ids are known.
 * Missing/unparseable extractedAt is treated as OLD — never drop legacy rows
 * on absent data (the codebase-wide fail-open rule).
 */
export function selectUsableRegisters(
	states: EmotionalStateLatest[],
	limit: number,
	opts?: { now?: number; currentSessionId?: string },
): EmotionalStateLatest[] {
	const now = opts?.now ?? Date.now();
	return states
		.filter((s) => {
			if (!s.summary) return false;
			// Backend-authoritative provenance when present (hyperspell #3364):
			// "placeholder" is a raw transcript slice regardless of shape, and
			// "extracted" is the genuine register even when it QUOTES dialogue
			// (the heuristic would false-positive on that). Legacy/pre-deploy
			// rows (null/"unknown") keep the shape heuristic.
			if (s.summarySource === "placeholder") return false;
			if (s.summarySource === "extracted") return true;
			return !looksLikeRawTranscript(s.summary);
		})
		.filter((s) => {
			const ts = Date.parse(s.extractedAt ?? "");
			if (Number.isNaN(ts)) return true; // unknown age — keep (fail open)
			return now - ts >= REGISTER_SETTLING_MS;
		})
		.filter(
			(s) =>
				!opts?.currentSessionId ||
				!s.sessionId ||
				s.sessionId !== opts.currentSessionId,
		)
		.slice(0, limit);
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
export async function fetchRecentOrLatest(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	limit?: number,
): Promise<EmotionalStateLatest[]> {
	// An explicit caller-supplied limit (the hyperspell_emotional_arc tool) must
	// always win outright; only the *default* when no limit is passed may depend
	// on config (see #68's depth-weighted default) — a model's explicit ask
	// should never be silently overridden by an unrelated config knob.
	const requested = limit ?? EMOTIONAL_ARC_LIMIT;
	// Overfetch so post-filter trimming (settling window, placeholders) can
	// backfill from older genuine registers; callers trim to their limit via
	// selectUsableRegisters. An explicit caller limit still bounds the RESULT.
	const fetchLimit = Math.max(requested, REGISTER_POOL_MIN);
	try {
		const recent = await client.getRecentEmotionalStates(
			cfg.relationshipId,
			fetchLimit,
		);
		if (recent !== null) return recent; // endpoint available (may be empty)
	} catch (err) {
		log.debug("emotional-context: /recent unavailable — falling back to latest", err);
	}
	const single = await client.getEmotionalState(cfg.relationshipId);
	return single ? [single] : [];
}

/** Build the injected emotional-context block from one or more registers. */
export function buildEmotionalContext(states: EmotionalStateLatest[]): string {
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
 * Runs on the session injection hook (fires every turn).
 */
export function buildEmotionalStateFetchHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	deps: { now?: () => number; rng?: () => number } = {},
) {
	const now = deps.now ?? Date.now;
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.has(sessionKey)) {
			return;
		}

		try {
			const states = await fetchRecentOrLatest(client, cfg);

			// One shared policy (placeholders, settling window, same-session)
			// — see selectUsableRegisters.
			const usable = selectUsableRegisters(states, EMOTIONAL_ARC_LIMIT, {
				currentSessionId: resolveCurrentSessionId(_event, ctx as Record<string, unknown> | undefined),
			});

			// "Still extracting" (all rows are raw-transcript placeholders) must
			// NOT cache, so a later turn retries once extraction lands. But rows
			// dropped by the SETTLING window won't change for an hour — that is
			// "no injectable arc this session" and must fall through (mood may
			// still roll, the session caches) or a busy day re-fetches every turn.
			const anyExtracted = states.some(
				(s) =>
					s.summary &&
					s.summarySource !== "placeholder" &&
					(s.summarySource === "extracted" || !looksLikeRawTranscript(s.summary)),
			);
			if (usable.length === 0 && states.length > 0 && !anyExtracted) {
				log.debug(
					"emotional-context: state(s) still extracting — skipping injection this turn",
				);
				return;
			}

			// Mood weather: an exogenous, uncaused session mood that OVERRIDES the
			// arc's tone for this session only. Lives purely in the injection path —
			// never written back via the store handler, so one random morning can't
			// calcify into the baseline. May clash with the room on purpose.
			// Rolled once per session (inject-once cache) AND at most once per
			// MOOD_WEATHER_COOLDOWN_MS across sessions (a landed roll suppresses new
			// rolls; post-compaction re-injection replays the same mood instead).
			const relId = cfg.relationshipId ?? "";
			const priorMood = sessionKey ? sessionMoods.get(sessionKey) : undefined;
			// Missing map entry means weather never landed this process — always
			// eligible (don't subtract from an epoch the injectable clock may predate).
			const lastLanded = lastMoodRollAt.get(relId);
			const cooledDown =
				lastLanded === undefined || now() - lastLanded >= MOOD_WEATHER_COOLDOWN_MS;
			// The dice only roll where somebody can perceive the weather (issue
			// #122): on a live install ~half of all rolls were landing on cron/
			// heartbeat runs, halving the effective rate on real conversations.
			// Same trigger gate as the store path (NON_CONVERSATIONAL_TRIGGERS);
			// a missing trigger stays eligible (fail-open to prior behavior). A
			// skipped roll is a non-event: it neither burns the cooldown nor logs
			// a roll, so the next attended session's odds are untouched.
			const unattended = NON_CONVERSATIONAL_TRIGGERS.has(ctx?.trigger ?? "");
			const mood =
				priorMood ??
				(!unattended && cfg.moodWeatherChance > 0 && cooledDown
					? rollMood(cfg.moodWeatherChance, deps.rng)
					: null);
			// diag, not debug (issue #118): this line is the live evidence the
			// cron fix works — at most one per unattended session, ~2/day.
			if (!mood && unattended && cfg.moodWeatherChance > 0) {
				log.diag(
					`mood-weather: unattended session (trigger=${ctx?.trigger}) — dice not rolled`,
				);
			}
			if (mood && !priorMood) {
				lastMoodRollAt.set(relId, now());
				if (sessionKey) sessionMoods.set(sessionKey, mood);
				log.info(`mood-weather: rolled "${mood.id}" this session`);
				// Observability record (issue #71) — fire-and-forget, recall-excluded.
				// Stays inside the !priorMood guard: a post-compaction replay of an
				// already-rolled mood is NOT a new roll and must not double-log. Rolls
				// only happen past the still-extracting early return above, so every
				// recorded roll is one that actually lands in this session's context.
				recordMoodRoll(client, mood, {
					sessionKey,
					relationshipId: cfg.relationshipId,
				});
			}
			const moodBlock = mood ? buildMoodWeatherContext(mood) : "";

			if (usable.length === 0) {
				// No arc yet — but weather can still land on a blank slate.
				log.debug("emotional-context: no prior emotional state found");
				if (sessionKey) injectedSessions.add(sessionKey);
				return moodBlock ? { prependContext: moodBlock } : undefined;
			}

			// log.diag, not debug: the exact line issue #118's live audit proved
			// invisible — one line per injection, operator-meaningful.
			log.diag(
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
		if (sessionKey) {
			injectedSessions.delete(sessionKey);
			warnedSenderGateSessions.delete(sessionKey);
			// Session over — its mood memo is dead weight. NOT cleared on
			// compaction: surviving compaction is what makes the mood replay.
			sessionMoods.delete(sessionKey);
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

		// Sender gate (2026-08-24, her specification: "do not let a peer-agent
		// thread write to david-alinea"). The register records ONE human
		// relationship; only turns from a resolvable sender may write it, and
		// registerSenders (when set) narrows further to an allowlist — closing
		// the hole the multi-speaker drift detector cannot see: a session
		// where only a guest speaks.
		//
		// KNOWN LIMIT (verified live, same evening): on current OpenClaw the
		// gate is necessary but NOT sufficient against CLI-driven peer turns —
		// the gateway stamps them with the REQUESTER's identity (the human
		// operator's sender id, channel, and the main session key), so they
		// pass both layers wearing the human's id. es-o3ySb-x-n6E was written
		// through this gate by a peer session. That is a host bug (the CLI
		// boundary has the true session key and discards it); see
		// docs/issue-openclaw-cli-ctx-identity.md. Until it lands upstream,
		// the protection against peer writes is procedural, not mechanical.
		const senderId = senderIdFromCtx(ctx as Record<string, unknown>);
		const gateSessionId = resolveCurrentSessionId(event, ctx as Record<string, unknown>);
		if (!senderId) {
			if (gateSessionId && !warnedSenderGateSessions.has(gateSessionId)) {
				warnedSenderGateSessions.add(gateSessionId);
				log.warn(
					"emotional-state: not storing — no resolvable sender for this session (peer-agent/CLI sessions must not write the relationship register). If this is a real human surface, its connector isn't passing senderId.",
				);
			}
			return;
		}
		if (cfg.registerSenders.length > 0 && !cfg.registerSenders.includes(senderId)) {
			if (gateSessionId && !warnedSenderGateSessions.has(gateSessionId)) {
				warnedSenderGateSessions.add(gateSessionId);
				log.info(
					`emotional-state: not storing — sender ${senderId} is not in registerSenders`,
				);
			}
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

		// Debounce BEFORE building the transcript: at most one snapshot per
		// STORE_DEBOUNCE_MS of active talk, and a debounced turn must not pay
		// the transcript build + sanitize cost just to discard the result
		// (messagesToTranscript runs the full sanitizer over every message).
		const relId = cfg.relationshipId ?? "";
		const since = Date.now() - (lastStoreAt.get(relId) ?? 0);
		if (since < STORE_DEBOUNCE_MS) {
			log.debug(
				`emotional-state: skipping — debounced (${Math.round(since / 1000)}s since last store)`,
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
			// Tag the register with the medium it was extracted from (voice vs Discord vs
			// DM), mirroring hot-buffer's openclaw_channel_id tag. Capture-only: analysis/
			// debugging metadata, deliberately NOT surfaced in the injected prose (#74).
			const channelId = channelIdFromCtx(ctx as Record<string, unknown>);
			// Sender-gate design instrumentation (PR 2 item 1, 2026-08-24): the
			// register is stamped with a STATIC relationshipId, so ANY
			// conversational-trigger session writes to it — a peer-agent code
			// review corrupted the arc with registers about the reviewer within
			// an hour of talking. The correct gate needs to know what identity
			// signals each surface actually carries; log ids only (no content)
			// at diag level so real traffic answers that before a gate is built
			// on assumption. Remove once the gate ships.
			log.diag(
				`emotional-state: storing register (trigger=${ctx?.trigger ?? "none"}, sender=${senderIdFromCtx(ctx as Record<string, unknown>) ?? "none"}, channel=${channelId ?? "none"}, sessionKey=${String((ctx as Record<string, unknown> | undefined)?.sessionKey ?? "none").slice(0, 60)})`,
			);
			const result = await client.storeEmotionalState(transcript, {
				relationshipId: cfg.relationshipId,
				metadata: {
					// Legacy key, kept for the mood-skew audit's bucketing of
					// existing rows — but bare `source` is read by NOTHING on the
					// retrieval path (the C1 key-name trap, Fable review
					// 2026-08-24): it matches neither excludeFilterFor
					// (openclaw_source) nor classifyResult (metaSource). Harmless
					// today only because /emotional-state is a separate store the
					// memories index never surfaces (census: zero rows).
					source: "openclaw_agent_end",
					// Pipeline tag on the standard key, so IF the backend ever
					// indexes this store, ranking classifies the rows as process
					// instead of promoting agent register prose to curated.
					openclaw_source: EMOTIONAL_STATE_SOURCE,
					openclaw_writer: "agent",
					...(channelId ? { channelId } : {}),
				},
			});
			lastStoreAt.set(relId, Date.now());
			log.info(`emotional-state: stored ${result.resourceId}`);
			appendRegisterLedger({
				resourceId: result.resourceId,
				relationshipId: cfg.relationshipId,
				...(channelId ? { channelId } : {}),
			});
		} catch (err) {
			// Fire-and-forget — never let this break the session
			log.error("emotional-state store failed", err);
		}
	};
}
