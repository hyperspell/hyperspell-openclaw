import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HyperspellClient } from "../client.ts"
import type { CanReadScope, HyperspellConfig } from "../config.ts"
import { getWorkspaceDir } from "../config.ts"
import { MOOD_WEATHER_COLLECTION } from "../hooks/mood-weather.ts"
import { MOOD_WEATHER_SOURCE } from "../lib/filters.ts"
import {
  buildScopeFilter,
  getCanReadScopes,
  getDefaultWriteScope,
  resolveRole,
  resolveUser,
  routeWrite,
} from "../lib/sender.ts"
import { log } from "../logger.ts"
import { syncAllMemoryFiles } from "../sync/markdown.ts"
import { buildPreviewReport } from "./preview.ts"

/**
 * Strip a `#scope-name` prefix from free text. Returns the scope and the
 * remainder. Used by /remember and /getcontext to let users narrow or route
 * via a single keystroke.
 */
function parseScopePrefix(text: string): { scope?: string; rest: string } {
  const m = text.match(/^#(\S+)\s+(.*)$/)
  if (!m) return { rest: text }
  return { scope: m[1], rest: m[2] }
}

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
  cfg: HyperspellConfig,
): void {
  // /getcontext <query> - Search memories and show summaries
  api.registerCommand({
    name: "getcontext",
    description: "Search your memories for relevant context",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string; senderId?: string; channel?: string }) => {
      const rawArgs = ctx.args?.trim()
      if (!rawArgs) {
        return { text: "Usage: /getcontext [#scope] <search query>" }
      }
      const { scope: requestedScope, rest: query } = parseScopePrefix(rawArgs)

      const resolved = resolveUser(ctx as Record<string, unknown>, cfg)
      const userId = resolved?.userId

      // Build scope filter: intersect requested scope (if any) with caller's canRead.
      let filter: Record<string, unknown> | undefined
      if (cfg.multiUser?.scoping) {
        const canRead = getCanReadScopes(resolved, cfg)
        const allowed: CanReadScope[] = requestedScope
          ? canRead.includes("*") || canRead.includes(requestedScope)
            ? [requestedScope]
            : []
          : canRead
        filter = buildScopeFilter(allowed, resolved?.userId ?? "")
      }

      log.debug(
        `/getcontext command: "${query}" userId=${userId} scope=${requestedScope ?? "any"}`,
      )

      try {
        const results = await client.search(query, { limit: 5, userId, filter })

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
    handler: async (ctx: { args?: string; senderId?: string; channel?: string }) => {
      const rawArgs = ctx.args?.trim()
      if (!rawArgs) {
        return { text: "Usage: /remember [#scope] <text to remember>" }
      }
      const { scope: requestedScope, rest: text } = parseScopePrefix(rawArgs)

      const resolved = resolveUser(ctx as Record<string, unknown>, cfg)
      const scopingEnabled = !!cfg.multiUser?.scoping
      const availableScopes = cfg.multiUser?.scoping?.scopes ?? []

      // Scope resolution: prefix > role default > global default > "private"
      const scope = scopingEnabled
        ? (requestedScope ?? getDefaultWriteScope(resolved, cfg))
        : "private"

      // Validate scope is in declared vocabulary
      if (
        scopingEnabled &&
        requestedScope &&
        availableScopes.length > 0 &&
        !availableScopes.includes(scope)
      ) {
        return {
          text: `Unknown scope "${scope}". Available: ${availableScopes.join(", ")}.`,
        }
      }

      // canWriteScopes enforcement
      if (scopingEnabled) {
        const role = resolveRole(resolved, cfg)
        if (role?.canWriteScopes && !role.canWriteScopes.includes(scope)) {
          return { text: `You cannot write to scope "${scope}".` }
        }
      }

      const { userId, collection } = scopingEnabled
        ? routeWrite(resolved, scope, cfg)
        : { userId: resolved?.userId, collection: undefined }

      log.debug(
        `/remember command: "${truncate(text, 50)}" userId=${userId} scope=${scope}`,
      )

      try {
        await client.addMemory(text, {
          // openclaw_writer: the /remember COMMAND is the USER writing —
          // these rows keep the curation boost (vs the agent's tool writes,
          // routed to process). Paired stamp; see tools/remember.ts.
          metadata: { source: "openclaw_command", openclaw_writer: "user" },
          collection,
          userId,
          scope: scopingEnabled ? scope : undefined,
        })

        const preview = truncate(text, 60)
        const scopeHint = scopingEnabled ? ` [${scope}]` : ""
        return { text: `Remembered${scopeHint}: "${preview}"` }
      } catch (err) {
        log.error("/remember failed", err)
        return { text: "Failed to save memory. Check logs for details." }
      }
    },
  })

  // /sync - Manually sync memory files
  api.registerCommand({
    name: "sync",
    description: "Sync memory/*.md files with Hyperspell",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      log.debug("/sync command")

      try {
        const workspaceDir = getWorkspaceDir()
        const result = await syncAllMemoryFiles(client, workspaceDir, {
          userId: cfg.multiUser?.sharedUserId,
        })

        if (result.synced === 0 && result.failed === 0) {
          return { text: "No memory files found in memory/ directory." }
        }

        if (result.failed > 0) {
          const errors = result.errors.map((e) => `  • ${e}`).join("\n")
          return {
            text: `Synced ${result.synced} files, ${result.failed} failed:\n${errors}`,
          }
        }

        return { text: `Synced ${result.synced} memory file(s) to Hyperspell.` }
      } catch (err) {
        log.error("/sync failed", err)
        return { text: "Failed to sync memory files. Check logs for details." }
      }
    },
  })

  // /moodweather — private roll history (operator retrospection only; these rows
  // are excluded from all agent recall, so this command is the ONLY reader).
  api.registerCommand({
    name: "moodweather",
    description: "Show recent mood-weather rolls (never fed back into tone)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      log.debug("/moodweather command")
      try {
        const rows: Array<{ mood: string; rolledAt: string }> = []
        for await (const mem of client.listMemories({
          collection: MOOD_WEATHER_COLLECTION,
          pageSize: 50,
        })) {
          if (mem.metadata?.openclaw_source !== MOOD_WEATHER_SOURCE) continue
          rows.push({
            mood: String(mem.metadata.mood ?? "?"),
            rolledAt: String(mem.metadata.rolled_at ?? ""),
          })
          if (rows.length >= 20) break
        }
        if (rows.length === 0) {
          return { text: "No mood-weather rolls recorded." }
        }
        const lines = rows.map(
          (r) => `• ${r.rolledAt.slice(0, 16).replace("T", " ")} — ${r.mood}`,
        )
        return {
          text: `Recent mood-weather rolls (newest first):\n${lines.join("\n")}`,
        }
      } catch (err) {
        log.error("/moodweather failed", err)
        return { text: "Failed to fetch mood-weather history. Check logs for details." }
      }
    },
  })

  // /previewcontext - Show what would be injected into the next session
  api.registerCommand({
    name: "previewcontext",
    description: "Preview what Hyperspell would inject at the next session start",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: { args?: string; senderId?: string; channel?: string }) => {
      log.debug("/previewcontext command")
      try {
        return { text: await buildPreviewReport(client, cfg, ctx) }
      } catch (err) {
        log.error("/previewcontext failed", err)
        return { text: "Failed to build preview. Check logs for details." }
      }
    },
  })
}
