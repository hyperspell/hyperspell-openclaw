import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_ELBOW,
	DEFAULT_RANKING,
	type ElbowOptions,
	type RankingWeights,
} from "./lib/ranking.ts";

export type HyperspellSource =
	| "reddit"
	| "notion"
	| "slack"
	| "google_calendar"
	| "google_mail"
	| "box"
	| "google_drive"
	| "vault"
	| "web_crawler"
	| "dropbox"
	| "github"
	| "trace"
	| "microsoft_teams";

export type KnowledgeGraphConfig = {
	enabled: boolean;
	scanIntervalMinutes: number;
	batchSize: number;
};

export type AutoTraceConfig = {
	enabled: boolean;
	extract: Array<"procedure" | "memory" | "mood">;
	metadata?: Record<string, string | number | boolean>;
};

/**
 * Real-time hot buffer (`POST /messages`). When enabled, each completed agent
 * turn is written to Hyperspell's transient message buffer, which is full-text
 * searchable in the same transaction (no embedding wait) and auto-consolidated
 * server-side into normal vault Resources. This is a different, faster entry
 * point than `autoTrace` (which targets the slow `/memories` embedding path).
 *
 * Requires a resolvable `userId` — `POST /messages` mandates the `X-As-User`
 * header and returns 422 without it.
 */
export type HotBufferConfig = {
	enabled: boolean;
	/** DocumentProviders enum value for the rows. "vault" = our own turns. */
	source: HyperspellSource;
	/** Write the user side of each turn. */
	writeUser: boolean;
	/** Write the assistant side of each turn. */
	writeAssistant: boolean;
};

export type StartupOrientationConfig = {
	enabled: boolean;
	recentDays: number;
	recentLimit: number;
	loopsLimit: number;
	loopsQuery: string;
};

export type UserProfile = {
	userId: string;
	name: string;
	context?: string;
	role?: string;
};

export type ScopeName = string;
export type CanReadScope = ScopeName | "*" | "self";

export type Role = {
	canRead: CanReadScope[];
	defaultWriteScope: ScopeName;
	canWriteScopes?: ScopeName[];
};

export type VoiceIdConfig = {
	enabled: boolean;
	adapter?: string;
	confidenceThreshold?: number;
};

export type ScopingConfig = {
	enabled: boolean;
	defaultScope: ScopeName;
	scopes: ScopeName[];
	roles: Record<string, Role>;
	users: Record<string, { role: string }>;
	collections?: Record<ScopeName, string>;
	voiceId?: VoiceIdConfig;
};

export type MultiUserConfig = {
	senderMap: Record<string, UserProfile>;
	sharedUserId: string;
	includeSharedInSearch: boolean;
	scoping?: ScopingConfig;
};

/**
 * Convert user-facing scope names (which may contain hyphens) to SDK-safe
 * metadata values (alphanumeric + underscore only). Must be applied at every
 * boundary where scopes cross into Hyperspell metadata — writes and reads —
 * or filters will silently miss.
 */
export function normalizeScope(scope: ScopeName): string {
	return scope.replace(/[^a-zA-Z0-9_]/g, "_");
}

export type WatchPathEntry = {
	/** Relative to workspace root, or absolute. */
	path: string;
	/**
	 * Provenance label stamped as `openclaw_sync_source` metadata on every
	 * memory synced from under this path. Defaults to a slug of `path`
	 * (e.g. "notes/brainstem" -> "notes_brainstem").
	 */
	source?: string;
};

export type SyncMemoriesConfig = {
	enabled: boolean;
	/** Split files by ## headings into separate memories (default: true) */
	sectionize: boolean;
	/** Additional paths to watch beyond memory/ (relative to workspace or absolute) */
	watchPaths: WatchPathEntry[];
	/** Debounce file changes in ms to avoid syncing mid-write (default: 2000) */
	debounceMs: number;
	/**
	 * Startup bulk sync skips files whose mtime is older than this many days
	 * AND that are already recorded in the sync manifest (i.e. ingested at
	 * least once). Bounds steady-state re-ingest load on large/old corpora.
	 * 0 disables the cutoff (always consider every file). Default: 30.
	 */
	maxAgeDays: number;
	/**
	 * Directory names (not paths) skipped when walking memory/ for syncable
	 * files. Dot-directories (e.g. `.dreams`) are ALWAYS skipped regardless of
	 * this list. Default: `["dreaming"]` — the dreaming engine writes
	 * first-person dream journals under memory/dreaming/ that would otherwise
	 * be ingested as user memories and pollute retrieval. Set `[]` to sync
	 * everything except dot-directories.
	 */
	ignorePaths: string[];
};

export type HyperspellConfig = {
	apiKey: string;
	userId?: string;
	autoContext: boolean;
	autoTrace: AutoTraceConfig;
	hotBuffer: HotBufferConfig;
	emotionalContext: boolean;
	/**
	 * Probability (0..1) that a fresh session rolls exogenous "mood weather" — an
	 * uncaused, unannounced mood that overrides the arc's tone for that session
	 * only (never written back to the register). 0 disables. Keep it rare
	 * (~0.05–0.10) so it reads as weather, not a gimmick. Requires emotionalContext.
	 * Once weather lands, a cross-session cooldown (~6h) suppresses new rolls so
	 * a cluster of same-day sessions shares one weather.
	 */
	moodWeatherChance: number;
	/**
	 * Conversation/channel ids that are fully quarantined from memory: no
	 * context injection, no memory writes (hot buffer, auto-trace, emotional
	 * state), and no memory tools in those sessions. Matched against the
	 * session's resolved conversation id (e.g. a Discord channel id); threads
	 * inside an excluded channel inherit the quarantine. Default: [].
	 * Forward-only: content synced before a channel is quarantined stays in
	 * Hyperspell; use the purge-channel CLI command to remove tagged content.
	 */
	excludeChannels: string[];
	relationshipId?: string;
	startupOrientation: StartupOrientationConfig;
	syncMemories: boolean;
	syncMemoriesConfig: SyncMemoriesConfig;
	sources: HyperspellSource[];
	maxResults: number;
	relevanceThreshold: number;
	ranking: RankingWeights;
	debug: boolean;
	knowledgeGraph: KnowledgeGraphConfig;
	multiUser?: MultiUserConfig;
};

const ALLOWED_KEYS = [
	"apiKey",
	"userId",
	"autoContext",
	"autoTrace",
	"hotBuffer",
	"emotionalContext",
	"moodWeatherChance",
	"excludeChannels",
	"relationshipId",
	"startupOrientation",
	"syncMemories",
	"sources",
	"maxResults",
	"relevanceThreshold",
	"ranking",
	"debug",
	"knowledgeGraph",
	"multiUser",
	"dreaming",
];

export const VALID_SOURCES: HyperspellSource[] = [
	"reddit",
	"notion",
	"slack",
	"google_calendar",
	"google_mail",
	"box",
	"google_drive",
	"vault",
	"web_crawler",
	"dropbox",
	"github",
	"trace",
	"microsoft_teams",
];

function assertAllowedKeys(
	value: Record<string, unknown>,
	allowed: string[],
	label: string,
): void {
	const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
	if (unknown.length > 0) {
		throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
	}
}

function resolveEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
		const envValue = process.env[envVar];
		if (!envValue) {
			throw new Error(`Environment variable ${envVar} is not set`);
		}
		return envValue;
	});
}

/**
 * Normalize `syncMemories.watchPaths` entries: the shipped/documented string
 * form stays valid and is additive-upgraded to `{ path }`; the object form
 * carries an optional provenance `source` label. Labels are sanitized with the
 * same character rule as normalizeScope — metadata values must be alphanumeric
 * + underscore or Hyperspell metadata filters silently miss.
 */
function parseWatchPaths(raw: unknown): WatchPathEntry[] {
	if (!Array.isArray(raw)) return [];
	return (raw as unknown[]).map((wp) => {
		if (typeof wp === "string") {
			if (!wp.trim()) {
				throw new Error(
					"hyperspell.syncMemories.watchPaths[] entry needs a non-empty path",
				);
			}
			return { path: wp };
		}
		if (typeof wp !== "object" || wp === null || Array.isArray(wp)) {
			throw new Error(
				"hyperspell.syncMemories.watchPaths[] entries must be a string or { path, source? }",
			);
		}
		const entry = wp as Record<string, unknown>;
		assertAllowedKeys(
			entry,
			["path", "source"],
			"hyperspell.syncMemories.watchPaths[]",
		);
		if (typeof entry.path !== "string" || !entry.path.trim()) {
			throw new Error(
				"hyperspell.syncMemories.watchPaths[] entry needs a non-empty path",
			);
		}
		if (!entry.source) return { path: entry.path };
		return {
			path: entry.path,
			source: String(entry.source).replace(/[^a-zA-Z0-9_]/g, "_"),
		};
	});
}

/** Per-source multipliers: non-numeric values silently skip (num()'s
 * convention); explicit non-positive values throw (a 0 weight is a filtering
 * decision wearing a weighting costume — the sources filter is the right
 * tool, and the error says so). Keys lowercase but are NOT validated against
 * VALID_SOURCES: the backend adds sources independently of plugin releases,
 * and an unmatched key is a harmless neutral no-op (startup diag logs it). */
function parseSourceWeights(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v !== "number") continue;
		if (!Number.isFinite(v) || v <= 0) {
			throw new Error(
				`ranking.sourceWeights.${k} must be a positive number (got ${v}); ` +
					`to exclude a source entirely, use the "sources" filter instead`,
			);
		}
		out[k.trim().toLowerCase()] = v;
	}
	return out;
}

function parseRanking(raw: unknown): RankingWeights {
	const r = (raw ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
	return {
		enabled: (r.enabled as boolean) ?? DEFAULT_RANKING.enabled,
		curationBoost: num(r.curationBoost, DEFAULT_RANKING.curationBoost),
		chatterPenalty: num(r.chatterPenalty, DEFAULT_RANKING.chatterPenalty),
		storyBoost: num(r.storyBoost, DEFAULT_RANKING.storyBoost),
		// Trim + lowercase + dedupe, drop whitespace-only entries. Before this a
		// stray " " entry passed the length filter and (under the old substring
		// matcher) classified EVERY result as story, silently disabling the
		// chatter penalty and quota (issue #82's footgun).
		storyTerms: Array.isArray(r.storyTerms)
			? [
					...new Set(
						(r.storyTerms as unknown[])
							.map((t) => String(t).trim().toLowerCase())
							.filter((t) => t.length > 0),
					),
				]
			: DEFAULT_RANKING.storyTerms,
		candidateMultiplier: Math.max(
			1,
			num(r.candidateMultiplier, DEFAULT_RANKING.candidateMultiplier),
		),
		chatterQuota: Math.max(0, num(r.chatterQuota, DEFAULT_RANKING.chatterQuota)),
		recencyHalfLifeDays: Math.max(
			0,
			num(r.recencyHalfLifeDays, DEFAULT_RANKING.recencyHalfLifeDays),
		),
		recencyMaxPenalty: Math.max(
			0,
			num(r.recencyMaxPenalty, DEFAULT_RANKING.recencyMaxPenalty),
		),
		recencyCuratedFactor: Math.min(
			1,
			Math.max(
				0,
				num(r.recencyCuratedFactor, DEFAULT_RANKING.recencyCuratedFactor),
			),
		),
		sourceWeights: parseSourceWeights(r.sourceWeights),
		dedupThreshold: Math.min(
			1,
			Math.max(0, num(r.dedupThreshold, DEFAULT_RANKING.dedupThreshold)),
		),
		elbow: parseElbow(r.elbow),
	};
}

function parseElbow(raw: unknown): ElbowOptions {
	const e = (raw ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
	return {
		enabled: (e.enabled as boolean) ?? DEFAULT_ELBOW.enabled,
		// >= 2: at least one gap must exist before meanGap is defined (the
		// first accepted result never records a gap).
		minResults: Math.max(2, num(e.minResults, DEFAULT_ELBOW.minResults)),
		gapRatio: Math.max(1, num(e.gapRatio, DEFAULT_ELBOW.gapRatio)),
		minGap: Math.max(0, num(e.minGap, DEFAULT_ELBOW.minGap)),
	};
}

function parseSources(raw: string | string[] | undefined): HyperspellSource[] {
	if (!raw) {
		return [];
	}

	// Handle array input
	if (Array.isArray(raw)) {
		const sources = raw
			.map((s) => String(s).trim().toLowerCase())
			.filter((s) => s.length > 0) as HyperspellSource[];

		for (const source of sources) {
			if (!VALID_SOURCES.includes(source)) {
				throw new Error(
					`Invalid source "${source}". Valid sources: ${VALID_SOURCES.join(", ")}`,
				);
			}
		}

		return sources;
	}

	// Handle string input (comma-separated)
	if (typeof raw === "string" && raw.trim() === "") {
		return [];
	}

	const sources = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0) as HyperspellSource[];

	for (const source of sources) {
		if (!VALID_SOURCES.includes(source)) {
			throw new Error(
				`Invalid source "${source}". Valid sources: ${VALID_SOURCES.join(", ")}`,
			);
		}
	}

	return sources;
}

function parseScoping(raw: unknown): ScopingConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const sc = raw as Record<string, unknown>;

	if (sc.enabled !== true) return undefined;

	const scopes = Array.isArray(sc.scopes)
		? (sc.scopes.filter((s) => typeof s === "string") as ScopeName[])
		: [];
	if (scopes.length === 0) {
		throw new Error("scoping.scopes must be a non-empty array of scope names");
	}

	const defaultScope =
		typeof sc.defaultScope === "string" ? sc.defaultScope : "private";
	if (!scopes.includes(defaultScope)) {
		throw new Error(
			`scoping.defaultScope "${defaultScope}" must be one of scopes: ${scopes.join(", ")}`,
		);
	}

	const rolesRaw =
		sc.roles && typeof sc.roles === "object"
			? (sc.roles as Record<string, unknown>)
			: {};
	const roles: Record<string, Role> = {};
	for (const [roleName, rRaw] of Object.entries(rolesRaw)) {
		if (!rRaw || typeof rRaw !== "object") continue;
		const r = rRaw as Record<string, unknown>;

		const canRead = Array.isArray(r.canRead)
			? (r.canRead.filter((s) => typeof s === "string") as CanReadScope[])
			: [];
		for (const s of canRead) {
			if (s === "*" || s === "self") continue;
			if (!scopes.includes(s)) {
				throw new Error(
					`scoping.roles.${roleName}.canRead contains unknown scope "${s}"`,
				);
			}
		}

		const defaultWriteScope =
			typeof r.defaultWriteScope === "string"
				? r.defaultWriteScope
				: defaultScope;
		if (!scopes.includes(defaultWriteScope)) {
			throw new Error(
				`scoping.roles.${roleName}.defaultWriteScope "${defaultWriteScope}" must be one of scopes: ${scopes.join(", ")}`,
			);
		}

		let canWriteScopes: ScopeName[] | undefined;
		if (Array.isArray(r.canWriteScopes)) {
			canWriteScopes = r.canWriteScopes.filter(
				(s): s is ScopeName => typeof s === "string",
			);
			for (const s of canWriteScopes) {
				if (!scopes.includes(s)) {
					throw new Error(
						`scoping.roles.${roleName}.canWriteScopes contains unknown scope "${s}"`,
					);
				}
			}
		}

		roles[roleName] = { canRead, defaultWriteScope, canWriteScopes };
	}

	const usersRaw =
		sc.users && typeof sc.users === "object"
			? (sc.users as Record<string, unknown>)
			: {};
	const users: Record<string, { role: string }> = {};
	for (const [uid, uRaw] of Object.entries(usersRaw)) {
		if (!uRaw || typeof uRaw !== "object") continue;
		const u = uRaw as Record<string, unknown>;
		if (typeof u.role !== "string") continue;
		if (!roles[u.role]) {
			throw new Error(
				`scoping.users.${uid}.role "${u.role}" does not key into scoping.roles`,
			);
		}
		users[uid] = { role: u.role };
	}

	const collectionsRaw =
		sc.collections && typeof sc.collections === "object"
			? (sc.collections as Record<string, unknown>)
			: undefined;
	let collections: Record<ScopeName, string> | undefined;
	if (collectionsRaw) {
		collections = {};
		for (const [scopeName, coll] of Object.entries(collectionsRaw)) {
			if (typeof coll === "string" && scopes.includes(scopeName)) {
				collections[scopeName] = coll;
			}
		}
	}

	let voiceId: VoiceIdConfig | undefined;
	if (sc.voiceId && typeof sc.voiceId === "object") {
		const v = sc.voiceId as Record<string, unknown>;
		voiceId = {
			enabled: v.enabled === true,
			adapter: typeof v.adapter === "string" ? v.adapter : undefined,
			confidenceThreshold:
				typeof v.confidenceThreshold === "number"
					? v.confidenceThreshold
					: undefined,
		};
	}

	return {
		enabled: true,
		defaultScope,
		scopes,
		roles,
		users,
		collections,
		voiceId,
	};
}

function parseMultiUser(raw: unknown): MultiUserConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const mu = raw as Record<string, unknown>;

	const senderMap: Record<string, UserProfile> = {};
	const rawMap = mu.senderMap as Record<string, unknown> | undefined;
	if (rawMap && typeof rawMap === "object") {
		for (const [handle, profile] of Object.entries(rawMap)) {
			if (profile && typeof profile === "object") {
				const p = profile as Record<string, unknown>;
				if (typeof p.userId === "string" && typeof p.name === "string") {
					senderMap[handle] = {
						userId: p.userId,
						name: p.name,
						context: typeof p.context === "string" ? p.context : undefined,
						role: typeof p.role === "string" ? p.role : undefined,
					};
				}
			}
		}
	}

	if (Object.keys(senderMap).length === 0) return undefined;

	return {
		senderMap,
		sharedUserId:
			typeof mu.sharedUserId === "string" ? mu.sharedUserId : "shared",
		includeSharedInSearch:
			typeof mu.includeSharedInSearch === "boolean"
				? mu.includeSharedInSearch
				: true,
		scoping: parseScoping(mu.scoping),
	};
}

export function parseConfig(raw: unknown): HyperspellConfig {
	const cfg =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};

	if (Object.keys(cfg).length > 0) {
		assertAllowedKeys(cfg, ALLOWED_KEYS, "hyperspell config");
	}

	const apiKey =
		typeof cfg.apiKey === "string" && cfg.apiKey.length > 0
			? resolveEnvVars(cfg.apiKey)
			: process.env.HYPERSPELL_API_KEY;

	if (!apiKey) {
		throw new Error(
			"hyperspell: apiKey is required (set in plugin config or HYPERSPELL_API_KEY env var)",
		);
	}

	const kgRaw = (cfg.knowledgeGraph ?? {}) as Record<string, unknown>;
	const atRaw = (cfg.autoTrace ?? {}) as Record<string, unknown>;
	const soRaw = (cfg.startupOrientation ?? {}) as Record<string, unknown>;

	const hbRaw = (cfg.hotBuffer ?? {}) as Record<string, unknown>;
	if (cfg.hotBuffer && typeof cfg.hotBuffer === "object" && !Array.isArray(cfg.hotBuffer)) {
		assertAllowedKeys(
			hbRaw,
			["enabled", "source", "writeUser", "writeAssistant"],
			"hyperspell.hotBuffer",
		);
	}
	const hbSource = parseSources(hbRaw.source as string | undefined)[0] ?? "vault";

	// syncMemories can be a boolean (legacy) or an object (new)
	const smRaw = cfg.syncMemories;
	const syncMemoriesEnabled =
		typeof smRaw === "boolean"
			? smRaw
			: typeof smRaw === "object" && smRaw !== null
				? ((smRaw as Record<string, unknown>).enabled as boolean) ?? true
				: false;
	const smObj =
		typeof smRaw === "object" && smRaw !== null
			? (smRaw as Record<string, unknown>)
			: {};

	// The rest of parseConfig is strict about unknown keys; the syncMemories
	// object form must be too, or a typo (sectionise/debounceMS) is silently
	// ignored and the user gets default behavior they didn't ask for.
	if (typeof smRaw === "object" && smRaw !== null && !Array.isArray(smRaw)) {
		assertAllowedKeys(
			smObj,
			[
				"enabled",
				"sectionize",
				"watchPaths",
				"debounceMs",
				"maxAgeDays",
				"ignorePaths",
			],
			"hyperspell.syncMemories",
		);
	}

	return {
		apiKey,
		userId: cfg.userId as string | undefined,
		autoContext: (cfg.autoContext as boolean) ?? true,
		autoTrace: {
			enabled: (atRaw.enabled as boolean) ?? false,
			extract: (atRaw.extract as Array<"procedure" | "memory" | "mood">) ?? [
				"procedure",
			],
			metadata: atRaw.metadata as
				| Record<string, string | number | boolean>
				| undefined,
		},
		hotBuffer: {
			// Default OFF so shipping the plugin never changes existing installs'
			// behavior; opt in per-install via plugin config.
			enabled: (hbRaw.enabled as boolean) ?? false,
			source: hbSource,
			writeUser: (hbRaw.writeUser as boolean) ?? true,
			writeAssistant: (hbRaw.writeAssistant as boolean) ?? true,
		},
		emotionalContext: (cfg.emotionalContext as boolean) ?? false,
		// Default 0 (off) so shipping never changes existing installs' behavior.
		// Clamped to [0,1] so a stray config value can't make every session roll.
		moodWeatherChance: Math.min(
			1,
			Math.max(0, (cfg.moodWeatherChance as number) ?? 0),
		),
		excludeChannels: Array.isArray(cfg.excludeChannels)
			? (cfg.excludeChannels as unknown[])
					.map((c) => String(c).trim())
					.filter((c) => c.length > 0)
			: [],
		relationshipId: cfg.relationshipId as string | undefined,
		startupOrientation: {
			enabled: (soRaw.enabled as boolean) ?? false,
			recentDays: (soRaw.recentDays as number) ?? 7,
			recentLimit: (soRaw.recentLimit as number) ?? 5,
			loopsLimit: (soRaw.loopsLimit as number) ?? 3,
			loopsQuery:
				(soRaw.loopsQuery as string) ??
				"open tasks pending questions unfinished promised need to follow up",
		},
		syncMemories: syncMemoriesEnabled,
		syncMemoriesConfig: {
			enabled: syncMemoriesEnabled,
			sectionize: (smObj.sectionize as boolean) ?? true,
			watchPaths: parseWatchPaths(smObj.watchPaths),
			debounceMs: (smObj.debounceMs as number) ?? 2000,
			maxAgeDays: (smObj.maxAgeDays as number) ?? 30,
			ignorePaths: Array.isArray(smObj.ignorePaths)
				? (smObj.ignorePaths as string[])
				: ["dreaming"],
		},
		sources: parseSources(cfg.sources as string | string[] | undefined),
		maxResults: (cfg.maxResults as number) ?? 10,
		relevanceThreshold: (cfg.relevanceThreshold as number) ?? 0.6,
		ranking: parseRanking(cfg.ranking),
		debug: (cfg.debug as boolean) ?? false,
		knowledgeGraph: {
			enabled: (kgRaw.enabled as boolean) ?? false,
			scanIntervalMinutes: (kgRaw.scanIntervalMinutes as number) ?? 60,
			batchSize: (kgRaw.batchSize as number) ?? 20,
		},
		multiUser: parseMultiUser(cfg.multiUser),
	};
}

export const hyperspellConfigSchema = {
	parse: parseConfig,
};

/**
 * Resolve OpenClaw state directory (matches OpenClaw's own logic).
 */
export function resolveStateDir(): string {
	const override =
		process.env.OPENCLAW_STATE_DIR?.trim() ||
		process.env.CLAWDBOT_STATE_DIR?.trim();
	if (override) {
		return override.startsWith("~")
			? override.replace(/^~(?=$|[\\/])/, os.homedir())
			: path.resolve(override);
	}
	return path.join(os.homedir(), ".openclaw");
}

/**
 * Resolve OpenClaw config file path (matches OpenClaw's own logic).
 */
export function resolveConfigPath(): string {
	const override =
		process.env.OPENCLAW_CONFIG_PATH?.trim() ||
		process.env.CLAWDBOT_CONFIG_PATH?.trim();
	if (override) {
		return override.startsWith("~")
			? override.replace(/^~(?=$|[\\/])/, os.homedir())
			: path.resolve(override);
	}
	return path.join(resolveStateDir(), "openclaw.json");
}

/**
 * Get the workspace directory from OpenClaw config
 */
export function getWorkspaceDir(): string {
	// Resolve config path
	const override =
		process.env.OPENCLAW_CONFIG_PATH?.trim() ||
		process.env.CLAWDBOT_CONFIG_PATH?.trim();
	let configPath: string;
	if (override) {
		configPath = override.startsWith("~")
			? override.replace(/^~(?=$|[\\/])/, os.homedir())
			: path.resolve(override);
	} else {
		const stateDir =
			process.env.OPENCLAW_STATE_DIR?.trim() ||
			process.env.CLAWDBOT_STATE_DIR?.trim();
		const resolvedStateDir = stateDir
			? stateDir.startsWith("~")
				? stateDir.replace(/^~(?=$|[\\/])/, os.homedir())
				: path.resolve(stateDir)
			: path.join(os.homedir(), ".openclaw");
		configPath = path.join(resolvedStateDir, "openclaw.json");
	}

	// Read workspace from config
	if (fs.existsSync(configPath)) {
		try {
			const content = fs.readFileSync(configPath, "utf-8");
			const config = JSON.parse(content);
			const workspace = config?.agents?.defaults?.workspace;
			if (workspace) {
				return workspace.startsWith("~")
					? workspace.replace(/^~(?=$|[\\/])/, os.homedir())
					: workspace;
			}
		} catch (_e) {
			// Fall back to default
		}
	}

	// Default workspace
	const stateDir =
		process.env.OPENCLAW_STATE_DIR?.trim() ||
		process.env.CLAWDBOT_STATE_DIR?.trim();
	const resolvedStateDir = stateDir
		? stateDir.startsWith("~")
			? stateDir.replace(/^~(?=$|[\\/])/, os.homedir())
			: path.resolve(stateDir)
		: path.join(os.homedir(), ".openclaw");
	return path.join(resolvedStateDir, "workspace");
}
