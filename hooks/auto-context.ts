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
import { classifySearchError, logSearchError } from "../lib/search-error.ts"
import { resolveCurrentSessionId } from "../lib/session.ts"
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

/**
 * Format already-SELECTED composite-ranked results (threshold + chatter quota
 * applied upstream by selectRanked). Highlights are floored at the lower of
 * (threshold, the result's own base relevance), so we don't hide the very lines
 * that define a boosted-but-quiet memory.
 */
function formatSelected(selected: RankedResult[], threshold: number): string | null {
  const sections: string[] = []

  for (const r of selected) {
    const hiFloor = Math.min(threshold, r._base)
    const chosen = [...r.highlights]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter((h) => (h.score ?? 0) >= hiFloor)
      .slice(0, 2)
    if (chosen.length === 0) continue

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

export function buildAutoContextHandler(
  client: HyperspellClient,
  cfg: HyperspellConfig,
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
      return multiUserSearch(client, cfg, prompt, resolved, currentSessionId)
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
      const results = dropCurrentSession(
        await client.search(prompt, { limit, filter: excludeFilterFor(cfg) }),
        currentSessionId,
      )

      let formatted: string | null
      if (ranking.enabled) {
        const ranked = rerank(results, ranking)
        // Threshold + chatter quota applied here, so a high-similarity echo can
        // inform but never flood (the quota bounds count; the penalty bounds rank).
        const explained = explainSelection(
          ranked,
          cfg.maxResults,
          cfg.relevanceThreshold,
          ranking.chatterQuota,
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
        return
      }
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

// Score logging / cut attribution (proposal 02) applies to the ranked
// single-user path only: this path never runs rerank/explainSelection, so
// there is no composite score to attribute. If ranking ever lands here, call
// logScoreSamples with scope "personal" / "shared" per search.
async function multiUserSearch(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  prompt: string,
  resolved: ResolvedUser | undefined,
  currentSessionId: string | undefined,
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

  // Build parallel searches — personal (known senders only) + shared
  const personalSearch = isKnownSender
    ? client.search(prompt, {
        limit: cfg.maxResults,
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
          limit: sharedLimit,
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

  if (personalSearch) {
    const r = settled[idx++]
    if (r.status === "fulfilled") {
      personalResults = dropCurrentSession(r.value, currentSessionId)
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
      sharedResults = dropCurrentSession(r.value, currentSessionId)
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

  // User identity preamble
  if (isKnownSender && resolved) {
    const contextLine = resolved.context ? ` ${resolved.context}` : ""
    sections.push(`You are speaking with ${resolved.name}.${contextLine}`)
  }

  // Personal section (threshold-filtered per PR #11/#12 format)
  if (isKnownSender && personalResults.length > 0 && resolved) {
    const formatted = formatHighlightBullets(
      personalResults,
      cfg.maxResults,
      cfg.relevanceThreshold,
    )
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
    const formatted = formatHighlightBullets(
      sharedResults,
      sharedDisplayLimit,
      cfg.relevanceThreshold,
    )
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

  return {
    prependContext: `<hyperspell-context>\n${sections.join("\n\n")}\n\n${AUTHORITY_GUARD}\n\n${DISCLAIMER}\n</hyperspell-context>`,
  }
}
