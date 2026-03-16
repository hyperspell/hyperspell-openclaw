import type { HyperspellClient, SearchResult } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { resolveUser } from "../lib/sender.ts"
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

function formatResultsList(results: SearchResult[], maxResults: number): string {
  return results
    .slice(0, maxResults)
    .map((r) => {
      const title = r.title ?? `[${r.source}]`
      const timeStr = r.createdAt ? formatRelativeTime(r.createdAt) : ""
      const pct = r.score != null ? `[${Math.round(r.score * 100)}%]` : ""
      const prefix = timeStr ? `[${timeStr}]` : ""
      return `- ${prefix} ${title} ${pct}`.trim()
    })
    .join("\n")
}

function formatContext(results: SearchResult[], maxResults: number): string | null {
  const limited = results.slice(0, maxResults)

  if (limited.length === 0) return null

  const lines = limited.map((r) => {
    const title = r.title ?? `[${r.source}]`
    const timeStr = r.createdAt ? formatRelativeTime(r.createdAt) : ""
    const pct = r.score != null ? `[${Math.round(r.score * 100)}%]` : ""
    const prefix = timeStr ? `[${timeStr}]` : ""
    return `- ${prefix} ${title} ${pct}`.trim()
  })

  const intro =
    "The following is context from the user's connected sources. Reference it only when relevant to the conversation."
  const disclaimer =
    "Use this context naturally when relevant — including indirect connections — but don't force it into every response or make assumptions beyond what's stated."

  return `<hyperspell-context>\n${intro}\n\n## Relevant Memories (with relevance %)\n${lines.join("\n")}\n\n${disclaimer}\n</hyperspell-context>`
}

export function buildAutoContextHandler(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  return async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
    const prompt = event.prompt as string | undefined
    if (!prompt || prompt.length < 5) return

    const resolved = cfg.multiUser ? resolveUser(ctx, cfg) : undefined
    const isMultiUser = !!cfg.multiUser && !!resolved

    log.debug(
      `auto-context: searching for "${prompt.slice(0, 50)}..."${isMultiUser ? ` user=${resolved.userId}` : ""}`,
    )

    try {
      if (isMultiUser) {
        return await multiUserSearch(client, cfg, prompt, resolved)
      }
      // Single-user mode: existing behavior
      const results = await client.search(prompt, { limit: cfg.maxResults })
      const context = formatContext(results, cfg.maxResults)
      if (!context) {
        log.debug("auto-context: no relevant memories found")
        return
      }
      log.debug(`auto-context: injecting ${results.length} memories`)
      return { prependContext: context }
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
  resolved: { userId: string; name: string; context?: string },
) {
  const multiUser = cfg.multiUser!
  const includeShared = multiUser.includeSharedInSearch
  const isUnknownSender = resolved.name === "unknown"

  // For unknown senders, only search shared context
  const searches: Promise<SearchResult[]>[] = []

  if (!isUnknownSender) {
    searches.push(client.search(prompt, { limit: cfg.maxResults, userId: resolved.userId }))
  }

  if (includeShared) {
    const sharedLimit = isUnknownSender ? cfg.maxResults : Math.ceil(cfg.maxResults / 2)
    searches.push(client.search(prompt, { limit: sharedLimit, userId: multiUser.sharedUserId }))
  }

  const searchResults = await Promise.all(searches)
  let personalResults: SearchResult[] = []
  let sharedResults: SearchResult[] = []

  if (isUnknownSender) {
    sharedResults = searchResults[0] ?? []
  } else {
    personalResults = searchResults[0] ?? []
    sharedResults = searchResults[1] ?? []
  }

  const sections: string[] = []

  // User identity preamble
  if (!isUnknownSender) {
    const contextLine = resolved.context ? ` ${resolved.context}` : ""
    sections.push(`You are speaking with ${resolved.name}.${contextLine}`)
  }

  // Personal section
  if (personalResults.length > 0) {
    const formatted = formatResultsList(personalResults, cfg.maxResults)
    sections.push(
      `<personal-context>\nMemories from ${resolved.name}'s personal sources and history.\n\n## Relevant Memories\n${formatted}\n</personal-context>`,
    )
  }

  // Shared section
  if (sharedResults.length > 0) {
    const formatted = formatResultsList(sharedResults, Math.ceil(cfg.maxResults / 2))
    sections.push(
      `<shared-context>\nShared memories available to all users.\n\n## Relevant Memories\n${formatted}\n</shared-context>`,
    )
  }

  if (sections.length === 0 || (sections.length === 1 && !isUnknownSender)) {
    // Only the preamble, no actual results
    log.debug("auto-context: no relevant memories found")
    // Still inject user identity even with no results
    if (!isUnknownSender && resolved.context) {
      return { prependContext: `<hyperspell-context>\nYou are speaking with ${resolved.name}. ${resolved.context}\n</hyperspell-context>` }
    }
    return
  }

  const totalCount = personalResults.length + sharedResults.length
  log.debug(
    `auto-context: injecting ${totalCount} memories (${personalResults.length} personal, ${sharedResults.length} shared)`,
  )

  const disclaimer =
    "Use this context naturally when relevant — including indirect connections — but don't force it into every response or make assumptions beyond what's stated."

  return { prependContext: `<hyperspell-context>\n${sections.join("\n\n")}\n\n${disclaimer}\n</hyperspell-context>` }
}
