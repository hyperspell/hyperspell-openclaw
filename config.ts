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

export type HyperspellConfig = {
  apiKey: string
  userId?: string
  autoContext: boolean
  sources: HyperspellSource[]
  maxResults: number
  debug: boolean
}

const ALLOWED_KEYS = [
  "apiKey",
  "userId",
  "autoContext",
  "sources",
  "maxResults",
  "debug",
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

function parseSources(raw: string | undefined): HyperspellSource[] {
  if (!raw || raw.trim() === "") {
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

  return {
    apiKey,
    userId: cfg.userId as string | undefined,
    autoContext: (cfg.autoContext as boolean) ?? true,
    sources: parseSources(cfg.sources as string | undefined),
    maxResults: (cfg.maxResults as number) ?? 10,
    debug: (cfg.debug as boolean) ?? false,
  }
}

export const hyperspellConfigSchema = {
  parse: parseConfig,
}
