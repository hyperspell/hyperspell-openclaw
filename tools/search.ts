import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerSearchTool(
  api: OpenClawPluginApi,
  client: HyperspellClient,
  _cfg: HyperspellConfig,
): void {
  api.registerTool(
    {
      name: "hyperspell_search",
      label: "Memory Search",
      description:
        "Search through the user's connected sources (Notion, Slack, Gmail, Google Drive, etc.) for relevant information.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 5)" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { query: string; limit?: number },
      ) {
        const limit = params.limit ?? 5
        log.debug(`search tool: query="${params.query}" limit=${limit}`)

        const results = await client.search(params.query, { limit })

        if (results.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No relevant memories found." },
            ],
          }
        }

        const text = results
          .map((r, i) => {
            const title = r.title ?? `[${r.source}]`
            const score = r.score
              ? ` (${Math.round(r.score * 100)}%)`
              : ""
            return `${i + 1}. ${title}${score}`
          })
          .join("\n")

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} memories:\n\n${text}`,
            },
          ],
          details: {
            count: results.length,
            memories: results.map((r) => ({
              resourceId: r.resourceId,
              title: r.title,
              source: r.source,
              score: r.score,
            })),
          },
        }
      },
    },
    { name: "hyperspell_search" },
  )
}
