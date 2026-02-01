import type { HyperspellClient, SearchResult } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
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
  return async (event: Record<string, unknown>) => {
    const prompt = event.prompt as string | undefined
    if (!prompt || prompt.length < 5) return

    log.debug(`auto-context: searching for "${prompt.slice(0, 50)}..."`)

    try {
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
