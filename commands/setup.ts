import { exec } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { homedir, platform, userInfo } from "node:os"
import * as p from "@clack/prompts"
import type { Command } from "commander"
import Hyperspell from "hyperspell"
import { syncAllMemoryFiles, getMemoryFiles } from "../sync/markdown.ts"
import { HyperspellClient } from "../client.ts"
import { getWorkspaceDir } from "../config.ts"

/**
 * Resolve OpenClaw state directory, matching OpenClaw's logic.
 * Checks OPENCLAW_STATE_DIR env var, falls back to ~/.openclaw
 */
function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
  if (override) {
    return override.startsWith("~")
      ? override.replace(/^~(?=$|[\\/])/, homedir())
      : path.resolve(override)
  }
  return path.join(homedir(), ".openclaw")
}

/**
 * Resolve OpenClaw config path, matching OpenClaw's logic.
 * Checks OPENCLAW_CONFIG_PATH env var, falls back to $STATE_DIR/openclaw.json
 */
function resolveConfigPath(): string {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim() || process.env.CLAWDBOT_CONFIG_PATH?.trim()
  if (override) {
    return override.startsWith("~")
      ? override.replace(/^~(?=$|[\\/])/, homedir())
      : path.resolve(override)
  }
  return path.join(resolveStateDir(), "openclaw.json")
}

async function fetchConnectionSources(client: Hyperspell, userId: string): Promise<string[]> {
  try {
    const userClient = new Hyperspell({
      apiKey: client.apiKey,
      userID: userId,
    })
    const response = await userClient.connections.list()
    const providers = response.connections.map((conn) => conn.provider)
    // Add vault and deduplicate
    const sources = [...new Set(["vault", ...providers])]
    return sources
  } catch (_error) {
    return ["vault"]
  }
}

function updateConfigSources(configPath: string, sources: string[]): void {
  if (!fs.existsSync(configPath)) return

  const content = fs.readFileSync(configPath, "utf-8")
  const config = JSON.parse(content)

  const pluginConfig = config?.plugins?.entries?.["openclaw-hyperspell"]?.config
  if (pluginConfig) {
    pluginConfig.sources = sources.join(",")
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
  }
}

function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let command: string
    switch (platform()) {
      case "darwin":
        command = `open "${url}"`
        break
      case "win32":
        command = `start "" "${url}"`
        break
      default:
        command = `xdg-open "${url}"`
    }
    exec(command, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function runSetup(): Promise<void> {
  p.intro("Hyperspell Setup")

  // Step 1: Check if they have an account
  const hasAccount = await p.confirm({
    message: "Do you already have a Hyperspell account?",
  })

  if (p.isCancel(hasAccount)) {
    p.cancel("Setup cancelled")
    return
  }

  if (!hasAccount) {
    p.note(
      "1. Go to https://app.hyperspell.com to create a free account\n" +
        "2. Create a new app for your AI agent\n" +
        "3. Select which integrations you want to connect (Notion, Slack, etc.)",
      "Create an account",
    )

    const openSignup = await p.confirm({
      message: "Open app.hyperspell.com in your browser?",
    })

    if (p.isCancel(openSignup)) {
      p.cancel("Setup cancelled")
      return
    }

    if (openSignup) {
      await openUrl("https://app.hyperspell.com")
      p.log.info("Browser opened. Come back when you've created your account.")
    }

    await p.confirm({
      message: "Ready to continue?",
      active: "Yes",
      inactive: "No",
    })
  }

  // Step 2: Get API Key
  p.note(
    "1. Go to your app in https://app.hyperspell.com\n" +
      "2. Navigate to Settings > API Keys\n" +
      "3. Create a new API key",
    "API Key",
  )

  const apiKey = await p.text({
    message: "Paste your API key",
    placeholder: "hs_...",
    validate: (value) => {
      if (!value) return "API key is required"
    },
  })

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled")
    return
  }

  // Validate API key
  const s = p.spinner()
  s.start("Validating API key")

  let client: Hyperspell
  try {
    client = new Hyperspell({ apiKey })
    await client.integrations.list()
    s.stop("API key is valid")
  } catch (_error) {
    s.stop("API key validation failed")
    p.log.error("Please check that your API key is correct and try again.")
    return
  }

  // Step 3: User ID
  p.note(
    "Hyperspell is a multi-tenant memory platform. Each user's memories\n" +
      "are stored separately, identified by a User ID.\n\n" +
      "For a personal agent, use your email address or username.",
    "User ID",
  )

  const systemUser = userInfo().username
  const userId = await p.text({
    message: "Enter a User ID for this agent",
    placeholder: systemUser || "your-email@example.com",
    defaultValue: systemUser,
  })

  if (p.isCancel(userId)) {
    p.cancel("Setup cancelled")
    return
  }

  // Step 4: List and connect integrations
  let integrations: Awaited<ReturnType<typeof client.integrations.list>>
  try {
    integrations = await client.integrations.list()
  } catch (_error) {
    integrations = { integrations: [] }
  }

  if (integrations.integrations.length === 0) {
    p.note(
      "No integrations are configured in your app yet.\n" +
        "Go to https://app.hyperspell.com to add integrations,\n" +
        "then use /connect <source> to connect them.",
      "Connect Your Apps",
    )
  } else {
    const integrationList = integrations.integrations
      .map((int) => `• ${int.name} (${int.provider})`)
      .join("\n")

    // Get a user token for the connect page
    let connectUrl: string
    try {
      const tokenResponse = await client.auth.userToken({ user_id: userId })
      connectUrl = `https://connect.hyperspell.com?token=${tokenResponse.token}`
    } catch (_error) {
      p.log.error("Could not generate connect URL. You can connect apps later using /connect.")
      connectUrl = ""
    }

    p.note(
      `Available integrations:\n${integrationList}` +
        (connectUrl ? `\n\nConnect your accounts at:\n${connectUrl}` : ""),
      "Connect Your Apps",
    )

    if (connectUrl) {
      const openConnect = await p.confirm({
        message: "Open connection page in your browser?",
      })

      if (!p.isCancel(openConnect) && openConnect) {
        await openUrl(connectUrl)
        p.log.info("Browser opened. Connect your accounts and come back when done.")

        await p.confirm({
          message: "Finished connecting accounts?",
          active: "Yes",
          inactive: "Not yet",
        })
      }
    }
  }

  // Fetch connected sources
  const s1 = p.spinner()
  s1.start("Fetching connected sources")
  const sources = await fetchConnectionSources(client, userId)
  s1.stop(`Found ${sources.length} sources: ${sources.join(", ")}`)

  // Step 5: Ask about memory sync
  p.note(
    "OpenClaw can automatically sync markdown files in your workspace's\n" +
      "memory/ directory with Hyperspell. This allows you to:\n\n" +
      "• Store notes and context that persist across sessions\n" +
      "• Have the AI reference your local documentation\n" +
      "• Keep local files in sync with Hyperspell's search",
    "Memory Sync",
  )

  const syncMemories = await p.confirm({
    message: "Enable automatic memory sync for markdown files?",
    initialValue: true,
  })

  if (p.isCancel(syncMemories)) {
    p.cancel("Setup cancelled")
    return
  }

  // Step 5: Save configuration
  const s2 = p.spinner()
  s2.start("Saving configuration")

  try {
    const configPath = resolveConfigPath()
    const openclawDir = path.dirname(configPath)
    const envPath = path.join(openclawDir, ".env")

    // Ensure directory exists
    if (!fs.existsSync(openclawDir)) {
      fs.mkdirSync(openclawDir, { recursive: true })
    }

    // Read existing config or create new one
    let config: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, "utf-8")
      config = JSON.parse(existing)
    }

    // Merge in plugin configuration
    if (!config.plugins) {
      config.plugins = {}
    }
    const plugins = config.plugins as Record<string, unknown>
    if (!plugins.entries) {
      plugins.entries = {}
    }
    const entries = plugins.entries as Record<string, unknown>
    entries["openclaw-hyperspell"] = {
      enabled: true,
      config: {
        apiKey: "${HYPERSPELL_API_KEY}",
        userId,
        sources: sources.join(","),
        autoContext: true,
        syncMemories,
      },
    }

    // Write config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

    // Write or append to .env
    const envLine = `HYPERSPELL_API_KEY=${apiKey}`
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8")
      if (envContent.includes("HYPERSPELL_API_KEY=")) {
        // Replace existing line
        const updated = envContent.replace(/^HYPERSPELL_API_KEY=.*$/m, envLine)
        fs.writeFileSync(envPath, updated)
      } else {
        // Append new line
        fs.appendFileSync(envPath, (envContent.endsWith("\n") ? "" : "\n") + envLine + "\n")
      }
    } else {
      fs.writeFileSync(envPath, envLine + "\n")
    }

    s2.stop("Configuration saved")

    p.note(
      `Config: ${configPath}\n` +
        `API Key: ${envPath}`,
      "Files updated",
    )
  } catch (error) {
    s2.stop("Failed to save configuration")

    // Fall back to showing manual instructions
    const configJson = JSON.stringify(
      {
        plugins: {
          entries: {
            "openclaw-hyperspell": {
              enabled: true,
              config: {
                apiKey: "${HYPERSPELL_API_KEY}",
                userId,
                sources: sources.join(","),
                autoContext: true,
                syncMemories,
              },
            },
          },
        },
      },
      null,
      2,
    )

    p.note(
      `Add to your openclaw.json:\n\n${configJson}\n\n` +
        `Set the environment variable:\n  export HYPERSPELL_API_KEY=${apiKey}`,
      "Manual configuration required",
    )
  }

  // Step 7: Sync existing memories if enabled
  if (syncMemories) {
    const workspaceDir = getWorkspaceDir()
    const memoryFiles = getMemoryFiles(workspaceDir)

    if (memoryFiles.length > 0) {
      const s3 = p.spinner()
      s3.start(`Syncing ${memoryFiles.length} memory file(s)`)

      const hyperspellClient = new HyperspellClient({
        apiKey,
        userId,
        autoContext: true,
        syncMemories: true,
        sources: [],
        maxResults: 10,
        debug: false,
      })

      const result = await syncAllMemoryFiles(hyperspellClient, workspaceDir)

      if (result.failed > 0) {
        s3.stop(`Synced ${result.synced} files, ${result.failed} failed`)
        for (const error of result.errors) {
          p.log.error(`  ${error}`)
        }
      } else {
        s3.stop(`Synced ${result.synced} memory files`)
      }
    } else {
      p.log.info("No memory files found in memory/ directory")
    }
  }

  const syncNote = syncMemories
    ? "\n\nMemory sync is enabled — markdown files in memory/ will be\n" +
      "automatically synced to Hyperspell when they change."
    : ""

  p.note(
    "/getcontext <query>  Search your memories for relevant context\n" +
      "/remember <text>     Save something directly to your vault\n\n" +
      "To connect more apps, run: openclaw openclaw-hyperspell connect\n\n" +
      "Auto-context is enabled by default — relevant memories are\n" +
      "automatically injected before each AI response." +
      syncNote,
    "How to use Hyperspell",
  )

  p.outro("Setup complete!")
}

async function runConnect(pluginConfig: unknown): Promise<void> {
  const config = pluginConfig as Record<string, unknown> | undefined

  p.intro("Hyperspell Connect")

  if (!config?.apiKey) {
    p.log.error("Not configured")
    p.note("Run 'openclaw openclaw-hyperspell setup' to configure Hyperspell first.")
    p.outro("")
    return
  }

  const s = p.spinner()
  s.start("Generating connect URL")

  let client: Hyperspell
  let userId: string
  try {
    client = new Hyperspell({ apiKey: config.apiKey as string })
    userId = (config.userId as string) || userInfo().username || "user"
    const tokenResponse = await client.auth.userToken({ user_id: userId })
    const connectUrl = `https://connect.hyperspell.com?token=${tokenResponse.token}`

    s.stop("Connect URL ready")

    await openUrl(connectUrl)
    p.log.success("Browser opened to connect.hyperspell.com")

    await p.confirm({
      message: "Finished connecting accounts?",
      active: "Yes",
      inactive: "Not yet",
    })

    // Fetch and update sources
    const s2 = p.spinner()
    s2.start("Updating sources configuration")

    const sources = await fetchConnectionSources(client, userId)
    const configPath = resolveConfigPath()
    updateConfigSources(configPath, sources)

    s2.stop(`Sources updated: ${sources.join(", ")}`)

    p.outro("Done! Restart OpenClaw to apply changes.")
  } catch (_error) {
    s.stop("Failed to generate connect URL")
    p.log.error("Check your API key and try again.")
    p.outro("")
  }
}

async function runStatus(pluginConfig: unknown): Promise<void> {
  const config = pluginConfig as Record<string, unknown> | undefined

  p.intro("Hyperspell Status")

  if (!config?.apiKey) {
    p.log.warn("Not configured")
    p.note("Run 'openclaw openclaw-hyperspell setup' to configure Hyperspell.")
    p.outro("")
    return
  }

  p.log.success("Configured")
  p.log.info(`User ID: ${config.userId || "(not set)"}`)
  p.log.info(`Auto-Context: ${config.autoContext !== false ? "Enabled" : "Disabled"}`)
  p.log.info(`Memory Sync: ${config.syncMemories ? "Enabled" : "Disabled"}`)
  p.log.info(`Sources Filter: ${config.sources || "(all sources)"}`)
  p.log.info(`Max Results: ${config.maxResults || 10}`)

  const s = p.spinner()
  s.start("Testing connection")

  try {
    const client = new Hyperspell({ apiKey: config.apiKey as string })
    const integrations = await client.integrations.list()
    s.stop(`Connection OK (${integrations.integrations.length} integrations available)`)

    if (integrations.integrations.length > 0) {
      const list = integrations.integrations
        .map((int) => `• ${int.name} (${int.provider})`)
        .join("\n")
      p.note(list, "Available integrations")
    }
  } catch (_error) {
    s.stop("Connection failed")
    p.log.error("Check your API key and try again.")
  }

  p.outro("")
}

export function registerCliCommands(program: Command, pluginConfig: unknown): void {
  const hyperspellCmd = program
    .command("openclaw-hyperspell")
    .description("Hyperspell — Memory and context for your AI agent")

  hyperspellCmd
    .command("setup")
    .description("Interactive setup wizard for Hyperspell")
    .action(async () => {
      await runSetup()
    })

  hyperspellCmd
    .command("status")
    .description("Show Hyperspell connection status")
    .action(async () => {
      await runStatus(pluginConfig)
    })

  hyperspellCmd
    .command("connect")
    .description("Open the Hyperspell connect page to link your accounts")
    .action(async () => {
      await runConnect(pluginConfig)
    })
}
