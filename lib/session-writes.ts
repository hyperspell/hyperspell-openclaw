/**
 * Per-session registry of vault resource ids WRITTEN during the session
 * (hyperspell_remember). The issue-#42 defense (dropCurrentSession) can only
 * hide rows keyed by the session id itself — a remember write mints a fresh
 * resource id, so the agent's just-written note comes straight back through
 * the next turn's auto-context search, curated-boosted and maximally similar
 * to the live topic (finding C3, 2026-08-24). Recording the ids at write time
 * lets retrieval exclude them for the remainder of the session; they surface
 * normally in every later session.
 */

const written = new Map<string, Set<string>>();

/** Bound total tracked sessions — session_end cleanup handles the normal
 * path; this guards hosts that never deliver session_end. */
const MAX_SESSIONS = 500;

export function recordSessionWrite(
  sessionId: string | undefined,
  resourceId: string,
): void {
  if (!sessionId) return;
  let set = written.get(sessionId);
  if (!set) {
    if (written.size >= MAX_SESSIONS) {
      const oldest = written.keys().next().value;
      if (oldest !== undefined) written.delete(oldest);
    }
    set = new Set();
    written.set(sessionId, set);
  }
  set.add(resourceId);
}

export function sessionWrittenIds(
  sessionId: string | undefined,
): ReadonlySet<string> | undefined {
  return sessionId ? written.get(sessionId) : undefined;
}

export function clearSessionWrites(sessionId: string | undefined): void {
  if (sessionId) written.delete(sessionId);
}
