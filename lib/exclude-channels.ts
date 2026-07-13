/**
 * Channel-level memory quarantine (`excludeChannels` config).
 *
 * A channel on the list gets NO memory surface at all, in both directions:
 * no context injection (auto-context, emotional state, startup orientation),
 * no memory writes (hot buffer, auto-trace, emotional store), and no memory
 * tools. Use it for conversations that must never mix with the owner's vault —
 * e.g. a channel someone else drives (a shared game, a public bot surface).
 *
 * Matching is against the conversation id OpenClaw resolves for the session
 * (`ctx.channelId` on agent hook contexts — e.g. a Discord channel id). Tool
 * factory contexts don't carry `channelId`, so we recover the same id from the
 * composite `sessionKey` (`agent:<agentId>:<provider>:<kind>:<id>[...]`).
 *
 * Quarantine is FORWARD-ONLY: it stops future injection/writes/tools but does
 * not remove already-synced content. Retroactive cleanup of channel-tagged
 * rows is the `purge-channel` CLI command (commands/purge-channel.ts).
 */

// Conversation-kind segments used in OpenClaw session keys. Mirrors core's
// TARGET_PREFIXES (src/plugins/hook-agent-context.ts) so the sessionKey
// fallback resolves the same id core would put on ctx.channelId.
const TARGET_KINDS = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"])

/**
 * Extract the conversation id from a composite session key, e.g.
 * `agent:main:discord:channel:123` → `123`. Thread/run suffixes stay attached
 * (`...:channel:123:thread:456` → `123:thread:456`); the prefix match in
 * `isExcludedChannel` handles them. Returns undefined when the key has no
 * recognizable conversation segment (cron runs, bare UUIDs, ...).
 */
export function conversationIdFromSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return undefined
  const parts = sessionKey.split(":").filter((p) => p.length > 0)
  const body =
    parts[0]?.toLowerCase() === "agent" && parts.length >= 3 ? parts.slice(2) : parts
  if (body.length >= 3 && TARGET_KINDS.has(body[1]?.toLowerCase() ?? "")) {
    return body.slice(2).join(":")
  }
  return undefined
}

/** Resolve the conversation id from any hook or tool-factory context. */
export function channelIdFromCtx(ctx?: Record<string, unknown>): string | undefined {
  const direct = ctx?.channelId
  if (typeof direct === "string" && direct.length > 0) return direct
  return conversationIdFromSessionKey(ctx?.sessionKey)
}

/**
 * True when a stored conversation id belongs to `channel` — exact match or a
 * thread suffix (`<channel>:thread:<n>`), case-insensitive. Shared by the
 * quarantine check and the purge-channel CLI so "what gets blocked" and "what
 * gets purged" can never drift apart.
 */
export function conversationMatchesChannel(id: string, channel: string): boolean {
  const a = id.toLowerCase()
  const b = channel.toLowerCase()
  return a === b || a.startsWith(`${b}:`)
}

/**
 * True when the context's conversation is quarantined. Purely subtractive on
 * failure: an unresolvable id means "not excluded" — a session we can't place
 * keeps normal memory behavior rather than silently losing it.
 */
export function isExcludedChannel(
  ctx: Record<string, unknown> | undefined,
  cfg: { excludeChannels: string[] },
): boolean {
  if (cfg.excludeChannels.length === 0) return false
  const id = channelIdFromCtx(ctx)
  if (!id) return false
  return cfg.excludeChannels.some((entry) => conversationMatchesChannel(id, entry))
}
