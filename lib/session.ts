/**
 * Resolve the CURRENT session's id — the value the hot buffer keys its rows by
 * (`resourceId = event.sessionId`, see `hooks/hot-buffer.ts`). The auto-context
 * hook uses this to exclude the live session's own just-written turns from its
 * retrieval, so the agent isn't fed its own recent messages back as "recalled
 * memory" (issue #42).
 *
 * The wrinkle: hooks see `ctx.sessionKey`, which is a COMPOSITE — e.g.
 * `agent:main:cron:<cronId>:run:<sessionId>` — not the bare `sessionId` the hot
 * buffer writes. So we prefer an explicit `sessionId` field when present and
 * otherwise recover the bare id from the `:run:` suffix (or a trailing UUID).
 *
 * Returns `undefined` when no id can be determined — callers MUST treat that as
 * "don't exclude" so retrieval degrades to its prior behavior rather than
 * dropping anything by accident. The exclusion is purely subtractive: a wrong or
 * missing id can only fail to hide the echo, never hide real cross-session
 * memories (those live under a different resource_id).
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const RUN_SEP = ":run:"

export function resolveCurrentSessionId(
  event?: Record<string, unknown>,
  ctx?: Record<string, unknown>,
): string | undefined {
  // Prefer an explicit sessionId — this is exactly what the hot buffer uses.
  const direct =
    (typeof event?.sessionId === "string" && event.sessionId) ||
    (typeof ctx?.sessionId === "string" && ctx.sessionId)
  if (direct) return direct

  const key = ctx?.sessionKey
  if (typeof key !== "string" || key.length === 0) return undefined

  // Composite key — the bare session id is the `:run:` suffix.
  const runIdx = key.lastIndexOf(RUN_SEP)
  if (runIdx >= 0) {
    const tail = key.slice(runIdx + RUN_SEP.length)
    if (tail.length > 0) return tail
  }

  // No `:run:` segment — accept the key only if it IS (ends with) a bare UUID;
  // anything else (a phone handle, etc.) can't match a resource_id, so bail out
  // rather than return a value that would silently never match.
  const m = key.match(UUID_RE)
  if (m && key.endsWith(m[0])) return m[0]

  return undefined
}
