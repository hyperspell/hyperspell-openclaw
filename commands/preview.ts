import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import {
  buildEmotionalContext,
  fetchRecentOrLatest,
  looksLikeRawTranscript,
} from "../hooks/emotional-state.ts"
import { gatherOrientation, personalUserId } from "../hooks/startup-orientation.ts"
import { isExcludedChannel } from "../lib/exclude-channels.ts"
import { log } from "../logger.ts"

/**
 * Assemble a read-only report of what before_agent_start WOULD inject at the
 * start of the next session. Calls only the pure fetch/format functions the
 * real hooks are composed from — never the hook handlers themselves — so it
 * cannot touch the inject-once session caches, and it never calls rollMood
 * (a debug command must not consume or reveal a mood roll; the roll happens
 * once, in the real injection path, per session).
 */
export async function buildPreviewReport(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  ctx: { senderId?: string; channel?: string },
): Promise<string> {
  // Quarantined channels get no injected memory of any kind (index.ts guards
  // before_agent_start with the same check) — report that instead of a bundle.
  if (isExcludedChannel({ channelId: ctx.channel }, cfg)) {
    return "This channel is quarantined (excludeChannels): no context would be injected here and no memory would be written."
  }

  const sections: string[] = []

  // ---- 1. Emotional context (registration order in index.ts: first) ----
  if (!cfg.emotionalContext) {
    sections.push(
      "Emotional context: OFF (emotionalContext=false) — no register/arc would be injected.",
    )
  } else {
    try {
      const states = await fetchRecentOrLatest(client, cfg)
      const usable = states.filter((s) => s.summary && !looksLikeRawTranscript(s.summary))
      if (usable.length > 0) {
        const pending = states.length - usable.length
        const pendingNote =
          pending > 0
            ? `\n(${pending} more register(s) still extracting — excluded, same as the real hook.)`
            : ""
        sections.push(
          `Emotional context: would inject ${usable.length} register(s):\n\n${buildEmotionalContext(usable)}${pendingNote}`,
        )
      } else if (states.length > 0) {
        sections.push(
          "Emotional context: register(s) exist but are still extracting (raw-transcript placeholder) — the real hook would skip this turn and retry next turn.",
        )
      } else {
        sections.push(
          "Emotional context: ON, but no prior emotional state found — nothing to inject yet (first conversation, or register deleted).",
        )
      }
    } catch (err) {
      log.error("/previewcontext: emotional fetch failed", err)
      sections.push(
        "Emotional context: fetch FAILED — the real hook would log this and inject nothing. Check logs.",
      )
    }

    // Mood weather: report configuration only. Deliberately NOT rolled — see
    // function doc comment. Preview must be idempotent and non-revealing.
    sections.push(
      cfg.moodWeatherChance > 0
        ? `Mood weather: configured chance ${Math.round(cfg.moodWeatherChance * 100)}% per session — NOT rolled by this preview. Each real session rolls independently at injection time; the actual mood (if any) is only observable in the live session.`
        : "Mood weather: OFF (moodWeatherChance=0).",
    )
  }

  // ---- 2. Auto-context (second in registration order) ----
  sections.push(
    cfg.autoContext
      ? "Auto-context: ON — will search memories using the text of your next message. Query-dependent, so not previewable here; use /getcontext <your message> to simulate."
      : "Auto-context: OFF.",
  )

  // ---- 3. Startup orientation (third in registration order) ----
  const so = cfg.startupOrientation
  if (!so.enabled) {
    sections.push("Startup orientation: OFF (startupOrientation.enabled=false).")
  } else {
    const { skip, userId } = personalUserId(cfg, ctx)
    if (skip) {
      sections.push(
        "Startup orientation: ON, but you are an unknown sender in multi-user mode — the real hook would skip injection for you.",
      )
    } else {
      const g = await gatherOrientation(client, cfg, userId)
      const parts: string[] = []
      if (g.recentSource === "none") {
        parts.push(
          "recent-interactions: no source (hotBuffer and autoTrace both off) — block would be empty.",
        )
      } else if (!g.recentOk) {
        parts.push(
          `recent-interactions: fetch FAILED (source=${g.recentSource}) — real hook would retry next turn.`,
        )
      } else {
        parts.push(
          g.recentBlock ?? `recent-interactions: source=${g.recentSource}, 0 results — block omitted.`,
        )
      }
      if (!g.loopsOk) {
        parts.push("unfinished-loops: search FAILED — real hook would retry next turn.")
      } else {
        parts.push(
          g.loopsBlock ??
            `unfinished-loops: 0 results for loopsQuery ("${so.loopsQuery}") — block omitted.`,
        )
      }
      sections.push(`Startup orientation: ON.\n\n${parts.join("\n\n")}`)
    }
  }

  return [
    "What the next session would inject (read-only preview — no session state touched, no mood rolled):",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n")
}
