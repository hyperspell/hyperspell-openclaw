import type {
  CanReadScope,
  HyperspellConfig,
  Role,
  ScopeName,
} from "../config.ts"
import { normalizeScope } from "../config.ts"
import { log } from "../logger.ts"
import { getVoiceIdentifier } from "./voice-id.ts"

export interface ResolvedUser {
  userId: string
  name: string
  context?: string
  /** Profile-level role override from senderMap. Falls back to scoping.users[userId].role. */
  role?: string
  /** True if the sender was matched in senderMap; false if falling back to sharedUserId */
  resolved: boolean
}

function matchFromSenderMap(
  ctx: Record<string, unknown> | undefined,
  cfg: HyperspellConfig,
): ResolvedUser | undefined {
  const multiUser = cfg.multiUser
  if (!multiUser) {
    if (!cfg.userId) return undefined
    // In single-user mode memory ownership stays cfg.userId, but still capture
    // the envelope sender name so downstream context can name who spoke even
    // when all writes go to the same store. resolved: false — this is a static
    // default, not a confirmed sender match (issue #59).
    const envName =
      (ctx?.sender as string | undefined) ??
      (ctx?.username as string | undefined) ??
      undefined
    return { userId: cfg.userId, name: envName ?? cfg.userId, resolved: false }
  }

  // Try direct senderId lookup (slash command contexts)
  const senderId =
    (ctx?.senderId as string) ??
    (ctx?.requesterSenderId as string) ??
    undefined
  if (senderId && multiUser.senderMap[senderId]) {
    const profile = multiUser.senderMap[senderId]
    log.debug(`sender resolved via senderId: ${senderId} -> ${profile.userId}`)
    return { ...profile, resolved: true }
  }

  // Try sessionKey substring matching (longest-first to avoid partial matches)
  const sessionKey = ctx?.sessionKey as string | undefined
  if (sessionKey) {
    const sortedEntries = Object.entries(multiUser.senderMap).sort(
      ([a], [b]) => b.length - a.length,
    )
    for (const [handle, profile] of sortedEntries) {
      if (sessionKey.includes(handle)) {
        log.debug(
          `sender resolved via sessionKey: ${handle} -> ${profile.userId}`,
        )
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
 * Synchronous sender resolution from sessionKey + senderMap. Use this for
 * hooks and tools that don't receive audio — the voice-ID path is skipped.
 */
export function resolveUser(
  ctx: Record<string, unknown> | undefined,
  cfg: HyperspellConfig,
): ResolvedUser | undefined {
  return matchFromSenderMap(ctx, cfg)
}

/**
 * Asynchronous sender resolution. Checks voice-ID first (if enabled and
 * audio is in ctx), then falls back to the synchronous path. Callers that
 * never receive audio should use `resolveUser` to avoid unnecessary async
 * overhead.
 */
export async function resolveUserAsync(
  ctx: Record<string, unknown> | undefined,
  cfg: HyperspellConfig,
): Promise<ResolvedUser | undefined> {
  const voiceCfg = cfg.multiUser?.scoping?.voiceId
  const audio = ctx?.audio as Buffer | string | undefined
  if (voiceCfg?.enabled && audio && cfg.multiUser) {
    try {
      const identifier = getVoiceIdentifier(cfg)
      const result = await identifier.identify(audio)
      const threshold = voiceCfg.confidenceThreshold ?? 0.7
      if (result && result.confidence >= threshold) {
        // Find profile for the voice-identified userId
        for (const profile of Object.values(cfg.multiUser.senderMap)) {
          if (profile.userId === result.userId) {
            log.debug(
              `sender resolved via voice: ${result.userId} (conf=${result.confidence.toFixed(2)})`,
            )
            return { ...profile, resolved: true }
          }
        }
      }
    } catch (err) {
      log.error("voice-id identification failed", err)
    }
  }
  return matchFromSenderMap(ctx, cfg)
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

/**
 * Resolve the Role for a user. Looks first at the profile-level `role`
 * override, then at `scoping.users[userId].role`. Returns undefined if
 * scoping is disabled or the user has no role assignment.
 */
export function resolveRole(
  user: ResolvedUser | undefined,
  cfg: HyperspellConfig,
): Role | undefined {
  const scoping = cfg.multiUser?.scoping
  if (!scoping || !user) return undefined
  const roleName = user.role ?? scoping.users[user.userId]?.role
  if (!roleName) return undefined
  return scoping.roles[roleName]
}

/**
 * Readable scopes for this user. If scoping is disabled, returns ["*"] so
 * `buildScopeFilter` produces no filter and PR #6 behavior is preserved.
 */
export function getCanReadScopes(
  user: ResolvedUser | undefined,
  cfg: HyperspellConfig,
): CanReadScope[] {
  if (!cfg.multiUser?.scoping) return ["*"]
  const role = resolveRole(user, cfg)
  return role?.canRead ?? []
}

/**
 * Default write scope for this user — explicit param > role default > global default.
 */
export function getDefaultWriteScope(
  user: ResolvedUser | undefined,
  cfg: HyperspellConfig,
): ScopeName {
  const role = resolveRole(user, cfg)
  return (
    role?.defaultWriteScope ??
    cfg.multiUser?.scoping?.defaultScope ??
    "private"
  )
}

/**
 * Build a MongoDB-style metadata filter for Hyperspell's `options.filter`.
 *
 * Contract:
 * - `["*"]` (wildcard) → returns `undefined` (no filter).
 * - `[]` (empty) → returns a **match-nothing** filter, NOT `undefined`. An
 *   empty `canRead` is a deliberate "no access" signal and must not silently
 *   return all results.
 * - Otherwise: `$or` of named-scope clause and (if "self" present) an
 *   own-user clause keyed by `openclaw_user`.
 */
export function buildScopeFilter(
  canRead: CanReadScope[],
  userId: string,
): Record<string, unknown> | undefined {
  if (canRead.includes("*")) return undefined
  if (canRead.length === 0) {
    // Deliberate "no access" — match nothing.
    return { openclaw_scope: "__never__" }
  }

  const namedScopes = canRead.filter((s) => s !== "self" && s !== "*")
  const includeSelf = canRead.includes("self")

  const clauses: Array<Record<string, unknown>> = []
  if (namedScopes.length > 0) {
    clauses.push({
      openclaw_scope: { $in: namedScopes.map((s) => normalizeScope(s)) },
    })
  }
  if (includeSelf && userId) {
    clauses.push({ openclaw_user: userId })
  }

  if (clauses.length === 0) {
    return { openclaw_scope: "__never__" }
  }
  if (clauses.length === 1) {
    return clauses[0]
  }
  return { $or: clauses }
}

/**
 * Route a write: private scope stays in the user's own Hyperspell space
 * (defense-in-depth); shared scopes go to `sharedUserId` with optional
 * per-scope collection.
 */
export function routeWrite(
  user: ResolvedUser | undefined,
  scope: ScopeName,
  cfg: HyperspellConfig,
): { userId: string | undefined; collection: string | undefined } {
  const scoping = cfg.multiUser?.scoping
  if (scope === "private") {
    return { userId: user?.userId, collection: undefined }
  }
  const sharedUserId = cfg.multiUser?.sharedUserId ?? user?.userId
  const collection = scoping?.collections?.[scope]
  return { userId: sharedUserId, collection }
}
