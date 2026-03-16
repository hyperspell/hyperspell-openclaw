import type { HyperspellConfig } from "../config.ts"
import { log } from "../logger.ts"

export interface ResolvedUser {
  userId: string
  name: string
  context?: string
}

/**
 * Resolve the sender's Hyperspell user from hook or tool context.
 *
 * Matches sender handles in the multiUser.senderMap against the sessionKey
 * using substring matching. Handles are sorted longest-first to prevent
 * partial matches (e.g., Discord ID "123" matching inside "1234567").
 *
 * Falls back to config.userId for unrecognized senders.
 */
export function resolveUser(
  ctx: Record<string, unknown> | undefined,
  cfg: HyperspellConfig,
): ResolvedUser | undefined {
  const multiUser = cfg.multiUser
  if (!multiUser) {
    // Single-user mode: return config.userId if set
    return cfg.userId ? { userId: cfg.userId, name: cfg.userId } : undefined
  }

  // Try direct senderId lookup (available in command context and tool factory context)
  const senderId = (ctx?.senderId as string) ?? (ctx?.requesterSenderId as string) ?? undefined
  if (senderId && multiUser.senderMap[senderId]) {
    const profile = multiUser.senderMap[senderId]
    log.debug(`sender resolved via senderId: ${senderId} -> ${profile.userId}`)
    return profile
  }

  // Try sessionKey substring matching
  const sessionKey = ctx?.sessionKey as string | undefined
  if (sessionKey) {
    const sortedEntries = Object.entries(multiUser.senderMap)
      .sort(([a], [b]) => b.length - a.length)
    for (const [handle, profile] of sortedEntries) {
      if (sessionKey.includes(handle)) {
        log.debug(`sender resolved via sessionKey: ${handle} -> ${profile.userId}`)
        return profile
      }
    }
  }

  // Fallback: use sharedUserId for unknown senders
  log.debug("sender unresolved, falling back to sharedUserId")
  return {
    userId: multiUser.sharedUserId,
    name: "unknown",
  }
}

/**
 * Get all unique userIds from the multiUser config (for knowledge graph scanning).
 */
export function getAllUserIds(cfg: HyperspellConfig): string[] {
  if (!cfg.multiUser) {
    return cfg.userId ? [cfg.userId] : []
  }

  const userIds = new Set<string>()
  for (const profile of Object.values(cfg.multiUser.senderMap)) {
    userIds.add(profile.userId)
  }
  userIds.add(cfg.multiUser.sharedUserId)
  return [...userIds]
}
