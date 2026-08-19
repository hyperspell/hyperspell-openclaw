import type { HyperspellClient, SearchResult } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { excludeFilterFor, HOT_BUFFER_SOURCE } from "../lib/filters.ts";
import { resolveUser } from "../lib/sender.ts";
import { resolveCurrentSessionId } from "../lib/session.ts";
import { isMultiSpeaker } from "../lib/speaker-tracker.ts";
import { log } from "../logger.ts";

type AgentContext = Record<string, unknown> & { sessionKey?: string };

const MAX_ATTEMPTS = 2;
const RECENT_BUFFER_LIMIT = 100;

/** Hot-buffer conversation resources are keyed by the session id (a UUID). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sessions where the orientation block was already injected (or where we
 * deliberately decided not to inject — unknown sender, exhausted retries).
 * Re-checked at the top of every turn; on hit, we skip.
 *
 * Lifecycle mirrors the emotional-context hook: `after_compaction` clears
 * (the original injection may have been trimmed out of history) and
 * `session_end` cleans up to keep both structures bounded.
 */
const injectedSessions = new Set<string>();
/**
 * Counts attempts for sessions where every call has failed so far. We only
 * count failures here, so a session that succeeds on retry will never appear.
 * Capped at MAX_ATTEMPTS — past that we give up and add to injectedSessions.
 */
const failedAttempts = new Map<string, number>();

function formatRelativeTime(iso: string | null): string {
	if (!iso) return "";
	try {
		const dt = new Date(iso);
		const now = new Date();
		const hours = (now.getTime() - dt.getTime()) / 3_600_000;
		if (hours < 1) return "just now";
		if (hours < 24) return `${Math.floor(hours)}h ago`;
		const days = hours / 24;
		if (days < 7) return `${Math.floor(days)}d ago`;
		const month = dt.toLocaleString("en", { month: "short" });
		return `${dt.getDate()} ${month}`;
	} catch {
		return "";
	}
}

function formatRecentInteractions(results: SearchResult[]): string | null {
	if (results.length === 0) return null;
	const lines = results.map((r) => {
		const when = formatRelativeTime(r.createdAt);
		const title = r.title || `[${r.source}]`;
		const prefix = when ? `[${when}] ` : "";
		const top = r.highlights[0]?.text?.replace(/\n/g, " ").slice(0, 140);
		const tail = top ? ` — ${top}` : "";
		return `- ${prefix}${title}${tail}`;
	});
	return lines.join("\n");
}

function formatUnfinishedLoops(results: SearchResult[]): string | null {
	const bullets: string[] = [];
	for (const r of results) {
		const top = r.highlights[0];
		if (!top) continue;
		const title = r.title || `[${r.source}]`;
		bullets.push(`- ${title}: ${top.text.replace(/\n/g, " ")}`);
	}
	return bullets.length > 0 ? bullets.join("\n") : null;
}

function isoDaysAgo(days: number): Date {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}

/**
 * Resolve the userId to use for personal searches. In multi-user mode, skip
 * entirely for unknown senders — orientation is "what have *I* been doing", and
 * an unresolved caller has no personal space to orient to. In single-user mode,
 * return undefined so the client falls back to its configured userId.
 */
export function personalUserId(
	cfg: HyperspellConfig,
	ctx: AgentContext | undefined,
): { skip: boolean; userId?: string } {
	if (!cfg.multiUser) return { skip: false, userId: undefined };
	const resolved = resolveUser(ctx, cfg);
	if (!resolved?.resolved) return { skip: true };
	return { skip: false, userId: resolved.userId };
}

/**
 * Pull recent agent_end traces via listMemories, sorted chronologically.
 *
 * Why list, not search: a date-window + relevance search ranks results by
 * lexical similarity to a generic query, which is approximately random
 * within a 7-day slice and can easily exclude yesterday in favor of a
 * 5-day-old session. listMemories gives us true chronological recall.
 *
 * The SDK's list endpoint doesn't expose date or metadata filters in our
 * wrapper, so we filter client-side. Buffer is capped at
 * RECENT_BUFFER_LIMIT to bound wire cost; if a user has more than that
 * many traces in the cutoff window we'll still get the newest ones,
 * since the underlying API returns recency-ordered pages.
 */
async function fetchRecentTraces(
	client: HyperspellClient,
	cutoff: Date,
	limit: number,
	userId: string | undefined,
	quarantine: readonly string[],
): Promise<SearchResult[]> {
	const buffer: SearchResult[] = [];
	let scanned = 0;
	const cutoffMs = cutoff.getTime();

	for await (const memory of client.listMemories({
		source: "trace",
		userId,
		pageSize: 50,
	})) {
		scanned++;
		if (scanned > RECENT_BUFFER_LIMIT) break;

		// listMemories is unfiltered at the client level (management enumeration
		// must see everything — see lib/quarantine.ts), so this context path
		// applies the retrieval quarantine itself.
		if (quarantine.includes(memory.resourceId)) continue;

		const meta = memory.metadata;
		if (meta.openclaw_source !== "agent_end") continue;

		const createdRaw = meta.created_at;
		if (typeof createdRaw !== "string") continue;
		const createdMs = new Date(createdRaw).getTime();
		if (Number.isNaN(createdMs) || createdMs < cutoffMs) continue;

		buffer.push({
			resourceId: memory.resourceId,
			title: memory.title,
			source: memory.source,
			score: null,
			url: null,
			createdAt: createdRaw,
			metaSource: "agent_end",
			metaSpeakerRole: null,
			metaFilePath: null,
			highlights: [],
		});
	}

	buffer.sort((a, b) => {
		const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
		const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
		return bt - at;
	});
	return buffer.slice(0, limit);
}

/**
 * Pull recent conversation sessions from the hot buffer's vault resources — the
 * modern source of "recent interactions" (the agent_end-trace path only works
 * when auto-trace is on, which it usually isn't). The hot buffer writes one
 * session-grouped Resource per conversation: `resource_id` = the session id (a
 * UUID), tagged `openclaw_source: "hot_buffer"`, with a generated title. We rely
 * on `listMemories` returning resources newest-first (verified live) and take
 * the newest `limit` conversation resources — their metadata carries no date to
 * filter on, so order is our recency signal.
 *
 * Selects ON the hot-buffer tag. This used to skip any row carrying an
 * `openclaw_source` at all, which was correct only while hot rows were untagged;
 * backend #1921 (2026-07-02) started tagging them, so that exclusion began
 * dropping every row it was meant to keep and the block silently vanished.
 * Sibling rows (memory_sync_section / command / agent_end) fail the same check.
 */
async function fetchRecentConversations(
	client: HyperspellClient,
	limit: number,
	userId: string | undefined,
	quarantine: readonly string[],
): Promise<SearchResult[]> {
	const out: SearchResult[] = [];
	const seenTitles = new Set<string>();
	let scanned = 0;
	for await (const memory of client.listMemories({
		source: "vault",
		userId,
		pageSize: 50,
	})) {
		scanned++;
		if (scanned > RECENT_BUFFER_LIMIT) break;
		// Same reason as fetchRecentTraces: this is a context path fed by the
		// deliberately-unfiltered listMemories, so the quarantine applies here.
		if (quarantine.includes(memory.resourceId)) continue;
		if (!UUID_RE.test(memory.resourceId)) continue;
		if (memory.metadata?.openclaw_source !== HOT_BUFFER_SOURCE) continue;
		const title = memory.title ?? "";
		if (title.length === 0 || /^\[cron:/i.test(title)) continue;
		// The backend sometimes generates the same title for distinct sessions
		// (e.g. repeated daily-summary chats); collapse those so the block isn't
		// padded with duplicates.
		const titleKey = title.trim().toLowerCase();
		if (seenTitles.has(titleKey)) continue;
		seenTitles.add(titleKey);
		out.push({
			resourceId: memory.resourceId,
			title: memory.title,
			source: memory.source,
			score: null,
			url: null,
			createdAt: null,
			metaSource: HOT_BUFFER_SOURCE,
			metaSpeakerRole: null,
			metaFilePath: null,
			highlights: [],
		});
		if (out.length >= limit) break; // newest-first → first N are most recent
	}
	return out;
}

export type OrientationGather = {
	recentOk: boolean;
	loopsOk: boolean;
	recentCount: number;
	loopsCount: number;
	/** Fully formatted <hyperspell-recent-interactions> block, or null. */
	recentBlock: string | null;
	/** Fully formatted <hyperspell-unfinished-loops> block, or null. */
	loopsBlock: string | null;
	/** Which recent-interactions source was used: "hotBuffer" | "autoTrace" | "none". */
	recentSource: "hotBuffer" | "autoTrace" | "none";
};

/**
 * The fetch+format core of startup orientation, shared by the real
 * session-start injection handler and the read-only /previewcontext command.
 * Pure with respect to session lifecycle: no inject-once cache, no retry
 * counting — callers own that policy. Keeping one formatter here keeps the
 * preview byte-identical to real injection.
 */
export async function gatherOrientation(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	userId: string | undefined,
): Promise<OrientationGather> {
	const so = cfg.startupOrientation;
	// Source recent-interactions from wherever the session record actually
	// lives. Prefer the hot buffer (modern path: clean session-grouped vault
	// resources, present whenever the hot buffer is on — including auto-trace-
	// off agents). Fall back to agent_end traces only when there's no hot
	// buffer but auto-trace is on. Otherwise skip: there's nothing to fetch,
	// and the trace-source list is expensive (observed ~12s + failing/turn),
	// blocking the injection hook and slowing the reply.
	const recentSource = cfg.hotBuffer.enabled
		? ("hotBuffer" as const)
		: cfg.autoTrace.enabled
			? ("autoTrace" as const)
			: ("none" as const);
	const recentFetch =
		recentSource === "hotBuffer"
			? fetchRecentConversations(
					client,
					so.recentLimit,
					userId,
					cfg.quarantineResources,
				)
			: recentSource === "autoTrace"
				? fetchRecentTraces(
						client,
						isoDaysAgo(so.recentDays),
						so.recentLimit,
						userId,
						cfg.quarantineResources,
					)
				: Promise.resolve([] as SearchResult[]);

	const [recentSettled, loopsSettled] = await Promise.allSettled([
		recentFetch,
		// Loops feed agent context, so tagged observability rows (agent_end
		// traces, mood_weather rolls) must be dropped like on every other recall
		// path — this also closes a pre-existing gap where agent_end traces
		// could surface in the loops block.
		client.search(so.loopsQuery, {
			limit: so.loopsLimit,
			userId,
			filter: excludeFilterFor(cfg),
		}),
	]);

	const recentOk = recentSettled.status === "fulfilled";
	const loopsOk = loopsSettled.status === "fulfilled";
	const recent = recentOk ? recentSettled.value : [];
	const loops = loopsOk ? loopsSettled.value : [];

	if (!recentOk) {
		log.error(
			"startup-orientation: recent listMemories failed",
			(recentSettled as PromiseRejectedResult).reason,
		);
	}
	if (!loopsOk) {
		log.error(
			"startup-orientation: loops search failed",
			(loopsSettled as PromiseRejectedResult).reason,
		);
	}

	const recentBody = formatRecentInteractions(recent);
	const loopsBody = formatUnfinishedLoops(loops);
	return {
		recentOk,
		loopsOk,
		recentCount: recent.length,
		loopsCount: loops.length,
		recentSource,
		recentBlock: recentBody
			? [
					"<hyperspell-recent-interactions>",
					`Your last ${so.recentDays} days of conversations with this user, most-recent-first. Use for situational continuity — don't quote verbatim.`,
					"",
					recentBody,
					"</hyperspell-recent-interactions>",
				].join("\n")
			: null,
		loopsBlock: loopsBody
			? [
					"<hyperspell-unfinished-loops>",
					"Possible open threads — promises made, questions pending, work in progress. Low-confidence retrieval; treat as prompts to consider, not facts to act on.",
					"",
					loopsBody,
					"</hyperspell-unfinished-loops>",
				].join("\n")
			: null,
	};
}

export function buildStartupOrientationHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.has(sessionKey)) return;

		const tries = (sessionKey && failedAttempts.get(sessionKey)) || 0;
		if (tries >= MAX_ATTEMPTS) {
			log.debug(
				`startup-orientation: giving up after ${tries} failed attempt(s)`,
			);
			if (sessionKey) {
				injectedSessions.add(sessionKey);
				failedAttempts.delete(sessionKey);
			}
			return;
		}

		const { skip, userId } = personalUserId(cfg, ctx);
		if (skip) {
			log.debug(
				"startup-orientation: skipping — unknown sender in multi-user mode",
			);
			if (sessionKey) injectedSessions.add(sessionKey);
			return;
		}

		// Skip when multiple speakers are present with no multiUser config.
		// Orientation injects the primary user's personal activity context; in a
		// group chat that leaks their private session history to other participants
		// who may have triggered the session start (attribution v2, gap 2).
		const sessionId = resolveCurrentSessionId(undefined, ctx as Record<string, unknown>);
		if (!cfg.multiUser && isMultiSpeaker(sessionId, (ctx as Record<string, unknown>)?.is_group_chat === true)) {
			log.debug(
				"startup-orientation: skipping — multi-speaker session with no multiUser config (would expose primary user's personal context)",
			);
			if (sessionKey) injectedSessions.add(sessionKey);
			return;
		}

		const gathered = await gatherOrientation(client, cfg, userId);

		if (!gathered.recentOk && !gathered.loopsOk) {
			if (sessionKey) failedAttempts.set(sessionKey, tries + 1);
			log.debug(
				`startup-orientation: both calls failed (attempt ${tries + 1}/${MAX_ATTEMPTS}); will retry next turn`,
			);
			return;
		}

		if (sessionKey) {
			injectedSessions.add(sessionKey);
			failedAttempts.delete(sessionKey);
		}

		if (!gathered.recentBlock && !gathered.loopsBlock) {
			log.debug("startup-orientation: nothing to inject");
			return;
		}

		const blocks = [gathered.recentBlock, gathered.loopsBlock].filter(
			(b): b is string => b !== null,
		);
		// log.diag, not debug: this one-line injection summary is the operator's
		// only live signal that orientation fired (issue #118 — host drops plugin
		// debug output from gateway.log).
		log.diag(
			`startup-orientation: injecting recent=${gathered.recentCount} loops=${gathered.loopsCount}`,
		);
		return { prependContext: blocks.join("\n\n") };
	};
}

export function buildStartupOrientationCompactionHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (!sessionKey) return;
		const dropped = injectedSessions.delete(sessionKey);
		failedAttempts.delete(sessionKey);
		if (dropped) {
			log.debug(
				`startup-orientation: cache cleared after compaction (session=${sessionKey})`,
			);
		}
	};
}

export function buildStartupOrientationSessionCleanupHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (!sessionKey) return;
		injectedSessions.delete(sessionKey);
		failedAttempts.delete(sessionKey);
	};
}
