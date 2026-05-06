import type { HyperspellClient, SearchResult } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import { resolveUser } from "../lib/sender.ts";
import { log } from "../logger.ts";

type AgentContext = Record<string, unknown> & { sessionKey?: string };

const RECENT_FILTER = { openclaw_source: "agent_end" } as const;

/**
 * Track which sessions already received the orientation injection. The block is
 * expensive (two search calls + a few hundred tokens of wrapper) and its
 * contents don't change within a session, so inject-once is the right shape.
 * Lifecycle mirrors the emotional-context hook: first turn injects, later turns
 * skip, `after_compaction` clears (injection may have been trimmed), and
 * `session_end` deletes to keep the Set bounded.
 */
const injectedSessions = new Set<string>();

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
		const title = r.title ?? `[${r.source}]`;
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
		const title = r.title ?? `[${r.source}]`;
		bullets.push(`- ${title}: ${top.text.replace(/\n/g, " ")}`);
	}
	return bullets.length > 0 ? bullets.join("\n") : null;
}

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString();
}

/**
 * Resolve the userId to use for personal searches. In multi-user mode, skip
 * entirely for unknown senders — orientation is "what have *I* been doing", and
 * an unresolved caller has no personal space to orient to. In single-user mode,
 * return undefined so the client falls back to its configured userId.
 */
function personalUserId(
	cfg: HyperspellConfig,
	ctx: AgentContext | undefined,
): { skip: boolean; userId?: string } {
	if (!cfg.multiUser) return { skip: false, userId: undefined };
	const resolved = resolveUser(ctx, cfg);
	if (!resolved?.resolved) return { skip: true };
	return { skip: false, userId: resolved.userId };
}

export function buildStartupOrientationHandler(
	client: HyperspellClient,
	cfg: HyperspellConfig,
) {
	const so = cfg.startupOrientation;
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.has(sessionKey)) return;

		const { skip, userId } = personalUserId(cfg, ctx);
		if (skip) {
			log.debug(
				"startup-orientation: skipping — unknown sender in multi-user mode",
			);
			if (sessionKey) injectedSessions.add(sessionKey);
			return;
		}

		const after = isoDaysAgo(so.recentDays);

		const [recentSettled, loopsSettled] = await Promise.allSettled([
			client.search(so.recentQuery, {
				limit: so.recentLimit,
				after,
				filter: RECENT_FILTER,
				userId,
			}),
			client.search(so.loopsQuery, {
				limit: so.loopsLimit,
				userId,
			}),
		]);

		const recent =
			recentSettled.status === "fulfilled" ? recentSettled.value : [];
		if (recentSettled.status === "rejected") {
			log.error(
				"startup-orientation: recent search failed",
				recentSettled.reason,
			);
		}
		const loops = loopsSettled.status === "fulfilled" ? loopsSettled.value : [];
		if (loopsSettled.status === "rejected") {
			log.error(
				"startup-orientation: loops search failed",
				loopsSettled.reason,
			);
		}

		const recentBody = formatRecentInteractions(recent);
		const loopsBody = formatUnfinishedLoops(loops);

		if (sessionKey) injectedSessions.add(sessionKey);

		if (!recentBody && !loopsBody) {
			log.debug("startup-orientation: nothing to inject");
			return;
		}

		const blocks: string[] = [];
		if (recentBody) {
			blocks.push(
				[
					"<hyperspell-recent-interactions>",
					`Your last ${so.recentDays} days of conversations with this user, most-relevant-first. Use for situational continuity — don't quote verbatim.`,
					"",
					recentBody,
					"</hyperspell-recent-interactions>",
				].join("\n"),
			);
		}
		if (loopsBody) {
			blocks.push(
				[
					"<hyperspell-unfinished-loops>",
					"Possible open threads — promises made, questions pending, work in progress. Low-confidence retrieval; treat as prompts to consider, not facts to act on.",
					"",
					loopsBody,
					"</hyperspell-unfinished-loops>",
				].join("\n"),
			);
		}

		log.debug(
			`startup-orientation: injecting recent=${recent.length} loops=${loops.length}`,
		);
		return { prependContext: blocks.join("\n\n") };
	};
}

export function buildStartupOrientationCompactionHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey && injectedSessions.delete(sessionKey)) {
			log.debug(
				`startup-orientation: cache cleared after compaction (session=${sessionKey})`,
			);
		}
	};
}

export function buildStartupOrientationSessionCleanupHandler() {
	return async (_event: Record<string, unknown>, ctx?: AgentContext) => {
		const sessionKey = ctx?.sessionKey;
		if (sessionKey) injectedSessions.delete(sessionKey);
	};
}
