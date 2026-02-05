import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { log } from "../logger.ts"

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

function formatScore(score: number | null): string {
  if (score === null) return ""
  return ` (${Math.round(score * 100)}%)`
}

export function registerCommands(
  api: OpenClawPluginApi,
  client: HyperspellClient,
  _cfg: HyperspellConfig,
): void {
  // /getcontext <query> - Search memories and show summaries
  api.registerCommand({
    name: "getcontext",
    description: "Search your memories for relevant context",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string }) => {
      const query = ctx.args?.trim()
      if (!query) {
        return { text: "Usage: /getcontext <search query>" }
      }

      log.debug(`/getcontext command: "${query}"`)

      try {
        const results = await client.search(query, { limit: 5 })

        if (results.length === 0) {
          return { text: `No memories found for: "${query}"` }
        }

        const lines = results.map((r, i) => {
          const title = r.title ? truncate(r.title, 60) : `[${r.source}]`
          const score = formatScore(r.score)
          return `${i + 1}. ${title}${score}`
        })

        return {
          text: `Found ${results.length} memories:\n\n${lines.join("\n")}`,
        }
      } catch (err) {
        log.error("/getcontext failed", err)
        return { text: "Failed to search memories. Check logs for details." }
      }
    },
  })

  // /remember <text> - Add a new memory
  api.registerCommand({
    name: "remember",
    description: "Save something to memory",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string }) => {
      const text = ctx.args?.trim()
      if (!text) {
        return { text: "Usage: /remember <text to remember>" }
      }

      log.debug(`/remember command: "${truncate(text, 50)}"`)

      try {
        await client.addMemory(text, {
          metadata: { source: "openclaw_command" },
        })

        const preview = truncate(text, 60)
        return { text: `Remembered: "${preview}"` }
      } catch (err) {
        log.error("/remember failed", err)
        return { text: "Failed to save memory. Check logs for details." }
      }
    },
  })
}
