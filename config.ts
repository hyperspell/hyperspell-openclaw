export type HyperspellSource =
  | "collections"
  | "reddit"
  | "notion"
  | "slack"
  | "google_calendar"
  | "google_mail"
  | "box"
  | "google_drive"
  | "vault"
  | "web_crawler"

export type KnowledgeGraphConfig = {
  enabled: boolean
  scanIntervalMinutes: number
  batchSize: number
}

export type HyperspellConfig = {
  apiKey: string
  userId?: string
  autoContext: boolean
  emotionalContext: boolean
  relationshipId?: string
  syncMemories: boolean
  sources: HyperspellSource[]
  maxResults: number
  debug: boolean
  knowledgeGraph: KnowledgeGraphConfig
}

const ALLOWED_KEYS = [
  "apiKey",
  "userId",
  "autoContext",
  "emotionalContext",
  "relationshipId",
  "syncMemories",
  "sources",
  "maxResults",
  "debug",
  "knowledgeGraph",
]

const VALID_SOURCES: HyperspellSource[] = [
  "collections",
  "reddit",
  "notion",
  "slack",
  "google_calendar",
  "google_mail",
  "box",
  "google_drive",
  "vault",
  "web_crawler",
]

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`)
  }
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar]
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`)
    }
    return envValue
  })
}

function parseSources(raw: string | string[] | undefined): HyperspellSource[] {
  if (!raw) {
    return []
  }

  // Handle array input
  if (Array.isArray(raw)) {
    const sources = raw
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => s.length > 0) as HyperspellSource[]

    for (const source of sources) {
      if (!VALID_SOURCES.includes(source)) {
        throw new Error(
          `Invalid source "${source}". Valid sources: ${VALID_SOURCES.join(", ")}`,
        )
      }
    }

    return sources
  }

  // Handle string input (comma-separated)
  if (typeof raw === "string" && raw.trim() === "") {
    return []
  }

  const sources = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0) as HyperspellSource[]

  for (const source of sources) {
    if (!VALID_SOURCES.includes(source)) {
      throw new Error(
        `Invalid source "${source}". Valid sources: ${VALID_SOURCES.join(", ")}`,
      )
    }
  }

  return sources
}

export function parseConfig(raw: unknown): HyperspellConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  if (Object.keys(cfg).length > 0) {
    assertAllowedKeys(cfg, ALLOWED_KEYS, "hyperspell config")
  }

  const apiKey =
    typeof cfg.apiKey === "string" && cfg.apiKey.length > 0
      ? resolveEnvVars(cfg.apiKey)
      : process.env.HYPERSPELL_API_KEY

  if (!apiKey) {
    throw new Error(
      "hyperspell: apiKey is required (set in plugin config or HYPERSPELL_API_KEY env var)",
    )
  }

  const kgRaw = (cfg.knowledgeGraph ?? {}) as Record<string, unknown>

  return {
    apiKey,
    userId: cfg.userId as string | undefined,
    autoContext: (cfg.autoContext as boolean) ?? true,
    emotionalContext: (cfg.emotionalContext as boolean) ?? false,
    relationshipId: cfg.relationshipId as string | undefined,
    syncMemories: (cfg.syncMemories as boolean) ?? false,
    sources: parseSources(cfg.sources as string | string[] | undefined),
    maxResults: (cfg.maxResults as number) ?? 10,
    debug: (cfg.debug as boolean) ?? false,
    knowledgeGraph: {
      enabled: (kgRaw.enabled as boolean) ?? false,
      scanIntervalMinutes: (kgRaw.scanIntervalMinutes as number) ?? 60,
      batchSize: (kgRaw.batchSize as number) ?? 20,
    },
  }
}

export const hyperspellConfigSchema = {
  parse: parseConfig,
}

/**
 * Get the workspace directory from OpenClaw config
 */
export function getWorkspaceDir(): string {
  const { homedir } = require("node:os")
  const fs = require("node:fs")
  const path = require("node:path")

  // Resolve config path
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim() || process.env.CLAWDBOT_CONFIG_PATH?.trim()
  let configPath: string
  if (override) {
    configPath = override.startsWith("~")
      ? override.replace(/^~(?=$|[\\/])/, homedir())
      : path.resolve(override)
  } else {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
    const resolvedStateDir = stateDir
      ? (stateDir.startsWith("~") ? stateDir.replace(/^~(?=$|[\\/])/, homedir()) : path.resolve(stateDir))
      : path.join(homedir(), ".openclaw")
    configPath = path.join(resolvedStateDir, "openclaw.json")
  }

  // Read workspace from config
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(content)
      const workspace = config?.agents?.defaults?.workspace
      if (workspace) {
        return workspace.startsWith("~")
          ? workspace.replace(/^~(?=$|[\\/])/, homedir())
          : workspace
      }
    } catch (_e) {
      // Fall back to default
    }
  }

  // Default workspace
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
  const resolvedStateDir = stateDir
    ? (stateDir.startsWith("~") ? stateDir.replace(/^~(?=$|[\\/])/, homedir()) : path.resolve(stateDir))
    : path.join(homedir(), ".openclaw")
  return path.join(resolvedStateDir, "workspace")
}
