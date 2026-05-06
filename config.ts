import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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

export type StartupOrientationConfig = {
	enabled: boolean;
	recentDays: number;
	recentLimit: number;
	loopsLimit: number;
	recentQuery: string;
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

export type HyperspellConfig = {
	apiKey: string;
	userId?: string;
	autoContext: boolean;
	autoTrace: AutoTraceConfig;
	emotionalContext: boolean;
	relationshipId?: string;
	startupOrientation: StartupOrientationConfig;
	syncMemories: boolean;
	sources: HyperspellSource[];
	maxResults: number;
	relevanceThreshold: number;
	debug: boolean;
	knowledgeGraph: KnowledgeGraphConfig;
	multiUser?: MultiUserConfig;
};

const ALLOWED_KEYS = [
	"apiKey",
	"userId",
	"autoContext",
	"autoTrace",
	"emotionalContext",
	"relationshipId",
	"startupOrientation",
	"syncMemories",
	"sources",
	"maxResults",
	"relevanceThreshold",
	"debug",
	"knowledgeGraph",
	"multiUser",
	"dreaming",
];

const VALID_SOURCES: HyperspellSource[] = [
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
		emotionalContext: (cfg.emotionalContext as boolean) ?? false,
		relationshipId: cfg.relationshipId as string | undefined,
		startupOrientation: {
			enabled: (soRaw.enabled as boolean) ?? false,
			recentDays: (soRaw.recentDays as number) ?? 7,
			recentLimit: (soRaw.recentLimit as number) ?? 5,
			loopsLimit: (soRaw.loopsLimit as number) ?? 3,
			recentQuery:
				(soRaw.recentQuery as string) ?? "conversation session interaction",
			loopsQuery:
				(soRaw.loopsQuery as string) ??
				"open tasks pending questions unfinished promised need to follow up",
		},
		syncMemories: (cfg.syncMemories as boolean) ?? false,
		sources: parseSources(cfg.sources as string | string[] | undefined),
		maxResults: (cfg.maxResults as number) ?? 10,
		relevanceThreshold: (cfg.relevanceThreshold as number) ?? 0.6,
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
