import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { HyperspellClient } from "./client.ts"
import { registerCommands } from "./commands/slash.ts"
import { registerCliCommands } from "./commands/setup.ts"
import { parseConfig, hyperspellConfigSchema, getWorkspaceDir } from "./config.ts"
import { buildAutoContextHandler } from "./hooks/auto-context.ts"
import { buildFileSyncHandler, syncMemoriesOnStartup } from "./hooks/memory-sync.ts"
import { initLogger } from "./logger.ts"
import { registerRememberTool } from "./tools/remember.ts"
import { registerSearchTool } from "./tools/search.ts"

export default {
  id: "openclaw-hyperspell",
  name: "Hyperspell",
  description: "Hyperspell gives your Molty context and memory from all your existing data",
  kind: "memory" as const,
  configSchema: hyperspellConfigSchema,

  register(api: OpenClawPluginApi) {
    // Register CLI commands (openclaw openclaw-hyperspell setup|status|connect)
    api.registerCli(
      (ctx) => {
        registerCliCommands(ctx.program, api.pluginConfig)
      },
      { commands: ["openclaw-hyperspell"] },
    )

    // Check if configured
    const rawConfig = api.pluginConfig as Record<string, unknown> | undefined
    const hasConfig = rawConfig?.apiKey || process.env.HYPERSPELL_API_KEY

    if (!hasConfig) {
      api.logger.info("hyperspell: not configured - run 'openclaw openclaw-hyperspell setup'")
      // Still register slash commands so they show up, but they'll return an error
      api.registerCommand({
        name: "getcontext",
        description: "Search your memories for relevant context",
        acceptsArgs: true,
        requireAuth: false,
        handler: async () => {
          return { text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first." }
        },
      })
      api.registerCommand({
        name: "remember",
        description: "Save something to memory",
        acceptsArgs: true,
        requireAuth: false,
        handler: async () => {
          return { text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first." }
        },
      })
      api.registerCommand({
        name: "sync",
        description: "Sync memory/*.md files with Hyperspell",
        acceptsArgs: false,
        requireAuth: false,
        handler: async () => {
          return { text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first." }
        },
      })
      return
    }

    const cfg = parseConfig(api.pluginConfig)

    initLogger(api.logger, cfg.debug)

    const client = new HyperspellClient(cfg)

    // Register AI tools
    registerSearchTool(api, client, cfg)
    registerRememberTool(api, client, cfg)

    // Register auto-context hook
    if (cfg.autoContext) {
      const autoContextHandler = buildAutoContextHandler(client, cfg)
      api.on("before_agent_start", autoContextHandler)
    }

    // Register memory sync hook
    if (cfg.syncMemories) {
      const fileSyncHandler = buildFileSyncHandler(client, cfg)
      api.on("file_changed", fileSyncHandler)
    }

    // Register slash commands
    registerCommands(api, client, cfg)

    // Register service for lifecycle management
    api.registerService({
      id: "openclaw-hyperspell",
      start: async () => {
        api.logger.info("hyperspell: connected")

        // Sync memories on startup if enabled
        if (cfg.syncMemories) {
          const workspaceDir = getWorkspaceDir()
          await syncMemoriesOnStartup(client, workspaceDir)
        }
      },
      stop: () => {
        api.logger.info("hyperspell: stopped")
      },
    })
  },
}
