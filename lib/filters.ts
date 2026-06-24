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
 * THE #40 TENSION: hot-buffer rows written via `POST /messages` carry NO
 * `openclaw_source`, and the backend evaluates absent-field metadata predicates
 * in SQL three-valued logic — `metadata->>'openclaw_source'` is NULL for a
 * missing key, and `NULL != 'agent_end'` is NULL (not TRUE) — so this filter
 * also drops every untagged hot-buffer row. We could not work around that at the
 * filter layer: `docs/filter-dialect-test.mjs` against the live backend showed
 * that NO `openclaw_source` predicate returns untagged rows ($exists/$or/$nin/
 * $not all fail), AND that `POST /messages` silently ignores a `metadata` field,
 * so the rows can't be positively tagged either. See `excludeFilterFor` for the
 * fix we ship (gate on auto-trace), and issue #40 for the backend follow-up
 * (make `/messages` accept metadata, or make the filter NULL-tolerant).
 *
 * NOTE: an earlier version checked the top-level `source` field for
 * "openclaw_agent_end" — wrong on BOTH counts (the tag lives in metadata under
 * `openclaw_source`, value `"agent_end"`), so it silently matched nothing.
 */
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  openclaw_source: { $ne: "agent_end" },
}

/**
 * The exclude clause to apply for a given config — or `undefined` to skip
 * filtering entirely (issue #40, Option 4 — the only viable plugin-side fix).
 * `openclaw_source: "agent_end"` rows are written ONLY by the auto-trace hook;
 * when auto-trace is disabled there are none to hide, so we skip the filter
 * entirely — which is also the ONLY way to keep untagged hot-buffer rows
 * visible, since (per the dialect test) no filter and no write-tag can do it.
 *
 * LIMITATION: when auto-trace IS enabled, this still applies `$ne agent_end`,
 * which drops untagged hot-buffer rows along with the traces. There is no
 * plugin-side fix for that combination today; it needs the backend change
 * tracked in #40. (The common single-feature install has auto-trace off.)
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
