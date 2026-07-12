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
 * Since backend Hyperspell #1921, `$ne` follows MongoDB absent-field semantics:
 * it KEEPS rows whose `openclaw_source` is absent (untagged hot-buffer rows) and
 * drops only `agent_end`. So applying this filter is now SAFE for hot rows — the
 * old #40 tension (where `NULL != 'agent_end'` dropped untagged rows) is resolved
 * at the backend.
 *
 * We nonetheless GATE the filter on auto-trace (see `excludeFilterFor`) for
 * PERFORMANCE, not correctness: a `{$ne}` predicate measurably slows the vector
 * search (~1s observed live), and when auto-trace is off there are no `agent_end`
 * rows to hide, so the filter would cost latency on every turn for zero benefit.
 *
 * Hot rows ARE positively tagged (`openclaw_source: "hot_buffer"` plus
 * session/channel ids — see the hot-buffer hook): metadata-carrying
 * `/messages` rows were verified retrievable AND filterable live 2026-07-02
 * (docs/filter-dialect-test.mjs). The `$ne` exclude keeps them because
 * "hot_buffer" != "agent_end". (An earlier note here claimed metadata made
 * hot rows non-retrievable — that predated the backend fix.)
 *
 * NOTE: an earlier version checked the top-level `source` field for
 * "openclaw_agent_end" — wrong on BOTH counts (the tag lives in metadata under
 * `openclaw_source`, value `"agent_end"`), so it silently matched nothing.
 */
export const EXCLUDE_SESSION_END_FILTER: Record<string, unknown> = {
  openclaw_source: { $ne: "agent_end" },
}

/**
 * The exclude clause to apply for a given config — or `undefined` to skip the
 * filter. `agent_end` rows are written ONLY by the auto-trace hook, so when
 * auto-trace is OFF there are none to hide and we skip the filter to avoid its
 * ~1s/search latency cost (pure overhead otherwise — verified live against an
 * auto-trace-off agent with zero `agent_end` rows).
 *
 * When auto-trace is ON we apply `{$ne:"agent_end"}`, which post-#1921 drops the
 * traces while KEEPING untagged hot-buffer rows — so that path is correct now
 * (the old #40 hot-row-drop is fixed by the backend, not by gating).
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
