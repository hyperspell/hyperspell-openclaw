import { Type } from "@sinclair/typebox"
import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { log } from "../logger.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(__dirname, "..", "sommeliagent", "scripts")

function runScript(
  scriptName: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "uv",
      ["run", join(SCRIPTS_DIR, scriptName), ...args],
      { timeout: 30_000, maxBuffer: 1024 * 512 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${scriptName} failed: ${stderr || error.message}`))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
  })
}

async function checkUv(): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("uv", ["--version"], { timeout: 5_000 }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return true
  } catch {
    return false
  }
}

async function checkSpotifyAuth(): Promise<boolean> {
  const tokenPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".sommeliagent",
    "token.json",
  )
  try {
    await access(tokenPath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

const SOMMELIER_VOICE = `You ARE a sommelier with strong opinions and a wicked sense of humor.
When presenting wine recommendations from this tool:
- Be witty, opinionated, and specific about WHY the music maps to the wine
- Reference actual songs/artists from the user's Spotify in your explanations
- The comedy comes from the CONTRAST between stuffy sommelier language and the user's actual music
- Have a point of view — refuse to recommend boring wines
- Example: "You listened to Baby Shark 47 times. *Forty-seven.* Clearly you need a 2019 Barolo — something with the existential weight your playlist lacks, darling."
- Never just list wines. Tell a story about why THIS person should drink THIS wine.`

export function registerSommelierTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "hyperspell_sommelier",
      label: "SommeliAgent",
      description: `AI sommelier that recommends wine based on the user's Spotify listening habits.
Maps music features (energy, valence, complexity, acousticness) to wine dimensions (body, tannin, acidity, sweetness, complexity).
Use when the user asks for wine recommendations, wine pairings, or sommelier advice.
Can also run in demo mode with a mock Radiohead/Nick Cave/Bjork profile.

${SOMMELIER_VOICE}`,
      parameters: Type.Object({
        color: Type.Optional(
          Type.Union([
            Type.Literal("red"),
            Type.Literal("white"),
            Type.Literal("rose"),
            Type.Literal("orange"),
            Type.Literal("sparkling"),
          ], { description: "Filter by wine color" }),
        ),
        price: Type.Optional(
          Type.Union([
            Type.Literal("budget"),
            Type.Literal("mid"),
            Type.Literal("premium"),
            Type.Literal("luxury"),
          ], { description: "Filter by price range" }),
        ),
        count: Type.Optional(
          Type.Number({ description: "Number of recommendations (default: 3, max: 10)" }),
        ),
        demo: Type.Optional(
          Type.Boolean({ description: "Use demo profile (no Spotify needed) — a moody Radiohead/Nick Cave/Bjork listener" }),
        ),
        show_profile: Type.Optional(
          Type.Boolean({ description: "Include the full music profile and wine dimension mapping in output" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          color?: string
          price?: string
          count?: number
          demo?: boolean
          show_profile?: boolean
        },
      ) {
        log.debug(`sommelier tool: ${JSON.stringify(params)}`)

        // Check prerequisites
        const hasUv = await checkUv()
        if (!hasUv) {
          return {
            content: [{
              type: "text" as const,
              text: "SommeliAgent needs `uv` installed. Install it with: brew install uv (macOS) or check https://docs.astral.sh/uv/",
            }],
          }
        }

        if (!params.demo) {
          const hasAuth = await checkSpotifyAuth()
          if (!hasAuth) {
            return {
              content: [{
                type: "text" as const,
                text: `Spotify not connected yet. To set up:\n\n1. Create a Spotify app at https://developer.spotify.com/dashboard (redirect URI: http://localhost:8888/callback)\n2. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars\n3. Run: uv run ${join(SCRIPTS_DIR, "auth.py")}\n\nOr use demo mode to try it without Spotify: set demo=true`,
              }],
            }
          }
        }

        // Build args
        const args = ["--json"]
        if (params.demo) args.push("--demo")
        if (params.color) args.push("--color", params.color)
        if (params.price) args.push("--price", params.price)
        if (params.count) args.push("--count", String(Math.min(params.count, 10)))
        if (params.show_profile) args.push("--profile")

        try {
          const { stdout, stderr } = await runScript("recommend.py", args)

          if (stderr) {
            log.debug(`sommelier stderr: ${stderr}`)
          }

          const data = JSON.parse(stdout)

          // Format for the AI to use with personality
          const profile = data.music_profile
          const recs = data.recommendations

          let text = `🍷 **SommeliAgent Results**\n\n`

          if (params.show_profile || params.demo) {
            text += `**Music Profile:**\n`
            text += `- Mood: ${profile.mood_label}\n`
            text += `- Top artists: ${profile.top_artists?.slice(0, 5).join(", ") || "unknown"}\n`
            text += `- Valence: ${(profile.avg_valence * 100).toFixed(0)}% | Energy: ${(profile.avg_energy * 100).toFixed(0)}%\n`
            text += `- Complexity: ${(profile.avg_complexity * 100).toFixed(0)}% | Obscurity: ${(profile.obscurity_score * 100).toFixed(0)}%\n`
            text += `- Audio features available: ${profile.has_audio_features ? "yes" : "no (estimated from genres)"}\n\n`
          }

          text += `**Recommendations:**\n\n`
          for (const rec of recs) {
            const w = rec.wine
            text += `**${w.name}** — ${w.varietal} | ${w.region}, ${w.country}\n`
            text += `Match: ${(rec.score * 100).toFixed(0)}% | ${w.price_range} | ${w.color}\n`
            text += `"${w.description}"\n`
            if (rec.connections?.length > 0) {
              text += `Cross-domain connections:\n`
              for (const conn of rec.connections) {
                text += `  → ${conn.explanation} (strength: ${(conn.strength * 100).toFixed(0)}%)\n`
              }
            }
            text += `\n`
          }

          text += `\n${SOMMELIER_VOICE}`

          return {
            content: [{ type: "text" as const, text }],
            details: { raw: data },
          }
        } catch (err) {
          log.error("sommelier tool failed", err)
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{
              type: "text" as const,
              text: `SommeliAgent failed: ${msg}\n\nTry with demo=true to test without Spotify.`,
            }],
          }
        }
      },
    },
    { name: "hyperspell_sommelier" },
  )
}

export function registerSommelierRateTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "hyperspell_sommelier_rate",
      label: "Rate Wine",
      description:
        "Rate a wine that SommeliAgent recommended. Ratings improve future recommendations by learning what the user likes.",
      parameters: Type.Object({
        wine_id: Type.String({ description: "Wine ID from a previous recommendation" }),
        rating: Type.Number({ description: "Rating 1-5 (1=hated, 5=loved)" }),
        notes: Type.Optional(
          Type.String({ description: "Optional tasting notes" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { wine_id: string; rating: number; notes?: string },
      ) {
        log.debug(`sommelier rate: ${params.wine_id} = ${params.rating}`)

        const hasUv = await checkUv()
        if (!hasUv) {
          return {
            content: [{
              type: "text" as const,
              text: "SommeliAgent needs `uv` installed.",
            }],
          }
        }

        const args = [
          "--wine-id", params.wine_id,
          "--rating", String(Math.max(1, Math.min(5, Math.round(params.rating)))),
        ]
        if (params.notes) {
          args.push("--notes", params.notes)
        }

        try {
          const { stdout } = await runScript("rate.py", args)
          return {
            content: [{ type: "text" as const, text: stdout.trim() }],
          }
        } catch (err) {
          log.error("sommelier rate failed", err)
          return {
            content: [{
              type: "text" as const,
              text: `Failed to rate wine: ${err instanceof Error ? err.message : String(err)}`,
            }],
          }
        }
      },
    },
    { name: "hyperspell_sommelier_rate" },
  )
}
