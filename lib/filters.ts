/**
 * Shared Hyperspell `options.filter` clauses, used by every retrieval path
 * (auto-context hook + the hyperspell_search tool) so filtering stays
 * consistent across them.
 *
 * Filters match against memory METADATA keys by their bare name — the same
 * convention `buildScopeFilter` uses (`openclaw_scope`, `openclaw_user`).
 */

/** Minimal slice of config the exclude logic needs (avoids a config-module cycle). */
type ExcludeCfg = {
  autoTrace: { enabled: boolean }
  emotionalContext: boolean
  moodWeatherChance: number
}

/** Metadata tag on auto-trace session-end rows (see `sendTrace` in client.ts). */
export const AGENT_END_SOURCE = "agent_end"
/** Metadata tag on mood-weather roll records (see `recordMoodRoll` in hooks/mood-weather.ts). */
export const MOOD_WEATHER_SOURCE = "mood_weather"
/**
 * Metadata tag on hot-buffer conversation rows (written by hooks/hot-buffer.ts).
 * Readers must select ON this value, never "any tag means not mine" — hot rows
 * were untagged before backend #1921 (2026-07-02) and consumers written against
 * that shape silently match nothing now.
 */
export const HOT_BUFFER_SOURCE = "hot_buffer"

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

/**
 * The exclude clause to apply for a given config — or `undefined` to skip the
 * filter. Each excluded tag is gated on the feature that writes it, for
 * PERFORMANCE, not correctness (see the header comment): with the feature off
 * there are no tagged rows to hide, so the ~1s predicate would be pure latency.
 *
 *  - `agent_end` rows are written ONLY by the auto-trace hook → gate on
 *    `autoTrace.enabled` (verified live against an auto-trace-off agent with
 *    zero `agent_end` rows).
 *  - `mood_weather` rolls are recorded ONLY when the emotional-context handler
 *    is registered AND the dice are live → gate on both flags.
 *
 * Shape: a single excluded value keeps the proven plain-`$ne` form (byte-
 * identical to the shipped filter, and post-#1921 it drops the tag while
 * KEEPING untagged hot-buffer rows). Two values use `$nin`.
 *
 * ⚠️ The `$nin` two-value shape has NOT been re-verified live post-#1921 (the
 * pre-#1921 truth table showed `$nin` diverging from `$ne`). Owner's post-merge
 * step: run `node docs/filter-dialect-test.mjs` — the `$nin[agent_end,mood_weather]`
 * row must show U=Y, A=N, M=N. Fallback plan if it fails: try the
 * `$and[$ne,$ne]` probe row; if that also fails, gate back to single-value
 * `$ne` for the two common one-feature-on configs, log a warning when both
 * features are enabled, and file a backend dialect follow-up
 * (docs/hyperspell-backend-followups.md style) for the both-on combo.
 */
export function excludeFilterFor(
  cfg: ExcludeCfg,
): Record<string, unknown> | undefined {
  const excluded: string[] = []
  if (cfg.autoTrace.enabled) excluded.push(AGENT_END_SOURCE)
  // Mood rolls are recorded only when the emotional-context handler is
  // registered AND the dice are live — same "no rows to hide → skip the
  // ~1s predicate" gate as auto-trace.
  if (cfg.emotionalContext && cfg.moodWeatherChance > 0) {
    excluded.push(MOOD_WEATHER_SOURCE)
  }
  if (excluded.length === 0) return undefined
  if (excluded.length === 1) return { openclaw_source: { $ne: excluded[0] } }
  return { openclaw_source: { $nin: excluded } }
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
