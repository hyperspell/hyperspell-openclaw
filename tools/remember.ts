import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { channelIdFromCtx } from "../lib/exclude-channels.ts"
import {
  getDefaultWriteScope,
  resolveRole,
  resolveUser,
  routeWrite,
} from "../lib/sender.ts"
import { resolveCurrentSessionId } from "../lib/session.ts"
import { recordSessionWrite } from "../lib/session-writes.ts"
import { isMultiSpeaker } from "../lib/speaker-tracker.ts"
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
      // Decline silently-wrong writes in multi-speaker sessions with no multiUser
      // config. Without per-sender routing the memory would land under cfg.userId
      // regardless of who asked — contaminating the primary user's store with
      // another person's data (attribution gap 1, issue #59 follow-up).
      const sessionId = resolveCurrentSessionId(undefined, ctx)
      if (isMultiSpeaker(sessionId, ctx?.is_group_chat === true) && !cfg.multiUser) {
        log.warn("remember tool: declining write — multi-speaker session with no multiUser config; cannot attribute memory to current speaker")
        return {
          content: [
            {
              type: "text" as const,
              text: "I can't store this memory right now — this is a multi-speaker session and without per-user memory configuration I have no way to attribute it to the right person. The memory would land in the primary user's store regardless of who asked. To fix this, add a `multiUser` config block to the plugin settings.",
            },
          ],
        }
      }

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

      // Tag with the originating conversation so purge-channel can find this
      // memory if the channel is quarantined later (the tool is already
      // suppressed in channels that are quarantined NOW).
      const channelId = channelIdFromCtx(ctx)

      try {
        const written = await client.addMemory(params.text, {
          title: params.title,
          date: params.date,
          collection,
          metadata: {
            source: "openclaw_tool",
            // Authorship stamp (2026-08-24): this tool is the AGENT writing.
            // Ranking routes agent-authored rows to the neutral process kind —
            // the agent must never hold the curation boost on its own notes.
            // Legacy rows lack the stamp; client.writerOf falls back to the
            // source surface tag above, which has been written since January.
            openclaw_writer: "agent",
            ...(channelId ? { openclaw_channel_id: channelId } : {}),
          },
          userId,
          scope: scopingEnabled ? scope : undefined,
        })

        // Same-session echo guard (C3): a fresh remember id is invisible to
        // dropCurrentSession, so without this the note comes straight back
        // through the next turn's auto-context, curated-boosted. Recording it
        // lets retrieval exclude it for the rest of THIS session only.
        recordSessionWrite(sessionId, written.resourceId)

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
