import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { join } from "node:path"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { log } from "../logger.ts"
import { runScript, SCRIPTS_DIR } from "../lib/run-script.ts"

function parseWineArgs(argsStr: string): string[] {
  const args: string[] = []
  const parts = argsStr.trim().split(/\s+/)

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase()
    if (["red", "white", "rose", "orange", "sparkling", "dessert"].includes(part)) {
      args.push("--color", part)
    } else if (["budget", "mid", "premium", "luxury"].includes(part)) {
      args.push("--price", part)
    } else if (part === "demo") {
      args.push("--demo")
    } else if (part === "profile") {
      args.push("--profile")
    } else if (/^\d+$/.test(part)) {
      args.push("--count", String(Math.min(Number.parseInt(part), 10)))
    }
  }

  return args
}

export function registerWineCommands(api: OpenClawPluginApi): void {
  // /wine [color] [price] [count] [demo] [profile]
  api.registerCommand({
    name: "wine",
    description: "Get wine recommendations based on your Spotify listening habits",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: { args?: string }) => {
      log.debug(`/wine command: "${ctx.args || ""}"`)

      // Check uv
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("uv", ["--version"], { timeout: 5_000 }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch {
        return { text: "SommeliAgent needs `uv` installed. Run: brew install uv" }
      }

      const userArgs = ctx.args?.trim() || ""
      const scriptArgs = parseWineArgs(userArgs)
      const isDemo = scriptArgs.includes("--demo")

      // Check Spotify auth (unless demo mode)
      if (!isDemo) {
        const tokenPath = join(
          process.env.HOME || process.env.USERPROFILE || "",
          ".sommeliagent",
          "token.json",
        )
        try {
          await access(tokenPath, constants.R_OK)
        } catch {
          return {
            text: `Spotify not connected. Set up:\n1. Create app at https://developer.spotify.com/dashboard\n2. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET\n3. Run: uv run ${join(SCRIPTS_DIR, "auth.py")}\n\nOr try: /wine demo`,
          }
        }
      }

      try {
        const { stdout, stderr } = await runScript("recommend.py", scriptArgs)

        if (stderr) {
          log.debug(`/wine stderr: ${stderr}`)
        }

        return { text: stdout }
      } catch (err) {
        log.error("/wine failed", err)
        return {
          text: `SommeliAgent failed: ${err instanceof Error ? err.message : String(err)}\n\nTry: /wine demo`,
        }
      }
    },
  })

  // /wine-auth - Run Spotify OAuth
  api.registerCommand({
    name: "wine-auth",
    description: "Connect your Spotify account for wine recommendations",
    acceptsArgs: false,
    requireAuth: false,
    handler: async () => {
      log.debug("/wine-auth command")

      try {
        const { stdout } = await runScript("auth.py", [], 180_000)
        return { text: stdout }
      } catch (err) {
        log.error("/wine-auth failed", err)
        return {
          text: `Spotify auth failed: ${err instanceof Error ? err.message : String(err)}\n\nMake sure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set.`,
        }
      }
    },
  })

  // /wine-rate <wine-id> <1-5> [notes]
  api.registerCommand({
    name: "wine-rate",
    description: "Rate a wine recommendation (improves future suggestions)",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: { args?: string }) => {
      const parts = ctx.args?.trim().split(/\s+/) || []
      if (parts.length < 2) {
        return { text: 'Usage: /wine-rate <wine-id> <1-5> [notes]\nExample: /wine-rate red-it-001 5 "Incredible tannins"' }
      }

      const wineId = parts[0]
      const rating = Number.parseInt(parts[1])
      if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return { text: "Rating must be 1-5." }
      }

      const notes = parts.slice(2).join(" ")
      const args = ["--wine-id", wineId, "--rating", String(rating)]
      if (notes) args.push("--notes", notes)

      try {
        const { stdout } = await runScript("rate.py", args)
        return { text: stdout }
      } catch (err) {
        log.error("/wine-rate failed", err)
        return {
          text: `Failed to rate: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  })

  // /wine-history - Show past ratings
  api.registerCommand({
    name: "wine-history",
    description: "View your wine rating history and taste profile",
    acceptsArgs: false,
    requireAuth: false,
    handler: async () => {
      log.debug("/wine-history command")

      try {
        const { stdout } = await runScript("history.py", [])
        return { text: stdout }
      } catch (err) {
        log.error("/wine-history failed", err)
        return {
          text: `Failed to load history: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  })
}
