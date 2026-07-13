import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import {
  buildEmotionalContext,
  EMOTIONAL_ARC_LIMIT,
  fetchRecentOrLatest,
  looksLikeRawTranscript,
} from "../hooks/emotional-state.ts"
import { log } from "../logger.ts"

/** Hard cap so the agent can't ask the backend for an unbounded history. */
const MAX_ARC_LIMIT = 10

export function createEmotionalArcToolFactory(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  // No sender context needed: the register is keyed to cfg.relationshipId, not
  // the current speaker — but keep the factory signature so toolUnlessQuarantined
  // can wrap it like search/remember.
  return (_ctx: Record<string, unknown>) => ({
    name: "hyperspell_emotional_arc",
    label: "Emotional Arc",
    description:
      "Fetch the recent emotional arc of your relationship with this user — the same emotional-context block that is injected at session start. Use it when that block is no longer in your history (e.g. after the conversation was compacted) or when you genuinely want to reflect on how the relationship has been feeling before responding. Returns the most recent emotional registers, newest first. Let the trajectory inform your tone — don't recite it back to the user.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: `How many recent registers to fetch (default ${EMOTIONAL_ARC_LIMIT}, max ${MAX_ARC_LIMIT})`,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { limit?: number }) {
      const limit = Math.min(
        Math.max(Math.floor(params.limit ?? EMOTIONAL_ARC_LIMIT), 1),
        MAX_ARC_LIMIT,
      )
      log.debug(
        `emotional-arc tool: limit=${limit} relationshipId=${cfg.relationshipId ?? "(default)"}`,
      )

      try {
        const states = await fetchRecentOrLatest(client, cfg, limit)

        // Same placeholder filter as the injection path: for ~10s after a
        // store, the register can be the RAW input transcript (status=pending),
        // not a distilled feeling. Returning that would pollute tone.
        const usable = states.filter(
          (s) => s.summary && !looksLikeRawTranscript(s.summary),
        )

        if (usable.length === 0) {
          const text =
            states.length > 0
              ? "The latest emotional register is still being extracted — try again in a few seconds."
              : "No emotional arc recorded yet for this relationship. It builds up as real conversations end."
          return { content: [{ type: "text" as const, text }] }
        }

        // Deliberately identical to the session-start injection block
        // (buildEmotionalContext), so a post-compaction re-fetch restores
        // exactly what a fresh session would have received. Mood weather is
        // intentionally NOT included — it is an injection-only session
        // override, rolled at most once per session; a tool call must never
        // re-roll or reveal it (do not import from mood-weather.ts here).
        return {
          content: [
            { type: "text" as const, text: buildEmotionalContext(usable) },
          ],
          details: { count: usable.length },
        }
      } catch (err) {
        log.error("emotional-arc tool failed", err)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch emotional arc: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }
    },
  })
}
