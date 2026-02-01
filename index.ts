import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { HyperspellClient } from "./client.ts"
import { registerCommands } from "./commands/slash.ts"
import { parseConfig, hyperspellConfigSchema } from "./config.ts"
import { buildAutoContextHandler } from "./hooks/auto-context.ts"
import { initLogger } from "./logger.ts"
import { registerRememberTool } from "./tools/remember.ts"
import { registerSearchTool } from "./tools/search.ts"

export default {
  id: "openclaw-hyperspell",
  name: "Hyperspell",
  description: "OpenClaw powered by Hyperspell - RAG-as-a-service for your connected sources",
  kind: "memory" as const,
  configSchema: hyperspellConfigSchema,

  register(api: OpenClawPluginApi) {
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

    // Register slash commands
    registerCommands(api, client, cfg)

    // Register service for lifecycle management
    api.registerService({
      id: "openclaw-hyperspell",
      start: () => {
        api.logger.info("hyperspell: connected")
      },
      stop: () => {
        api.logger.info("hyperspell: stopped")
      },
    })
  },
}
