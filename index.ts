import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { HyperspellClient } from "./client.ts"
import { registerCommands } from "./commands/slash.ts"
import { registerCliCommands } from "./commands/setup.ts"
import { parseConfig, hyperspellConfigSchema, getWorkspaceDir } from "./config.ts"
import { buildAutoContextHandler } from "./hooks/auto-context.ts"
import { buildAutoTraceHandler } from "./hooks/auto-trace.ts"
import {
	buildEmotionalStateCompactionHandler,
	buildEmotionalStateFetchHandler,
	buildEmotionalStateSessionCleanupHandler,
	buildEmotionalStateStoreHandler,
} from "./hooks/emotional-state.ts"
import { buildFileSyncHandler, syncMemoriesOnStartup } from "./hooks/memory-sync.ts"
import {
	buildStartupOrientationCompactionHandler,
	buildStartupOrientationHandler,
	buildStartupOrientationSessionCleanupHandler,
} from "./hooks/startup-orientation.ts"
import { initLogger, log } from "./logger.ts"
import { createRememberToolFactory } from "./tools/remember.ts"
import { createSearchToolFactory } from "./tools/search.ts"
import { registerNetworkTools } from "./graph/index.ts"

export default {
	id: "openclaw-hyperspell",
	name: "Hyperspell",
	description:
		"Hyperspell gives your Molty context and memory from all your existing data",
	kind: "memory" as const,
	configSchema: hyperspellConfigSchema,

	register(api: OpenClawPluginApi) {
		// Register CLI commands (openclaw openclaw-hyperspell setup|status|connect)
		api.registerCli(
			(ctx) => {
				registerCliCommands(ctx.program, api.pluginConfig);
			},
			{ commands: ["openclaw-hyperspell"] },
		);

		// Check if configured
		const rawConfig = api.pluginConfig as Record<string, unknown> | undefined;
		const hasConfig = rawConfig?.apiKey || process.env.HYPERSPELL_API_KEY;

		if (!hasConfig) {
			api.logger.info(
				"hyperspell: not configured - run 'openclaw openclaw-hyperspell setup'",
			)
			// Still register slash commands so they show up, but they'll return an error
			api.registerCommand({
				name: "getcontext",
				description: "Search your memories for relevant context",
				acceptsArgs: true,
				requireAuth: false,
				handler: async () => {
					return {
						text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first.",
					}
				},
			})
			api.registerCommand({
				name: "remember",
				description: "Save something to memory",
				acceptsArgs: true,
				requireAuth: false,
				handler: async () => {
					return {
						text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first.",
					}
				},
			})
			api.registerCommand({
				name: "sync",
				description: "Sync memory/*.md files with Hyperspell",
				acceptsArgs: false,
				requireAuth: false,
				handler: async () => {
					return {
						text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first.",
					}
				},
			})
			return
		}

		const cfg = parseConfig(api.pluginConfig);

		initLogger(api.logger, cfg.debug);

		const client = new HyperspellClient(cfg);

		// Register AI tools (factory pattern for sender context)
		api.registerTool(createSearchToolFactory(client, cfg), {
			name: "hyperspell_search",
		});
		api.registerTool(createRememberToolFactory(client, cfg), {
			name: "hyperspell_remember",
		});

		// Register emotional context hooks.
		// - fetch: inject once per session on first turn (cached thereafter)
		// - compaction: clear cache so the next turn re-injects after trim
		// - session cleanup: drop Set entry on session end
		// - store: extract new emotional state from the finished session
		if (cfg.emotionalContext) {
			api.on("before_agent_start", buildEmotionalStateFetchHandler(client, cfg));
			api.on("after_compaction", buildEmotionalStateCompactionHandler());
			api.on("session_end", buildEmotionalStateSessionCleanupHandler());
			api.on("agent_end", buildEmotionalStateStoreHandler(client, cfg));
		}

		// Register auto-context hook
		if (cfg.autoContext) {
			const autoContextHandler = buildAutoContextHandler(client, cfg);
			api.on("before_agent_start", autoContextHandler);
		}

		// Register startup-orientation hooks: recent-interactions + unfinished-loops
		// injected once per session on first turn. Lifecycle mirrors emotional-context.
		if (cfg.startupOrientation.enabled) {
			// The recent-interactions half reads source:"trace" / openclaw_source:"agent_end"
			// memories, which are ONLY written by the auto-trace hook. With auto-trace off,
			// that half silently injects nothing forever (recent=0). Warn so the operator
			// knows the configured feature is half-inert rather than wondering why their
			// agent has no recent continuity.
			if (!cfg.autoTrace.enabled) {
				log.warn(
					"startup-orientation is enabled but autoTrace is disabled; recent-interactions injection will be empty (no traces are written). Enable autoTrace to restore recent-conversation continuity.",
				);
			}
			api.on("before_agent_start", buildStartupOrientationHandler(client, cfg));
			api.on("after_compaction", buildStartupOrientationCompactionHandler());
			api.on("session_end", buildStartupOrientationSessionCleanupHandler());
		}

		// Register auto-trace hook (send conversations to Hyperspell on session end)
		if (cfg.autoTrace.enabled) {
			api.on("agent_end", buildAutoTraceHandler(client, cfg));
		}

		// Register memory sync hook
		if (cfg.syncMemories) {
			const fileSyncHandler = buildFileSyncHandler(client, cfg);
			api.on("file_changed", fileSyncHandler);
			api.logger.info(
				`hyperspell: memory sync enabled (sectionize=${cfg.syncMemoriesConfig.sectionize}, watchPaths=${cfg.syncMemoriesConfig.watchPaths.length})`,
			);
		}

		// Register memory network tools
		if (cfg.knowledgeGraph.enabled) {
			registerNetworkTools(api, client, cfg);
		}

		// Register slash commands
		registerCommands(api, client, cfg);

		// Register service for lifecycle management
		api.registerService({
			id: "openclaw-hyperspell",
			start: async () => {
				api.logger.info("hyperspell: connected");

				// Sync memories on startup if enabled.
				//
				// Deliberately NOT awaited: the bulk sync is sequential and
				// network-bound (one request per changed section), so awaiting
				// it here stalls the agent's startup until the entire corpus
				// has been processed. Run it in the background and let the
				// agent come up immediately; failures are logged, not fatal.
				if (cfg.syncMemories) {
					const workspaceDir = getWorkspaceDir();
					void syncMemoriesOnStartup(client, workspaceDir, {
						userId: cfg.multiUser?.sharedUserId,
						sectionize: cfg.syncMemoriesConfig.sectionize,
						watchPaths: cfg.syncMemoriesConfig.watchPaths,
						maxAgeDays: cfg.syncMemoriesConfig.maxAgeDays,
						ignorePaths: cfg.syncMemoriesConfig.ignorePaths,
					}).catch((err) => {
						api.logger.error("hyperspell: background memory sync failed", err);
					});
				}
			},
			stop: () => {
				api.logger.info("hyperspell: stopped");
			},
		});
	},
};
