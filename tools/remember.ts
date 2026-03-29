import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerRememberTool(
  api: OpenClawPluginApi,
  client: HyperspellClient,
  _cfg: HyperspellConfig,
): void {
  api.registerTool(
    {
      name: "hyperspell_remember",
      label: "Memory Store",
      description: "Save important information to the user's memory.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        title: Type.Optional(
          Type.String({ description: "Optional title for the memory" }),
        ),
        date: Type.Optional(
          Type.String({ description: "Date of the memory (ISO 8601 or YYYY-MM-DD). Helps ranking and enables date-range filtering. Defaults to now if omitted." }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { text: string; title?: string; date?: string },
      ) {
        log.debug(`remember tool: "${params.text.slice(0, 50)}..." date=${params.date ?? "now"}`)

        try {
          await client.addMemory(params.text, {
            title: params.title,
            date: params.date,
            metadata: { source: "openclaw_tool" },
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
    },
    { name: "hyperspell_remember" },
  )
}
