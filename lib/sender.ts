import type { HyperspellConfig } from "../config.ts"
import { log } from "../logger.ts"

export interface ResolvedUser {
  userId: string
  name: string
  context?: string
  /** True if the sender was matched in senderMap; false if falling back to sharedUserId */
  resolved: boolean
}

/**
 * Resolve the sender's Hyperspell user from hook or tool context.
 *
 * Matches sender handles in the multiUser.senderMap against the sessionKey
 * using substring matching. Handles are sorted longest-first to prevent
 * partial matches (e.g., Discord ID "123" matching inside "1234567").
 *
 * Falls back to sharedUserId for unrecognized senders.
 */
export function resolveUser(
  ctx: Record<string, unknown> | undefined,
  cfg: HyperspellConfig,
): ResolvedUser | undefined {
  const multiUser = cfg.multiUser
  if (!multiUser) {
    // Single-user mode: return config.userId if set
    return cfg.userId ? { userId: cfg.userId, name: cfg.userId, resolved: true } : undefined
  }

  // Try direct senderId lookup (available in slash command contexts;
  // tool factory contexts do NOT include senderId — they have sessionKey instead)
  const senderId = (ctx?.senderId as string) ?? (ctx?.requesterSenderId as string) ?? undefined
  if (senderId && multiUser.senderMap[senderId]) {
    const profile = multiUser.senderMap[senderId]
    log.debug(`sender resolved via senderId: ${senderId} -> ${profile.userId}`)
    return { ...profile, resolved: true }
  }

  // Try sessionKey substring matching (works in both hook and tool factory contexts)
  const sessionKey = ctx?.sessionKey as string | undefined
  if (sessionKey) {
    const sortedEntries = Object.entries(multiUser.senderMap)
      .sort(([a], [b]) => b.length - a.length)
    for (const [handle, profile] of sortedEntries) {
      if (sessionKey.includes(handle)) {
        log.debug(`sender resolved via sessionKey: ${handle} -> ${profile.userId}`)
        return { ...profile, resolved: true }
      }
    }
  }

  // Fallback: use sharedUserId for unknown senders
  log.debug("sender unresolved, falling back to sharedUserId")
  return {
    userId: multiUser.sharedUserId,
    name: multiUser.sharedUserId,
    resolved: false,
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
