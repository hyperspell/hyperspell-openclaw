/**
 * Shared Hyperspell `options.filter` clauses, used by every retrieval path
 * (auto-context hook + the hyperspell_search tool) so filtering stays
 * consistent across them.
 *
 * Filters match against memory METADATA keys by their bare name — the same
 * convention `buildScopeFilter` uses (`openclaw_scope`, `openclaw_user`).
 */

/**
 * Memories produced by session-end hooks (auto-trace, emotional-state) are
 * tagged in metadata as `openclaw_source: "agent_end"` (see `sendTrace` in
 * client.ts). Those should NOT surface via generic retrieval: the
 * emotional-state hook injects them through its own dedicated path, and
 * replaying whole sanitized transcripts back into context creates a
 * self-amplifying pollution loop. Exclude them at the search filter.
 *
 * NOTE: an earlier version of this filter checked the top-level `source` field
 * for the value `"openclaw_agent_end"` — wrong on BOTH counts (the tag lives in
 * metadata under `openclaw_source`, and its value is `"agent_end"`), so it
 * silently matched nothing and excluded no traces.
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
