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

function formatContext(results: SearchResult[], maxResults: number, threshold: number): string | null {
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

  const intro =
    "The following is context from the user's connected sources. Reference it only when relevant to the conversation."
  const disclaimer =
    "Use this context naturally when relevant — including indirect connections — but don't force it into every response or make assumptions beyond what's stated."

  return `<hyperspell-context>\n${intro}\n\n${sections.join("\n\n")}\n\n${disclaimer}\n</hyperspell-context>`
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
      const context = formatContext(results, cfg.maxResults, cfg.relevanceThreshold)

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
