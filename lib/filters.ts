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
 * as `openclaw_source: "agent_end"` (see `sendTrace` in client.ts). Those should
 * NOT surface via generic retrieval — replaying whole sanitized transcripts back
 * into context creates a self-amplifying pollution loop. Exclude them here,
 * UNCONDITIONALLY.
 *
 * History (issue #40): before the backend honored MongoDB absent-field
 * semantics, `metadata->>'openclaw_source'` was SQL NULL for a missing key and
 * `NULL != 'agent_end'` evaluated to NULL (not TRUE), so this `$ne` filter also
 * silently dropped every untagged hot-buffer row. Plugin 0.15.0 worked around
 * that by gating the filter on `autoTrace.enabled` (Option 4) — which left a
 * known hole: auto-trace-ON installs still dropped untagged hot rows.
 *
 * Backend Hyperspell #1921 fixed this: `$ne` now follows MongoDB semantics and
 * KEEPS rows whose `openclaw_source` is absent (verified live — untagged hot
 * rows survive `{$ne:"agent_end"}` while `agent_end` rows are dropped). So the
 * gate is unnecessary and removed: the filter applies unconditionally again,
 * which also fixes the auto-trace-ON case. Hot-buffer rows are additionally
 * tagged `openclaw_source: "hot_buffer"` (≠ `"agent_end"`), so they survive on
 * either path.
 */
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  openclaw_source: { $ne: "agent_end" },
}

/**
 * Combine a caller-supplied filter with the session-end exclude via `$and`.
 * The exclude is applied unconditionally (see above); pass a base filter to
 * intersect it (e.g. a scope clause), or omit it for the exclude alone.
 */
export function mergeWithExclude(
  base?: Record<string, unknown>,
): Record<string, unknown> {
  if (!base) return EXCLUDE_SESSION_END_FILTER
  return { $and: [base, EXCLUDE_SESSION_END_FILTER] }
}
