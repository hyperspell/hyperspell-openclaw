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

        try {
          const response = await client.searchRaw(params.query, { limit })
          const documents = (response.documents ?? []) as Array<{
            source: string
            resource_id: string
            score?: number
            summary?: string
            title?: string
            metadata?: Record<string, unknown>
            highlights?: Array<{ text: string }>
            data?: Array<{ text: string }>
          }>

          if (documents.length === 0) {
            return {
              content: [
                { type: "text" as const, text: "No relevant memories found." },
              ],
            }
          }

          const formattedDocs = documents
            .map((doc, i) => {
              const relevance = doc.score
                ? `${Math.round(doc.score * 100)}%`
                : "N/A"
              const title = doc.title || "(untitled)"
              const summary = doc.summary || "(no summary)"
              return `${i + 1}. Source: ${doc.source}\n   Title: ${title}\n   Summary: ${summary}\n   Relevance: ${relevance}`
            })
            .join("\n\n")

          const text = `Found ${documents.length} memories:\n\n${formattedDocs}`

          return {
            content: [
              {
                type: "text" as const,
                text,
              },
            ],
            details: {
              count: documents.length,
              documents,
            },
          }
        } catch (err) {
          log.error("search tool failed", err)
          return {
            content: [
              {
                type: "text" as const,
                text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          }
        }
      },
    },
    { name: "hyperspell_search" },
  )
}
