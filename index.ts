import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { HyperspellClient } from "./client.ts"
import { registerCommands } from "./commands/slash.ts"
import { registerCliCommands } from "./commands/setup.ts"
import { parseConfig, hyperspellConfigSchema, getWorkspaceDir, VALID_SOURCES } from "./config.ts"
import { buildAutoContextHandler } from "./hooks/auto-context.ts"
import { buildAutoTraceHandler } from "./hooks/auto-trace.ts"
import {
	buildEmotionalStateCompactionHandler,
	buildEmotionalStateFetchHandler,
	buildEmotionalStateSessionCleanupHandler,
	buildEmotionalStateStoreHandler,
} from "./hooks/emotional-state.ts"
import {
	buildFileSyncHandler,
	buildMemorySyncWatcher,
	syncMemoriesOnStartup,
} from "./hooks/memory-sync.ts"
import {
	buildHotBufferHandler,
	buildHotBufferSessionCleanupHandler,
} from "./hooks/hot-buffer.ts"
import {
	buildStartupOrientationCompactionHandler,
	buildStartupOrientationHandler,
	buildStartupOrientationSessionCleanupHandler,
} from "./hooks/startup-orientation.ts"
import { isExcludedChannel } from "./lib/exclude-channels.ts"
import { initLogger, log } from "./logger.ts"
import { createEmotionalArcToolFactory } from "./tools/emotional-arc.ts"
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
			api.registerCommand({
				name: "previewcontext",
				description: "Preview what Hyperspell would inject at the next session start",
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

		// sourceWeights keys are deliberately not schema-validated (new backend
		// sources must not fail manifest validation), so a typo is a silent
		// neutral no-op — surface it once at startup instead.
		const unknownWeightKeys = Object.keys(cfg.ranking.sourceWeights).filter(
			(k) => !(VALID_SOURCES as string[]).includes(k),
		);
		if (unknownWeightKeys.length > 0) {
			log.diag(
				`ranking.sourceWeights keys not in the known source list (typo? they weight nothing): ${unknownWeightKeys.join(", ")}`,
			);
		}

		const client = new HyperspellClient(cfg);

		// Channel quarantine (cfg.excludeChannels): excluded conversations get no
		// memory surface in either direction. Guard the shared choke points here —
		// the injection hook (all injection), agent_end (all writes), and the tool
		// factories — so individual hooks stay quarantine-unaware.
		const quarantined = (ctx?: Record<string, unknown>): boolean => {
			if (!isExcludedChannel(ctx, cfg)) return false;
			log.debug("channel quarantined — skipping memory surface");
			return true;
		};
		const unlessQuarantined =
			<E, R>(handler: (event: E, ctx?: Record<string, unknown>) => R) =>
			(event: E, ctx?: Record<string, unknown>): R | undefined =>
				quarantined(ctx) ? undefined : handler(event, ctx);
		const toolUnlessQuarantined =
			<T>(factory: (ctx: Record<string, unknown>) => T) =>
			(ctx: Record<string, unknown>): T | null =>
				quarantined(ctx) ? null : factory(ctx);

		// Register AI tools (factory pattern for sender context)
		api.registerTool(toolUnlessQuarantined(createSearchToolFactory(client, cfg)), {
			name: "hyperspell_search",
		});
		api.registerTool(toolUnlessQuarantined(createRememberToolFactory(client, cfg)), {
			name: "hyperspell_remember",
		});

		// Session-start context injectors (emotional fetch, auto-context,
		// startup-orientation) all run on the injection hook. The host awaits
		// same-name hooks SEQUENTIALLY, so registering them separately
		// stacked their backend searches — making the first message of a session
		// roughly 2x slower than necessary. Instead we collect them and run them
		// in PARALLEL under a single hook, merging prependContext in registration
		// order (so injection layout is unchanged). Their non-start lifecycle
		// hooks (compaction/session_end/agent_end) stay registered separately.
		type StartHandler = (
			event: Record<string, unknown>,
			ctx?: Record<string, unknown>,
		) =>
			| Promise<{ prependContext?: string } | undefined>
			| { prependContext?: string }
			| undefined;
		const startHandlers: StartHandler[] = [];

		if (cfg.emotionalContext) {
			// moodWeatherChance defaults to 0, so mood weather is inert unless the
			// operator opts in — say so once at startup rather than staying silent.
			if (cfg.moodWeatherChance === 0) {
				log.info(
					"emotionalContext is on but moodWeatherChance is 0 — mood weather will never roll. Set moodWeatherChance (e.g. 0.03–0.05) to enable it.",
				);
			}
			// On-demand arc re-fetch (issue #76): the session-start injection can be
			// compacted out of history mid-session; this tool lets the agent pull the
			// exact same block back without waiting for the next prompt build.
			api.registerTool(
				toolUnlessQuarantined(createEmotionalArcToolFactory(client, cfg)),
				{ name: "hyperspell_emotional_arc" },
			);
			startHandlers.push(
				buildEmotionalStateFetchHandler(client, cfg) as StartHandler,
			);
			api.on("after_compaction", buildEmotionalStateCompactionHandler());
			api.on("session_end", buildEmotionalStateSessionCleanupHandler());
			api.on(
				"agent_end",
				unlessQuarantined(buildEmotionalStateStoreHandler(client, cfg)),
			);
		}

		if (cfg.autoContext) {
			startHandlers.push(buildAutoContextHandler(client, cfg) as StartHandler);
		}

		if (cfg.startupOrientation.enabled) {
			// recent-interactions reads conversation sessions from the hot buffer
			// when it's on, else falls back to auto-trace's agent_end traces. With
			// BOTH off there's no source to read — warn so the operator knows the
			// block will be empty rather than wondering why there's no continuity.
			if (!cfg.hotBuffer.enabled && !cfg.autoTrace.enabled) {
				log.warn(
					"startup-orientation is enabled but neither hotBuffer nor autoTrace is on — recent-interactions will be empty (no conversation source to read).",
				);
			}
			startHandlers.push(
				buildStartupOrientationHandler(client, cfg) as StartHandler,
			);
			api.on("after_compaction", buildStartupOrientationCompactionHandler());
			api.on("session_end", buildStartupOrientationSessionCleanupHandler());
		}

		// Injection hook selection: OpenClaw 2026.7.2 removed the plugin-facing
		// `before_agent_start`; its replacement `agent_turn_prepare` shipped in the
		// same core commit as `enqueueNextTurnInjection` (openclaw#72287, 2026-04),
		// so probing that api member tells us exactly which hook this host knows.
		// Register exactly ONE of the two: cores between 2026-04 and 2026-07
		// accept both and would double-inject. Both hooks share the same
		// { prependContext } result contract and provide event.prompt.
		const injectionHook =
			typeof (api as { enqueueNextTurnInjection?: unknown })
				.enqueueNextTurnInjection === "function"
				? "agent_turn_prepare"
				: "before_agent_start";

		if (startHandlers.length > 0) {
			api.on(injectionHook, async (event, ctx) => {
				// Quarantined channels get no injected memory of any kind.
				if (quarantined(ctx as Record<string, unknown> | undefined)) return undefined;
				const results = await Promise.all(
					startHandlers.map((h) =>
						Promise.resolve()
							.then(() => h(event, ctx))
							.catch((err) => {
								// One injector failing must not break the others or the turn.
								log.error("session-start handler failed", err);
								return undefined;
							}),
					),
				);
				const parts = results
					.map((r) => r?.prependContext)
					.filter((p): p is string => typeof p === "string" && p.length > 0);
				return parts.length > 0
					? { prependContext: parts.join("\n\n") }
					: undefined;
			});
		}

		// Register auto-trace hook (send conversations to Hyperspell on session end)
		if (cfg.autoTrace.enabled) {
			api.on(
				"agent_end",
				unlessQuarantined(buildAutoTraceHandler(client, cfg)),
			);
		}

		// Register hot-buffer hook: write each turn to POST /messages so it's
		// instantly full-text searchable (vs. the slow /memories embedding path).
		if (cfg.hotBuffer.enabled) {
			api.on(
				"agent_end",
				unlessQuarantined(buildHotBufferHandler(client, cfg)),
			);
			api.on("session_end", buildHotBufferSessionCleanupHandler());
		}

		// Memory sync live watcher. Plugin-owned on every host version:
		// 2026.7.2 removed the host `file_changed` hook, and on older hosts
		// registering both paths would double-sync each edit. Started/stopped
		// by the lifecycle service below.
		let memorySyncWatcher: { start: () => void; stop: () => void } | undefined;
		if (cfg.syncMemories) {
			const fileSyncHandler = buildFileSyncHandler(client, cfg);
			memorySyncWatcher = buildMemorySyncWatcher(cfg, (event) => {
				void fileSyncHandler(event);
			});
			api.logger.info(
				`hyperspell: memory sync enabled (sectionize=${cfg.syncMemoriesConfig.sectionize}, watchPaths=${cfg.syncMemoriesConfig.watchPaths.length})`,
			);
		}

		// Register memory network tools
		if (cfg.knowledgeGraph.enabled) {
			registerNetworkTools(api, client, cfg);
		} else {
			// Discoverability (issue #81): the Memory Network ships fully built but
			// default-off. If memories are accumulating (hot buffer / auto-trace /
			// emotional state) and the operator never made a knowledgeGraph decision,
			// say so once at startup — otherwise the feature is undetectable without
			// reading source. Keyed off the RAW config: an explicit `knowledgeGraph`
			// key (even { enabled: false }) is a decision and suppresses this.
			const memoryAccumulating =
				cfg.hotBuffer.enabled || cfg.autoTrace.enabled || cfg.emotionalContext;
			if (rawConfig?.knowledgeGraph === undefined && memoryAccumulating) {
				log.info(
					"memories are accumulating but the Memory Network (knowledgeGraph) is not configured — " +
						"no entity extraction into memory/people|projects|organizations|topics will run. " +
						"Enable it via 'openclaw openclaw-hyperspell setup' (Memory Network step) or set " +
						"knowledgeGraph.enabled: true, or silence this note with knowledgeGraph: { enabled: false }. " +
						"See README § Memory Network.",
				);
			}
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
				memorySyncWatcher?.start();
			},
			stop: () => {
				memorySyncWatcher?.stop();
				api.logger.info("hyperspell: stopped");
			},
		});
	},
};
