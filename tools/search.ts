import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { CanReadScope, HyperspellConfig } from "../config.ts"
import { mergeWithExclude } from "../lib/filters.ts"
import { buildScopeFilter, getCanReadScopes, resolveUser } from "../lib/sender.ts"
import { log } from "../logger.ts"

export function createSearchToolFactory(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  const scopingEnabled = !!cfg.multiUser?.scoping
  const availableScopes = cfg.multiUser?.scoping?.scopes ?? []
  const scopeDescription = scopingEnabled
    ? `Narrow search to a single privacy scope. Available: ${availableScopes.join(", ")}. Omit to search all scopes visible to the caller's role.`
    : "Privacy scope (only used when scoping is enabled in config)."

  return (ctx: Record<string, unknown>) => ({
    name: "hyperspell_search",
    label: "Memory Search",
    description:
      "Search through the user's connected sources (Notion, Slack, Gmail, Google Drive, etc.) for relevant information.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 5)" }),
      ),
      after: Type.Optional(
        Type.String({ description: "Only return memories created on or after this date (ISO 8601 or YYYY-MM-DD)" }),
      ),
      before: Type.Optional(
        Type.String({ description: "Only return memories created before this date (ISO 8601 or YYYY-MM-DD)" }),
      ),
      userId: Type.Optional(
        Type.String({
          description:
            "Search as a specific user (e.g. 'ben', 'shared'). Omit to search as current sender.",
        }),
      ),
      scope: Type.Optional(Type.String({ description: scopeDescription })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        query: string
        limit?: number
        after?: string
        before?: string
        userId?: string
        scope?: string
      },
    ) {
      const limit = params.limit ?? 5
      const resolved = resolveUser(ctx, cfg)
      const userId = params.userId ?? resolved?.userId

      // Build scope filter: intersect requested scope (if any) with caller's canRead
      let filter: Record<string, unknown> | undefined
      if (scopingEnabled) {
        const canRead = getCanReadScopes(resolved, cfg)
        const allowed: CanReadScope[] = params.scope
          ? canRead.includes("*")
            ? [params.scope]
            : canRead.includes(params.scope)
              ? [params.scope]
              : [] // requested scope not allowed → match nothing
          : canRead
        filter = buildScopeFilter(allowed, resolved?.userId ?? "")
      }

      // Keep session-end trace memories out of agent-facing search, matching
      // the auto-context hook so both retrieval paths filter identically.
      filter = mergeWithExclude(filter)

      log.debug(
        `search tool: query="${params.query}" limit=${limit} after=${params.after ?? "none"} before=${params.before ?? "none"} userId=${userId} scope=${params.scope ?? "any"}`,
      )

      try {
        const response = await client.searchRaw(params.query, {
          limit,
          after: params.after,
          before: params.before,
          userId,
          filter,
        })
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
          content: [{ type: "text" as const, text }],
          details: { count: documents.length, documents },
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
  })
}
