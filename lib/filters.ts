/**
 * Shared Hyperspell `options.filter` clauses, used by every retrieval path
 * (auto-context hook + the hyperspell_search tool) so filtering stays
 * consistent across them.
 *
 * Filters match against memory METADATA keys by their bare name — the same
 * convention `buildScopeFilter` uses (`openclaw_scope`, `openclaw_user`).
 */

/** Minimal slice of config the exclude logic needs (avoids a config-module cycle). */
type ExcludeCfg = { autoTrace: { enabled: boolean } }

/**
 * Memories produced by the auto-trace session-end hook are tagged in metadata
 * as `openclaw_source: "agent_end"` (see `sendTrace` in client.ts). Those should
 * NOT surface via generic retrieval — replaying whole sanitized transcripts back
 * into context creates a self-amplifying pollution loop. Exclude them here.
 *
 * TOLERANT FORM (issue #40): hot-buffer rows written via `POST /messages` carry
 * NO `openclaw_source`. A bare `{ openclaw_source: { $ne: "agent_end" } }`
 * silently drops them: the backend evaluates the JSONB predicate in SQL
 * three-valued logic — `metadata->>'openclaw_source'` is NULL for an absent key,
 * and `NULL != 'agent_end'` is NULL (not TRUE), so the row fails to match and is
 * excluded. This is the OPPOSITE of MongoDB `$ne` (which matches missing fields)
 * — do not "correct" it back. `$or`-ing an explicit `$exists: false` branch
 * re-admits untagged rows while still hiding the real `agent_end` traces.
 *
 * NOTE: an earlier version checked the top-level `source` field for
 * "openclaw_agent_end" — wrong on BOTH counts (the tag lives in metadata under
 * `openclaw_source`, value `"agent_end"`), so it silently matched nothing.
 */
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  $or: [
    { openclaw_source: { $exists: false } },
    { openclaw_source: { $ne: "agent_end" } },
  ],
}

/**
 * The exclude clause to apply for a given config — or `undefined` to skip
 * filtering entirely (issue #40, Option 4). `openclaw_source: "agent_end"` rows
 * are written ONLY by the auto-trace hook; when auto-trace is disabled no such
 * rows exist, so the exclude is pure cost — and skipping it keeps untagged
 * hot-buffer rows visible without depending on the backend's `$exists`/null
 * handling at all. Auto-trace-on installs still get the tolerant clause above
 * (validate `$exists` support via `hotbuffer-verify.mjs --filter-probe`).
 */
export function excludeFilterFor(
  cfg: ExcludeCfg,
): Record<string, unknown> | undefined {
  return cfg.autoTrace.enabled ? EXCLUDE_SESSION_END_FILTER : undefined
}

/**
 * Combine a caller-supplied filter with the session-end exclude via `$and`.
 * Returns `undefined` when neither a base filter nor an exclude applies.
 */
export function mergeWithExclude(
  base: Record<string, unknown> | undefined,
  cfg: ExcludeCfg,
): Record<string, unknown> | undefined {
  const exclude = excludeFilterFor(cfg)
  if (!exclude) return base
  if (!base) return exclude
  return { $and: [base, exclude] }
}
