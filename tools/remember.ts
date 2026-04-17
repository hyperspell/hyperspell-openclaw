import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import {
  getDefaultWriteScope,
  resolveRole,
  resolveUser,
  routeWrite,
} from "../lib/sender.ts"
import { log } from "../logger.ts"

export function createRememberToolFactory(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  const scopingEnabled = !!cfg.multiUser?.scoping
  const availableScopes = cfg.multiUser?.scoping?.scopes ?? []
  const scopeDescription = scopingEnabled
    ? `Privacy scope for this memory. Available: ${availableScopes.join(", ")}. Defaults to the user's role default.`
    : "Privacy scope (only used when scoping is enabled in config)."

  return (ctx: Record<string, unknown>) => ({
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
      userId: Type.Optional(
        Type.String({
          description:
            "Store for a specific user or 'shared' for everyone. Omit to store for current sender.",
        }),
      ),
      scope: Type.Optional(
        Type.String({ description: scopeDescription }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string; title?: string; date?: string; userId?: string; scope?: string },
    ) {
      const resolved = resolveUser(ctx, cfg)

      // Scope resolution: explicit param > role default > global default > "private"
      const scope =
        params.scope ??
        (scopingEnabled ? getDefaultWriteScope(resolved, cfg) : "private")

      // Validate scope is in declared vocabulary (if scoping is enabled)
      if (
        scopingEnabled &&
        availableScopes.length > 0 &&
        !availableScopes.includes(scope)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown scope "${scope}". Available: ${availableScopes.join(", ")}.`,
            },
          ],
        }
      }

      // canWriteScopes enforcement (role-level deny list)
      if (scopingEnabled) {
        const role = resolveRole(resolved, cfg)
        if (role?.canWriteScopes && !role.canWriteScopes.includes(scope)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `You cannot write to scope "${scope}".`,
              },
            ],
          }
        }
      }

      // Route: explicit userId override takes precedence; otherwise derive from scope
      let userId: string | undefined
      let collection: string | undefined
      if (params.userId) {
        userId = params.userId
      } else if (scopingEnabled) {
        const routed = routeWrite(resolved, scope, cfg)
        userId = routed.userId
        collection = routed.collection
      } else {
        userId = resolved?.userId
      }

      log.debug(
        `remember tool: "${params.text.slice(0, 50)}..." date=${params.date ?? "now"} userId=${userId} scope=${scope}`,
      )

      try {
        await client.addMemory(params.text, {
          title: params.title,
          date: params.date,
          collection,
          metadata: { source: "openclaw_tool" },
          userId,
          scope: scopingEnabled ? scope : undefined,
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
