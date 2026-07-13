/**
 * Pure logic for the `purge-channel` CLI command: retroactive cleanup of
 * memories synced from a (typically quarantined) channel. `excludeChannels`
 * is forward-only, so content written before a channel was quarantined stays
 * in Hyperspell — this finds and deletes it.
 *
 * Discovery enumerates `listMemories` and filters CLIENT-SIDE: the list
 * endpoint exposes no metadata filter, and `search()` is query-driven top-N,
 * not exhaustive — never use it for a purge.
 */
import type { HyperspellClient } from "../client.ts"
import type { HyperspellSource } from "../config.ts"
import { conversationMatchesChannel } from "../lib/exclude-channels.ts"

export type PurgeMatch = {
  resourceId: string
  source: HyperspellSource
  title: string | null
  /** How the memory was attributed to the channel. */
  via: "channel_tag" | "session_id" | "explicit"
}

export type PurgeResult = { matched: PurgeMatch[]; deleted: number; failed: number }

/**
 * Enumerate the given sources and return every memory attributable to
 * `channelId` — via the `openclaw_channel_id` metadata tag (exact or
 * thread-suffix, same semantics as the quarantine check), or via the
 * hot-buffer `resourceId === sessionId` identity for legacy untagged rows.
 */
export async function findChannelMemories(
  client: HyperspellClient,
  channelId: string,
  opts: { sources: HyperspellSource[]; userId?: string; sessionIds?: string[] },
): Promise<PurgeMatch[]> {
  const matches: PurgeMatch[] = []
  const sessionIds = new Set((opts.sessionIds ?? []).map((s) => s.toLowerCase()))
  for (const source of opts.sources) {
    for await (const m of client.listMemories({ source, userId: opts.userId })) {
      const tagged = m.metadata.openclaw_channel_id
      if (typeof tagged === "string" && conversationMatchesChannel(tagged, channelId)) {
        matches.push({ resourceId: m.resourceId, source: m.source, title: m.title, via: "channel_tag" })
      } else if (sessionIds.has(m.resourceId.toLowerCase())) {
        // Hot-buffer resource_id === sessionId — rows written before channel
        // tagging existed are reachable only through this identity.
        matches.push({ resourceId: m.resourceId, source: m.source, title: m.title, via: "session_id" })
      }
    }
  }
  return matches
}

/** Delete every match. `deleteMemory` is already 404-tolerant (absent = deleted). */
export async function deleteMatches(
  client: HyperspellClient,
  matches: PurgeMatch[],
  opts: { userId?: string },
): Promise<PurgeResult> {
  let deleted = 0
  let failed = 0
  for (const m of matches) {
    const r = await client.deleteMemory(m.resourceId, { source: m.source, userId: opts.userId })
    if (r.deleted) deleted++
    else failed++
  }
  return { matched: matches, deleted, failed }
}

/** Render matches as an aligned `resourceId  source  via  title` table. */
export function formatMatchTable(matches: PurgeMatch[]): string {
  const rows: string[][] = [
    ["RESOURCE ID", "SOURCE", "VIA", "TITLE"],
    ...matches.map((m) => [m.resourceId, m.source, m.via, m.title ?? "-"]),
  ]
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)))
  return rows
    .map((r) => `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`)
    .join("\n")
}

/** Standing limitations — printed on every run so operators aren't surprised. */
export const PURGE_LIMITATIONS_FOOTER =
  "Note: not everything is channel-tagged. Auto-trace resources and /remember memories written by older plugin versions, " +
  "hot-buffer rows written before 2026-07, and emotional-state registers are NOT matched by this command. " +
  "Use --session for legacy hot-buffer rows and --resource for manually identified resources; " +
  'see the "excludeChannels is forward-only" section of the README.'
