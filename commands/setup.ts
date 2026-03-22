import { exec, execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { homedir, platform, userInfo } from "node:os"
import * as p from "@clack/prompts"
import type { Command } from "commander"
import Hyperspell from "hyperspell"
import { syncAllMemoryFiles, getMemoryFiles } from "../sync/markdown.ts"
import { HyperspellClient } from "../client.ts"
import { getWorkspaceDir, parseConfig } from "../config.ts"
import { buildExtractionPrompt, CRON_JOB_NAME } from "../graph/cron.ts"
import { NetworkStateManager } from "../graph/state.ts"
import { scanMemories, formatScanResults, completeMemories } from "../graph/ops.ts"

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
        emotionalContext: false,
        syncMemories: true,
        sources: [],
        maxResults: 10,
        debug: false,
        knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
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

  // Step 8: Memory Network setup
  p.note(
    "The Memory Network automatically extracts entities (people, projects,\n" +
      "organizations, topics) from your memories into structured markdown\n" +
      "files. This runs as a periodic cron job in the main session.",
    "Memory Network",
  )

  const enableNetwork = await p.confirm({
    message: "Enable the Memory Network?",
    initialValue: false,
  })

  if (!p.isCancel(enableNetwork) && enableNetwork) {
    // Update config to enable knowledgeGraph
    try {
      const configPath = resolveConfigPath()
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8")
        const config = JSON.parse(configContent)
        const pluginEntry = config?.plugins?.entries?.["openclaw-hyperspell"]?.config
        if (pluginEntry) {
          pluginEntry.knowledgeGraph = { enabled: true }
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
        }
      }
      p.log.success("Memory Network enabled in config")
    } catch {
      p.log.warn("Could not update config — add knowledgeGraph.enabled: true manually")
    }

    // Write the extraction prompt to a file and create the cron job
    const networkWorkspaceDir = getWorkspaceDir()
    const promptPath = path.join(networkWorkspaceDir, "HYPERSPELL-MEMORY-NETWORK.md")
    const prompt = buildExtractionPrompt(networkWorkspaceDir)
    fs.mkdirSync(path.dirname(promptPath), { recursive: true })
    fs.writeFileSync(promptPath, prompt)

    const s4 = p.spinner()
    s4.start("Creating Memory Network cron job")

    let cronJobId: string | null = null
    try {
      const output = execFileSync("openclaw", [
        "cron", "add",
        "--name", CRON_JOB_NAME,
        "--every", "1h",
        "--session", "isolated",
        "--message", `Read the file at ${promptPath} and follow the instructions inside it.`,
      ], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })

      // Extract job ID from the JSON output
      const text = output.toString().trim()
      // Find the JSON object in the output (skip any non-JSON prefix lines)
      const jsonStart = text.indexOf("{")
      if (jsonStart >= 0) {
        try {
          const job = JSON.parse(text.slice(jsonStart))
          cronJobId = job?.id || null
        } catch {}
      }

      s4.stop("Cron job created — Memory Network will scan every hour")
    } catch (cronErr) {
      s4.stop("Could not create cron job automatically")

      p.log.warn(`Cron creation failed. Create it manually:`)

      p.note(
        `openclaw cron add \\\n` +
          `  --name "${CRON_JOB_NAME}" \\\n` +
          `  --every 1h \\\n` +
          `  --session isolated \\\n` +
          `  --message "Read the file at ${promptPath} and follow the instructions inside it."`,
        "Manual cron setup",
      )
    }

    // Ask if they want to run the first extraction now
    const runNow = await p.confirm({
      message: "Run the Memory Network now? (If not, it will run automatically on the next cron cycle)",
      initialValue: true,
    })

    if (!p.isCancel(runNow) && runNow) {
      if (cronJobId) {
        const s5 = p.spinner()
        s5.start("Triggering Memory Network extraction")

        try {
          execFileSync("openclaw", [
            "cron", "run", cronJobId,
          ], { stdio: "pipe", timeout: 10_000 })

          s5.stop("Memory Network extraction triggered — running in the background")
        } catch {
          s5.stop("Could not trigger automatically")
          p.log.info(`You can trigger it manually with: openclaw cron run ${cronJobId}`)
        }
      } else {
        p.log.info("Create the cron job first, then run it with: openclaw cron run <job-id>")
      }
    }
  }

  const syncNote = syncMemories
    ? "\n\nMemory sync is enabled — markdown files in memory/ will be\n" +
      "automatically synced to Hyperspell when they change."
    : ""

  const networkNote = !p.isCancel(enableNetwork) && enableNetwork
    ? "\n\nMemory Network is enabled — entities will be extracted into\n" +
      "memory/people/, memory/projects/, memory/organizations/, memory/topics/"
    : ""

  p.note(
    "/getcontext <query>  Search your memories for relevant context\n" +
      "/remember <text>     Save something directly to your vault\n\n" +
      "To connect more apps, run: openclaw openclaw-hyperspell connect\n\n" +
      "Auto-context is enabled by default — relevant memories are\n" +
      "automatically injected before each AI response." +
      syncNote +
      networkNote,
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

  // Memory Network CLI commands (used by isolated cron sessions via exec)
  const networkCmd = hyperspellCmd
    .command("network")
    .description("Memory Network operations")

  networkCmd
    .command("scan")
    .description("Scan for unprocessed memories and output summaries")
    .option("--batch-size <n>", "Max memories to return", "20")
    .action(async (opts) => {
      try {
        const cfg = parseConfig(pluginConfig)
        const client = new HyperspellClient(cfg)
        const workspaceDir = getWorkspaceDir()
        const stateManager = new NetworkStateManager(workspaceDir)
        const batchSize = Number.parseInt(opts.batchSize, 10) || 20

        const memories = await scanMemories(client, stateManager, batchSize)
        const text = formatScanResults(memories, stateManager.getProcessedCount(), stateManager.getLastScanAt())
        process.stdout.write(text + "\n")
      } catch (err) {
        process.stderr.write(`Scan failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      }
    })

  networkCmd
    .command("complete")
    .description("Mark memory IDs as processed")
    .requiredOption("--ids <ids>", "Comma-separated resource_ids")
    .action((opts) => {
      try {
        const workspaceDir = getWorkspaceDir()
        const stateManager = new NetworkStateManager(workspaceDir)
        const memoryIds = (opts.ids as string).split(",").map((s: string) => s.trim()).filter(Boolean)

        const { newCount, totalCount } = completeMemories(stateManager, memoryIds)
        process.stdout.write(`Marked ${newCount} new memories as processed (${totalCount} total)\n`)
      } catch (err) {
        process.stderr.write(`Complete failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      }
    })

  networkCmd
    .command("sync")
    .description("Sync entity files in memory/ to Hyperspell")
    .action(async () => {
      try {
        const cfg = parseConfig(pluginConfig)
        const client = new HyperspellClient(cfg)
        const workspaceDir = getWorkspaceDir()

        const result = await syncAllMemoryFiles(client, workspaceDir)
        process.stdout.write(`Synced ${result.synced} files, ${result.failed} failed\n`)
        if (result.errors.length > 0) {
          for (const error of result.errors) {
            process.stderr.write(`  ${error}\n`)
          }
        }
      } catch (err) {
        process.stderr.write(`Sync failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      }
    })
}
