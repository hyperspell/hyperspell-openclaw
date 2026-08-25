import { appendFileSync } from "node:fs"
import type { HyperspellClient, SearchResult } from "../client.ts"
import type { CanReadScope, HyperspellConfig } from "../config.ts"
import {
  buildScopeFilter,
  getCanReadScopes,
  resolveUser,
  type ResolvedUser,
} from "../lib/sender.ts"
import { excludeFilterFor, mergeWithExclude } from "../lib/filters.ts"
import {
  explainSelection,
  kindTally,
  type RankedResult,
  rerank,
  type SelectionExplained,
} from "../lib/ranking.ts"
import {
  type CoverageLane,
  recordCoverageEvent,
} from "../lib/coverage-log.ts"
import { classifySearchError, logSearchError } from "../lib/search-error.ts"
import { resolveCurrentSessionId } from "../lib/session.ts"
import { clearSessionWrites, sessionWrittenIds } from "../lib/session-writes.ts"
import { recordSender, senderIdFromCtx } from "../lib/speaker-tracker.ts"
import { log } from "../logger.ts"

function formatRelativeTime(isoTimestamp: string): string {
  try {
    const dt = new Date(isoTimestamp)
    const now = new Date()
    const seconds = (now.getTime() - dt.getTime()) / 1000
    const minutes = seconds / 60
    const hours = seconds / 3600
    const days = seconds / 86400

    if (minutes < 30) return "just now"
    if (minutes < 60) return `${Math.floor(minutes)}mins ago`
    if (hours < 24) return `${Math.floor(hours)} hrs ago`
    if (days < 7) return `${Math.floor(days)}d ago`

    const month = dt.toLocaleString("en", { month: "short" })
    if (dt.getFullYear() === now.getFullYear()) {
      return `${dt.getDate()} ${month}`
    }
    return `${dt.getDate()} ${month}, ${dt.getFullYear()}`
  } catch {
    return ""
  }
}

/**
 * Format a list of search results as per-highlight bullets, filtered by relevance threshold.
 * Returns null if nothing passes the threshold.
 */
function formatHighlightBullets(
  results: SearchResult[],
  maxResults: number,
  threshold: number,
): string | null {
  const sections: string[] = []

  for (const r of results.slice(0, maxResults)) {
    if ((r.score ?? 0) < threshold) continue

    const aboveThreshold = r.highlights.filter((h) => h.score >= threshold)
    if (aboveThreshold.length === 0) continue

    const title = r.title ?? `[${r.source}]`
    const bullets = aboveThreshold
      .map((h) => `- ${h.text.replace(/\n/g, " ")} [${Math.round(h.score * 100)}%]`)
      .join("\n")

    sections.push(`### ${title} (resource_id: ${r.resourceId}, source: ${r.source})\n\n${bullets}`)
  }

  if (sections.length === 0) return null
  return sections.join("\n\n")
}

// A second highlight rides along only when it is within this much of the top
// one's score — a distant second is dilution inside a correct pick (proposal
// 12). Absolute difference (not a ratio) to match every other score rule in
// this pipeline; 0.15 is "one storyBoost's worth" on the composite scale.
// Deliberately a constant, not config: a formatting heuristic two levels
// below anything a user reasons about — promote to ranking.highlightGap only
// if live tuning proves deployments actually differ.
const HIGHLIGHT_GAP = 0.15

/**
 * Format already-SELECTED composite-ranked results (threshold + chatter quota
 * applied upstream by selectRanked). Highlights are floored at the lower of
 * (threshold, the result's own base relevance), so we don't hide the very lines
 * that define a boosted-but-quiet memory. Exported for direct testing.
 */
export function formatSelected(selected: RankedResult[], threshold: number): string | null {
  const sections: string[] = []

  for (const r of selected) {
    const hiFloor = Math.min(threshold, r._base)
    const passing = [...r.highlights]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter((h) => (h.score ?? 0) >= hiFloor)
    if (passing.length === 0) continue

    // Floor first (is this highlight relevant at all?), gap second (is the
    // runner-up close enough to the winner to be worth its tokens?). The TOP
    // highlight is always kept — the lowered hiFloor exists to protect
    // boosted-but-quiet memories, and the gap rule must never re-hide them; a
    // selected result can never format to fewer sections than today.
    const [top, second] = passing
    const chosen =
      second && (top.score ?? 0) - (second.score ?? 0) <= HIGHLIGHT_GAP
        ? [top, second]
        : [top]

    const title = r.title ?? `[${r.source}]`
    const bullets = chosen
      .map((h) => `- ${h.text.replace(/\n/g, " ")} [${Math.round((h.score ?? 0) * 100)}%]`)
      .join("\n")

    sections.push(`### ${title} (resource_id: ${r.resourceId}, source: ${r.source})\n\n${bullets}`)
  }

  if (sections.length === 0) return null
  return sections.join("\n\n")
}

/**
 * Opt-in score sampling for relevanceThreshold tuning (proposal 02 §3b).
 * Writes one JSONL line per candidate when HYPERSPELL_SCORE_LOG names a file;
 * review/analyze with docs/score-review.mjs and docs/score-analyze.mjs.
 *
 * The lines carry an 80-char prompt prefix and memory snippets — sensitive
 * plaintext on disk — so this is OFF by default and never config-driven:
 * it writes nothing unless the operator explicitly sets the env var (setting
 * it IS the opt-in), and the log should be deleted after the tuning window.
 * The env var is read at call time (not module load) so tests can set it.
 * Must never throw into the retrieval path.
 */
function logScoreSamples(
  prompt: string,
  sessionId: string | undefined,
  scope: "single" | "personal" | "shared",
  explained: SelectionExplained[],
  threshold: number,
): void {
  const path = process.env.HYPERSPELL_SCORE_LOG
  if (!path || explained.length === 0) return
  const ts = new Date().toISOString()
  const lines = explained.map((e) => {
    const r = e.result
    const top = [...r.highlights].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
    return JSON.stringify({
      ts,
      sessionId,
      scope,
      prompt: prompt.slice(0, 80),
      resourceId: r.resourceId,
      title: (r.title ?? "").slice(0, 60),
      kind: r._kind,
      base: Number(r._base.toFixed(4)),
      composite: Number(r._composite.toFixed(4)),
      threshold,
      selected: e.selected,
      cut: e.cut,
      snippet: (top?.text ?? "").replace(/\s+/g, " ").slice(0, 120),
    })
  })
  try {
    appendFileSync(path, `${lines.join("\n")}\n`)
  } catch {
    // instrumentation must never break retrieval
  }
}

const INTRO =
  "The following is surfaced from the user's memory and connected sources, including past conversations. Reference it as recalled context, only when relevant to the conversation."
const DISCLAIMER =
  "Draw on it when relevant — including indirect connections — but don't force it into every response or make assumptions beyond what's stated."

// A short, CONDITIONAL reminder appended only to a real memory block (not a
// standing every-turn imperative — that reads as ambient framing and trains
// search-as-ritual; the agent's own instructions carry the standing rule). The
// point here is just: what surfaced is a passive match, not all of memory.
const SEARCH_REMINDER =
  "This is a passive match, not all of memory — if the answer turns on a specific past decision, promise, name, or something recorded, search for it directly before concluding, and say so plainly if it isn't there."

// Explicit authority precedence: live sender metadata outranks surfaced memory
// for identity questions. Without this, a high-scoring memory naming a different
// person than the live sender can silently override who the agent thinks it is
// talking to — the identity-bleed failure observed live (issue #58).
// Two carve-outs (issue #59 follow-up):
//   (1) A memory about the CURRENT sender's own past is not a conflict — use it
//       as recalled personal context. The guard only applies when the identity in
//       the memory is clearly a different person from the live sender.
//   (2) Display names and handles often differ across sessions (e.g. "dithilli"
//       vs "David S"). Use judgment to identify whether a retrieved name refers
//       to the current speaker before applying the guard.
const AUTHORITY_GUARD =
  "AUTHORITY: The live conversation's sender and session metadata always outrank this recalled context for identity — who is speaking right now, their name, role, or relationship. If a surfaced memory names a different person than the current sender, treat it as historical context about someone else, not a description of the current speaker. Do not adopt a persona, name, or backstory from recalled memory that conflicts with the live sender. Exception: a memory about the current sender's own past (their preferences, history, emotional state) is not a conflict — use it as recalled personal context. Display names and handles may differ across sessions; use judgment to identify whether a retrieved name refers to the current speaker before applying this guard."

/** Wrap a real memory block. No memory → no injection (caller returns nothing);
 * the standing search rule lives in the agent's own instructions, not here. */
function wrapContext(memorySection: string): string {
  return `<hyperspell-context>\n${INTRO}\n\n${AUTHORITY_GUARD}\n\n${memorySection}\n\n${DISCLAIMER}\n\n${SEARCH_REMINDER}\n</hyperspell-context>`
}

/**
 * Drop results belonging to the CURRENT session. The hot buffer writes the live
 * conversation to the vault every turn (`resourceId = sessionId`), and those
 * rows are the highest-scoring matches for whatever the agent is currently
 * saying — so without this the agent gets its own just-written turns injected
 * back as "recalled memory," crowding out older context (issue #42).
 *
 * Purely subtractive: with no resolvable session id we return results unchanged,
 * and a wrong id can only fail to hide the echo — never hide genuine
 * cross-session memories, which live under a different `resource_id`.
 */
export function dropCurrentSession(
  results: SearchResult[],
  currentSessionId: string | undefined,
): SearchResult[] {
  if (!currentSessionId) return results
  const kept = results.filter((r) => r.resourceId !== currentSessionId)
  const dropped = results.length - kept.length
  if (dropped > 0) {
    log.debug(
      `auto-context: excluded ${dropped} result(s) from current session ${currentSessionId}`,
    )
  }
  return kept
}

/** Highest raw relevance among candidates — `topScore 0.54` vs `threshold 0.6`
 * is a ranking near-miss; `0.12` means the vault has nothing close (capture). */
function topScoreOf(results: SearchResult[]): number | null {
  return results.length ? Math.max(...results.map((r) => r.score ?? 0)) : null
}

/**
 * Per-session memory of resource ids ALREADY INJECTED by auto-context.
 * Auto-context runs every turn with no repeat suppression, so the same
 * top-ranked memories recurred turn after turn by construction — the "same
 * irrelevant items, four consecutive turns" complaint from the 2026-08-24
 * audit. Once injected, a memory is in the conversation context; injecting
 * it again spends tokens on what the model can already see.
 *
 * Lifecycle mirrors emotional-state's inject-once cache:
 *  - injection records the selected ids under the session id;
 *  - after_compaction CLEARS the session (the earlier injection may have
 *    been compacted out of history — suppressing then would hide memory
 *    exactly when it was lost);
 *  - session_end cleans up; a size cap guards hosts that never send it.
 */
const injectedResources = new Map<string, Set<string>>();
const MAX_TRACKED_SESSIONS = 500;

function recordInjected(sessionId: string | undefined, ids: string[]): void {
  if (!sessionId || ids.length === 0) return;
  let set = injectedResources.get(sessionId);
  if (!set) {
    if (injectedResources.size >= MAX_TRACKED_SESSIONS) {
      const oldest = injectedResources.keys().next().value;
      if (oldest !== undefined) injectedResources.delete(oldest);
    }
    set = new Set();
    injectedResources.set(sessionId, set);
  }
  for (const id of ids) set.add(id);
}

/**
 * Drop results already injected this session, and results WRITTEN this
 * session via the remember tool (finding C3: a fresh remember id is invisible
 * to dropCurrentSession and comes straight back, curated-boosted, on the next
 * turn). Purely subtractive, same contract as dropCurrentSession.
 */
export function dropAlreadySurfaced(
  results: SearchResult[],
  currentSessionId: string | undefined,
): SearchResult[] {
  if (!currentSessionId) return results;
  const injected = injectedResources.get(currentSessionId);
  const writtenIds = sessionWrittenIds(currentSessionId);
  if (!injected?.size && !writtenIds?.size) return results;
  const kept = results.filter(
    (r) => !injected?.has(r.resourceId) && !writtenIds?.has(r.resourceId),
  );
  const dropped = results.length - kept.length;
  if (dropped > 0) {
    log.debug(
      `auto-context: suppressed ${dropped} result(s) already injected or written this session`,
    );
  }
  return kept;
}

/** after_compaction: forget what was injected — it may have been compacted
 * out of history, and suppression must never outlive the context it saved. */
export function buildAutoContextCompactionHandler() {
  return (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    const sessionId = resolveCurrentSessionId(event, ctx);
    if (sessionId && injectedResources.delete(sessionId)) {
      log.debug("auto-context: compaction — cleared injected-resource memory for session");
    }
  };
}

/** session_end: bound memory. Session-write records go with it. */
export function buildAutoContextSessionCleanupHandler() {
  return (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    const sessionId = resolveCurrentSessionId(event, ctx);
    if (sessionId) {
      injectedResources.delete(sessionId);
      clearSessionWrites(sessionId);
    }
  };
}

export function buildAutoContextHandler(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  opts?: { stateRoot?: string },
) {
  return async (
    event: Record<string, unknown>,
    ctx?: Record<string, unknown>,
  ) => {
    const prompt = event.prompt as string | undefined
    if (!prompt || prompt.length < 5) return

    // The live session's own just-written turns must not be surfaced back as
    // "recalled memory" (issue #42) — resolve its id once and exclude it below.
    const currentSessionId = resolveCurrentSessionId(event, ctx)

    // Record the current sender so the speaker-tracker can detect multi-speaker
    // sessions before any tool calls fire this turn (hot-buffer records on
    // agent_end, which is too late for tools executed mid-turn).
    if (currentSessionId) recordSender(currentSessionId, senderIdFromCtx(ctx))

    // Multi-user path
    if (cfg.multiUser) {
      const resolved = resolveUser(ctx, cfg)
      return multiUserSearch(client, cfg, prompt, resolved, currentSessionId, opts?.stateRoot)
    }

    // Single-user path — preserves main's highlights + threshold behavior
    log.debug(`auto-context: searching for "${prompt.slice(0, 50)}..."`)

    try {
      const ranking = cfg.ranking
      // When composite ranking is on, fetch a WIDER candidate pool so quiet-but-
      // true memory is present to be re-ranked, not cut off below the fetch limit.
      const limit = ranking.enabled
        ? cfg.maxResults * ranking.candidateMultiplier
        : cfg.maxResults
      // Kept as two steps so the coverage event below can report the pre-drop
      // fetch count (a session-echo-dominated pool must be visible as such).
      const rawResults = await client.search(prompt, {
        limit,
        filter: excludeFilterFor(cfg),
      })
      const results = dropAlreadySurfaced(
        dropCurrentSession(rawResults, currentSessionId),
        currentSessionId,
      )

      let formatted: string | null
      let injectedIds: string[] | undefined
      if (ranking.enabled) {
        const ranked = rerank(results, ranking)
        // Threshold + chatter quota applied here, so a high-similarity echo can
        // inform but never flood (the quota bounds count; the penalty bounds rank).
        const explained = explainSelection(
          ranked,
          cfg.maxResults,
          cfg.relevanceThreshold,
          ranking.chatterQuota,
          ranking.dedupThreshold,
          ranking.elbow,
          ranking.perFileCap,
        )
        logScoreSamples(prompt, currentSessionId, "single", explained, cfg.relevanceThreshold)
        const selected = explained.filter((e) => e.selected).map((e) => e.result)

        // Candidates → selected kind tally, logged UNCONDITIONALLY (unlike the
        // "injecting" line below): a story/curated match that loses to the
        // threshold is exactly the case an operator tuning storyTerms needs to
        // see, and it never reaches the formatted branch (proposal 01 §3.4).
        log.diag(
          `auto-context: ranked ${JSON.stringify(kindTally(ranked))} candidates → selected ${JSON.stringify(kindTally(selected))} (chatter cap ${ranking.chatterQuota})`,
        )
        for (const r of ranked.slice(0, 10)) {
          log.debug(
            `  [${r._kind}] ${r._base.toFixed(2)}→${r._composite.toFixed(2)} ${(r.title ?? r.resourceId).slice(0, 60)}`,
          )
        }

        // Cut-reason visibility (proposal 02, absorbs proposal 03): logged
        // BEFORE the `formatted` check so quota drops stay visible even when
        // nothing is injected (e.g. chatterQuota 0 with only chatter clearing
        // the threshold). Stable "auto-context: cut" prefix for log greps.
        // flatMap (not filter) so TS narrows to the cut member of the union.
        // Elbow verdict — the live-validation instrument for proposal 13's
        // rollout: firing rate + cut depth come straight from this line.
        if (ranking.elbow.enabled && explained.some((e) => e.cut === "elbow")) {
          log.diag(
            `auto-context: elbow stopped at ${selected.length} (ceiling ${cfg.maxResults})`,
          )
        }

        const cuts = explained.flatMap((e) => (e.selected ? [] : [e]))
        if (cuts.length > 0) {
          const cutTally = cuts.reduce(
            (acc, e) => ((acc[e.cut] = (acc[e.cut] ?? 0) + 1), acc),
            {} as Record<string, number>,
          )
          const topQuotaDrop = cuts.find((e) => e.cut === "chatter-quota")
          const quotaNote = topQuotaDrop
            ? `, top quota-dropped composite ${topQuotaDrop.result._composite.toFixed(2)}`
            : ""
          log.diag(
            `auto-context: cut ${cuts.length} of ${ranked.length} candidates ${JSON.stringify(cutTally)}${quotaNote}`,
          )
        }

        injectedIds = selected.map((r) => r.resourceId)
        formatted = formatSelected(selected, cfg.relevanceThreshold)
        if (formatted) {
          log.diag(
            `auto-context: injecting (ranked) ${JSON.stringify(kindTally(selected))} from ${results.length} candidates (chatter cap ${ranking.chatterQuota}, composite ${selected.at(-1)?._composite.toFixed(2)}–${selected[0]?._composite.toFixed(2)})`,
          )
        }
      } else {
        formatted = formatHighlightBullets(results, cfg.maxResults, cfg.relevanceThreshold)
        if (formatted) log.debug(`auto-context: injecting ${results.length} memories`)
      }

      // No memory cleared the bar → no injection. The standing "search before you
      // conclude" rule lives in the agent's own instructions, not an ambient
      // every-turn banner (which reads as framing and trains search-as-ritual).
      if (!formatted) {
        log.debug("auto-context: no relevant memories found")
        // Coverage signal (proposal 15): search SUCCEEDED but injected nothing —
        // durably distinguish "never captured" (empty) from "captured but ranked
        // out" (below_threshold). Thrown searches never reach here (the catch
        // below owns them), so availability blips can't pollute the log.
        if (cfg.coverageLog) {
          recordCoverageEvent(
            {
              outcome: results.length > 0 ? "below_threshold" : "empty",
              prompt,
              fetched: rawResults.length,
              candidates: results.length,
              droppedCurrentSession: rawResults.length - results.length,
              topScore: topScoreOf(results),
              threshold: cfg.relevanceThreshold,
              ranking: ranking.enabled,
              sessionId: currentSessionId,
            },
            opts?.stateRoot,
          )
        }
        return
      }
      // Remember what landed so later turns spend their budget on NEW memory.
      // Ranked path records the exact selected ids; the legacy unranked path
      // approximates with the formatted window (first maxResults above bar).
      recordInjected(
        currentSessionId,
        (injectedIds ?? []).length > 0
          ? (injectedIds as string[])
          : results
              .slice(0, cfg.maxResults)
              .filter((r) => (r.score ?? 0) >= cfg.relevanceThreshold)
              .map((r) => r.resourceId),
      )
      return { prependContext: wrapContext(formatted) }
    } catch (err) {
      // A transient backend throttle (429 / Retry-After) must not be swallowed
      // as a generic failure — log it at warn, distinguished from real errors,
      // so the degraded auto-context is observable (issue #39). The hook stays
      // silent (no injection) either way; the agent didn't explicitly ask.
      logSearchError(log, "auto-context", classifySearchError(err), err)
      return
    }
  }
}

// Ranking landed here 2026-08-24 (the parity gap flagged by every review
// that day): each lane runs the same rerank/explainSelection machinery as
// the single-user path, with per-lane budgets and score-log scopes
// ("personal"/"shared"). The chatter quota applies PER LANE — a deliberate
// simplification (worst case 2× quota across both lanes), documented rather
// than silently split.
async function multiUserSearch(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  prompt: string,
  resolved: ResolvedUser | undefined,
  currentSessionId: string | undefined,
  stateRoot?: string,
) {
  const multiUser = cfg.multiUser!
  const isKnownSender = !!resolved?.resolved
  const includeShared = multiUser.includeSharedInSearch

  // Determine scope filter for the shared-space search based on caller's role.
  // Unknown senders fall back to least-sensitive scopes; absent scoping config →
  // filter is undefined → PR #6 behavior preserved.
  const canRead: CanReadScope[] = multiUser.scoping
    ? isKnownSender
      ? getCanReadScopes(resolved, cfg)
      : ["family", "kid_shared"]
    : ["*"]
  const scopeFilter = buildScopeFilter(canRead, resolved?.userId ?? "")

  log.debug(
    `auto-context: searching for "${prompt.slice(0, 50)}..." user=${resolved?.userId ?? "unknown"} canRead=${JSON.stringify(canRead)}`,
  )

  // Composite ranking parity with the single-user path (the gap flagged in
  // every 2026-08-24 review: this path never ranked, so multi-user installs
  // got no chatter quota, no dedup, no authorship routing — and a stricter
  // admission rule via formatHighlightBullets' doc-score gate). When ranking
  // is on, fetch a WIDER candidate pool per lane, same rationale as
  // single-user: quiet-but-true memory must be present to be re-ranked.
  const ranking = cfg.ranking
  const pool = (base: number) =>
    ranking.enabled ? base * ranking.candidateMultiplier : base

  // Build parallel searches — personal (known senders only) + shared
  const personalSearch = isKnownSender
    ? client.search(prompt, {
        limit: pool(cfg.maxResults),
        userId: resolved!.userId,
        filter: excludeFilterFor(cfg),
      })
    : null

  // Always search shared for unknown senders, even if includeSharedInSearch is false
  const sharedLimit = isKnownSender
    ? Math.ceil(cfg.maxResults / 2)
    : cfg.maxResults
  const sharedSearch =
    includeShared || !isKnownSender
      ? client.search(prompt, {
          limit: pool(sharedLimit),
          userId: multiUser.sharedUserId,
          filter: mergeWithExclude(scopeFilter, cfg),
        })
      : null

  const searches = [personalSearch, sharedSearch].filter(Boolean) as Promise<
    SearchResult[]
  >[]
  const settled = await Promise.allSettled(searches)

  let idx = 0
  let personalResults: SearchResult[] = []
  let sharedResults: SearchResult[] = []
  // Per-lane fulfillment + pre-drop counts feed the coverage event below: a
  // lane that REJECTED must never be recorded as "zero candidates" (#39's
  // unavailable-is-not-empty distinction, kept intact in the log schema).
  let personalOk = false
  let sharedOk = false
  let rawPersonalCount = 0
  let rawSharedCount = 0

  if (personalSearch) {
    const r = settled[idx++]
    if (r.status === "fulfilled") {
      personalOk = true
      rawPersonalCount = r.value.length
      personalResults = dropAlreadySurfaced(
        dropCurrentSession(r.value, currentSessionId),
        currentSessionId,
      )
    } else {
      logSearchError(
        log,
        "auto-context: personal search",
        classifySearchError(r.reason),
        r.reason,
      )
    }
  }
  if (sharedSearch) {
    const r = settled[idx++]
    if (r.status === "fulfilled") {
      sharedOk = true
      rawSharedCount = r.value.length
      sharedResults = dropAlreadySurfaced(
        dropCurrentSession(r.value, currentSessionId),
        currentSessionId,
      )
    } else {
      logSearchError(
        log,
        "auto-context: shared search",
        classifySearchError(r.reason),
        r.reason,
      )
    }
  }

  const sections: string[] = []
  const laneInjectedIds: string[] = []

  // One selection policy per lane, sharing the single-user machinery. Lanes
  // keep their own budgets and their own wrappers (scoping semantics), but a
  // multi-user install now gets the same composite ranking, chatter quota
  // (per lane), near-duplicate dedup, per-file cap, elbow, and score logging
  // as single-user. formatSelected also closes C6: a null-doc-score row whose
  // relevance arrives via highlights ranks on _base instead of being silently
  // skipped by formatHighlightBullets' doc-score gate.
  const rankLane = (
    laneResults: SearchResult[],
    laneLimit: number,
    scope: "personal" | "shared",
  ): string | null => {
    if (!ranking.enabled) {
      const formatted = formatHighlightBullets(
        laneResults,
        laneLimit,
        cfg.relevanceThreshold,
      )
      if (formatted) {
        laneInjectedIds.push(
          ...laneResults
            .slice(0, laneLimit)
            .filter((r) => (r.score ?? 0) >= cfg.relevanceThreshold)
            .map((r) => r.resourceId),
        )
      }
      return formatted
    }
    const ranked = rerank(laneResults, ranking)
    const explained = explainSelection(
      ranked,
      laneLimit,
      cfg.relevanceThreshold,
      ranking.chatterQuota,
      ranking.dedupThreshold,
      ranking.elbow,
      ranking.perFileCap,
    )
    logScoreSamples(prompt, currentSessionId, scope, explained, cfg.relevanceThreshold)
    const selected = explained.filter((e) => e.selected).map((e) => e.result)
    log.diag(
      `auto-context[${scope}]: ranked ${JSON.stringify(kindTally(ranked))} → selected ${JSON.stringify(kindTally(selected))} (chatter cap ${ranking.chatterQuota})`,
    )
    const formatted = formatSelected(selected, cfg.relevanceThreshold)
    if (formatted) laneInjectedIds.push(...selected.map((r) => r.resourceId))
    return formatted
  }

  // User identity preamble
  if (isKnownSender && resolved) {
    const contextLine = resolved.context ? ` ${resolved.context}` : ""
    sections.push(`You are speaking with ${resolved.name}.${contextLine}`)
  }

  // Personal section (threshold-filtered per PR #11/#12 format)
  if (isKnownSender && personalResults.length > 0 && resolved) {
    const formatted = rankLane(personalResults, cfg.maxResults, "personal")
    if (formatted) {
      sections.push(
        `<personal-context>\nMemories from ${resolved.name}'s personal sources and history.\n\n${formatted}\n</personal-context>`,
      )
    }
  }

  // Shared section
  if (sharedResults.length > 0) {
    const sharedDisplayLimit = isKnownSender
      ? Math.ceil(cfg.maxResults / 2)
      : cfg.maxResults
    const formatted = rankLane(sharedResults, sharedDisplayLimit, "shared")
    if (formatted) {
      sections.push(
        `<shared-context>\nShared memories available to all users.\n\n${formatted}\n</shared-context>`,
      )
    }
  }

  // If only the identity preamble is present (no memory sections), still inject identity
  const haveMemorySections = sections.some(
    (s) => s.startsWith("<personal-context>") || s.startsWith("<shared-context>"),
  )

  if (!haveMemorySections) {
    log.debug("auto-context: no relevant memories found")
    // Coverage signal (proposal 15): one event per turn (not per lane), with
    // per-lane detail so "personal lane was down" is never misread as
    // "personal memory is empty". Written only when at least one lane
    // fulfilled — every-lane-failed is an availability event (#39), already
    // logged by logSearchError above, and "unknown" is not "zero".
    if (cfg.coverageLog) {
      const lanes: CoverageLane[] = []
      if (personalSearch)
        lanes.push(
          personalOk
            ? {
                lane: "personal",
                status: "ok",
                candidates: personalResults.length,
                topScore: topScoreOf(personalResults),
              }
            : { lane: "personal", status: "error" },
        )
      if (sharedSearch)
        lanes.push(
          sharedOk
            ? {
                lane: "shared",
                status: "ok",
                candidates: sharedResults.length,
                topScore: topScoreOf(sharedResults),
              }
            : { lane: "shared", status: "error" },
        )
      if (lanes.some((l) => l.status === "ok")) {
        const candidates = personalResults.length + sharedResults.length
        const fetched = rawPersonalCount + rawSharedCount
        recordCoverageEvent(
          {
            outcome: candidates > 0 ? "below_threshold" : "empty",
            prompt,
            fetched,
            candidates,
            droppedCurrentSession: fetched - candidates,
            topScore: topScoreOf([...personalResults, ...sharedResults]),
            threshold: cfg.relevanceThreshold,
            ranking: cfg.ranking.enabled,
            sessionId: currentSessionId,
            userId: resolved?.userId,
            lanes,
          },
          stateRoot,
        )
      }
    }
    if (isKnownSender && resolved) {
      const contextLine = resolved.context ? ` ${resolved.context}` : ""
      return {
        prependContext: `<hyperspell-context>\nYou are speaking with ${resolved.name}.${contextLine}\n\n${AUTHORITY_GUARD}\n</hyperspell-context>`,
      }
    }
    return
  }

  const totalCount = personalResults.length + sharedResults.length
  log.debug(
    `auto-context: injecting ${totalCount} memories (${personalResults.length} personal, ${sharedResults.length} shared)`,
  )

  // Same repeat-suppression contract as single-user: what landed is
  // remembered per session so later turns spend the budget on NEW memory.
  recordInjected(currentSessionId, laneInjectedIds)

  return {
    prependContext: `<hyperspell-context>\n${sections.join("\n\n")}\n\n${AUTHORITY_GUARD}\n\n${DISCLAIMER}\n</hyperspell-context>`,
  }
}
