import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { resolveUser } from "../lib/sender.ts"
import { log } from "../logger.ts"

export function createRememberToolFactory(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  return (ctx: Record<string, unknown>) => ({
    name: "hyperspell_remember",
    label: "Memory Store",
    description: "Save important information to the user's memory.",
    parameters: Type.Object({
      text: Type.String({ description: "Information to remember" }),
      title: Type.Optional(
        Type.String({ description: "Optional title for the memory" }),
      ),
      userId: Type.Optional(
        Type.String({
          description:
            "Store for a specific user or 'shared' for everyone. Omit to store for current sender.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string; title?: string; userId?: string },
    ) {
      // Resolve userId: explicit param > sender resolution > config default
      const resolved = resolveUser(ctx, cfg)
      const userId = params.userId ?? resolved?.userId
      log.debug(`remember tool: "${params.text.slice(0, 50)}..." userId=${userId}`)

      try {
        await client.addMemory(params.text, {
          title: params.title,
          metadata: { source: "openclaw_tool" },
          userId,
        })

        const preview =
          params.text.length > 80 ? `${params.text.slice(0, 80)}…` : params.text

        return {
          content: [{ type: "text" as const, text: `Stored: "${preview}"` }],
        }
      } catch (err) {
        log.error("remember tool failed", err)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }
    },
  })
}
