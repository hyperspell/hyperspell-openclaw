/**
 * Shared Hyperspell `options.filter` clauses, used by every retrieval path
 * (auto-context hook + the hyperspell_search tool) so filtering stays
 * consistent across them.
 *
 * Filters match against memory METADATA keys by their bare name — the same
 * convention `buildScopeFilter` uses (`openclaw_scope`, `openclaw_user`).
 */

/**
 * Memories produced by the auto-trace session-end hook are tagged in metadata
 * as `openclaw_source: "agent_end"` (see `sendTrace` in client.ts). Exclude them
 * from generic retrieval — replaying whole sanitized transcripts back into
 * context creates a self-amplifying pollution loop.
 *
 * Applied UNCONDITIONALLY: the backend (Hyperspell #1921) now follows MongoDB
 * absent-field semantics, so `{ $ne: "agent_end" }` correctly KEEPS rows that
 * lack the key — including hot-buffer rows (now tagged
 * `openclaw_source: "hot_buffer"`) — while dropping only the agent_end traces.
 *
 * History: before #1921 the backend evaluated an absent field as SQL NULL and
 * `NULL != 'agent_end'` as not-true, so this filter silently dropped every
 * untagged hot-buffer row (issue #40). Plugin 0.15.0 worked around that by
 * gating the filter on `autoTrace.enabled`; with #1921 that gate is unnecessary
 * and has been removed, which also fixes auto-trace-ON installs.
 */
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  openclaw_source: { $ne: "agent_end" },
}

/** Combine a caller-supplied filter with the session-end exclude via `$and`. */
export function mergeWithExclude(
  base?: Record<string, unknown>,
): Record<string, unknown> {
  if (!base) return EXCLUDE_SESSION_END_FILTER
  return { $and: [base, EXCLUDE_SESSION_END_FILTER] }
}
