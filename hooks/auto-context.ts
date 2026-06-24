import type { HyperspellClient, SearchResult } from "../client.ts"
import type { CanReadScope, HyperspellConfig } from "../config.ts"
import {
  buildScopeFilter,
  getCanReadScopes,
  resolveUser,
  type ResolvedUser,
} from "../lib/sender.ts"
import { excludeFilterFor, mergeWithExclude } from "../lib/filters.ts"
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

const INTRO =
  "The following is surfaced from the user's memory and connected sources, including past conversations. Reference it as recalled context, only when relevant to the conversation."
const DISCLAIMER =
  "Draw on it when relevant — including indirect connections — but don't force it into every response or make assumptions beyond what's stated."

function wrapSingle(body: string): string {
  return `<hyperspell-context>\n${INTRO}\n\n${body}\n\n${DISCLAIMER}\n</hyperspell-context>`
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

    // Multi-user path
    if (cfg.multiUser) {
      const resolved = resolveUser(ctx, cfg)
      return multiUserSearch(client, cfg, prompt, resolved)
    }

    // Single-user path — preserves main's highlights + threshold behavior
    log.debug(`auto-context: searching for "${prompt.slice(0, 50)}..."`)

    try {
      const results = await client.search(prompt, {
        limit: cfg.maxResults,
        filter: excludeFilterFor(cfg),
      })
      const formatted = formatHighlightBullets(
        results,
        cfg.maxResults,
        cfg.relevanceThreshold,
      )

      if (!formatted) {
        log.debug("auto-context: no relevant memories found")
        return
      }

      log.debug(`auto-context: injecting ${results.length} memories`)
      return { prependContext: wrapSingle(formatted) }
    } catch (err) {
      log.error("auto-context failed", err)
      return
    }
  }
}

async function multiUserSearch(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  prompt: string,
  resolved: ResolvedUser | undefined,
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
      personalResults = r.value
    } else {
      log.error("auto-context: personal search failed", r.reason)
    }
  }
  if (sharedSearch) {
    const r = settled[idx++]
    if (r.status === "fulfilled") {
      sharedResults = r.value
    } else {
      log.error("auto-context: shared search failed", r.reason)
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
        prependContext: `<hyperspell-context>\nYou are speaking with ${resolved.name}.${contextLine}\n</hyperspell-context>`,
      }
    }
    return
  }

  const totalCount = personalResults.length + sharedResults.length
  log.debug(
    `auto-context: injecting ${totalCount} memories (${personalResults.length} personal, ${sharedResults.length} shared)`,
  )

  return {
    prependContext: `<hyperspell-context>\n${sections.join("\n\n")}\n\n${DISCLAIMER}\n</hyperspell-context>`,
  }
}
