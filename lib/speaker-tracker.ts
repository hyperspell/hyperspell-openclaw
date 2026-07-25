/**
 * Per-session speaker tracking — evidence-based multi-speaker detection.
 *
 * PR #60 gated all group-chat guards on `is_group_chat: true` from the
 * inbound envelope. That field is set by the platform connector and not all
 * connectors set it consistently (Discord channels, Slack DM groups, voice
 * rooms). This module tracks distinct sender_ids observed within each session
 * so multi-speaker detection works from evidence rather than a connector
 * boolean.
 *
 * Lifecycle:
 *   - record() on every turn that has a resolvable senderId (hot-buffer agent_end,
 *     auto-context injection hook)
 *   - isMultiSpeaker() checked by any hook or tool that needs to guard behaviour
 *   - cleanup() on session_end, called from the hot-buffer cleanup handler
 */

/** sessionId → set of distinct sender_ids seen in that session */
const sessionSenders = new Map<string, Set<string>>()

/**
 * Record a sender_id for a session. No-op if senderId is empty/undefined.
 * Called on every turn so the tracker accumulates evidence across the session.
 */
export function recordSender(sessionId: string, senderId: string | undefined): void {
  if (!senderId) return
  if (!sessionSenders.has(sessionId)) sessionSenders.set(sessionId, new Set())
  sessionSenders.get(sessionId)!.add(senderId)
}

/**
 * Resolve the senderId from a hook context, checking both camelCase
 * (OpenClaw-normalised) and snake_case (raw connector form).
 */
export function senderIdFromCtx(ctx: Record<string, unknown> | undefined): string | undefined {
  return (
    (ctx?.senderId as string | undefined) ??
    (ctx?.sender_id as string | undefined) ??
    (ctx?.requesterSenderId as string | undefined) ??
    undefined
  )
}

/**
 * True when two or more distinct sender_ids have appeared in this session, OR
 * when the connector explicitly signalled `is_group_chat: true`. Either is
 * sufficient — the envelope flag catches cases before the second sender speaks;
 * the tracker catches cases where the flag was never set.
 */
export function isMultiSpeaker(
  sessionId: string | undefined,
  envelopeGroupChat?: boolean,
): boolean {
  if (envelopeGroupChat) return true
  if (!sessionId) return false
  return (sessionSenders.get(sessionId)?.size ?? 0) > 1
}

/** Drop the per-session entry on session end to prevent unbounded growth. */
export function cleanupSpeakerSession(sessionId: string): void {
  sessionSenders.delete(sessionId)
}
