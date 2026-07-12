import assert from "node:assert/strict"
import { test } from "node:test"
import type { HyperspellClient } from "../client.ts"
import { parseConfig } from "../config.ts"
import { createEmotionalArcToolFactory } from "./emotional-arc.ts"

const cfg = parseConfig({
  apiKey: "k",
  userId: "u1",
  emotionalContext: true,
  relationshipId: "rel-x",
})

type State = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
}

const st = (summary: string): State => ({
  resourceId: `es-${summary.slice(0, 4)}`,
  summary,
  extractedAt: new Date().toISOString(),
  sessionId: null,
  relationshipId: "rel-x",
})

function toolWith(client: {
  getRecentEmotionalStates: (
    relId?: string,
    limit?: number,
  ) => Promise<State[] | null>
  getEmotionalState?: (relId?: string) => Promise<State | null>
}) {
  return createEmotionalArcToolFactory(client as unknown as HyperspellClient, cfg)({})
}

async function runText(
  tool: ReturnType<ReturnType<typeof createEmotionalArcToolFactory>>,
  params: { limit?: number } = {},
) {
  const res = await tool.execute("call-1", params)
  return (res.content[0] as { text: string }).text
}

test("emotional-arc tool — returns the same block the session-start injection builds", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return [st("Warm and collaborative lately."), st("A bit strained last week.")]
    },
  })
  const text = await runText(tool)
  assert.match(text, /<hyperspell-emotional-context>/)
  assert.match(text, /most recent first/) // multi-state intro from buildEmotionalContext
  assert.match(text, /Warm and collaborative lately\./)
  assert.match(text, /A bit strained last week\./)
  assert.match(text, /<\/hyperspell-emotional-context>/)
})

test("emotional-arc tool — falls back to getEmotionalState when /recent is unavailable", async () => {
  let latestCalls = 0
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return null // endpoint not deployed (404)
    },
    async getEmotionalState() {
      latestCalls++
      return st("Single latest register.")
    },
  })
  const text = await runText(tool)
  assert.equal(latestCalls, 1)
  assert.match(text, /Single latest register\./)
  assert.match(text, /from your last interaction/) // single-state intro
})

test("emotional-arc tool — no registers yet reports a blank slate, not an error", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return []
    },
    async getEmotionalState() {
      return null
    },
  })
  const text = await runText(tool)
  assert.match(text, /No emotional arc recorded yet/)
  assert.doesNotMatch(text, /Failed/)
})

test("emotional-arc tool — raw-transcript placeholders are filtered, pending state says so", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return [st("user: hey how are you\nassistant: doing well!")]
    },
  })
  const text = await runText(tool)
  assert.match(text, /still being extracted/)
  assert.doesNotMatch(text, /doing well!/) // raw transcript must not leak through
})

test("emotional-arc tool — backend failure returns error text, does not throw", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      throw new Error("boom")
    },
    async getEmotionalState() {
      throw new Error("boom")
    },
  })
  const text = await runText(tool)
  assert.match(text, /Failed to fetch emotional arc: boom/)
})

test("emotional-arc tool — limit is forwarded and clamped to the max", async () => {
  const seen: Array<number | undefined> = []
  const tool = toolWith({
    async getRecentEmotionalStates(_relId, limit) {
      seen.push(limit)
      return [st("ok")]
    },
  })
  await tool.execute("call-1", { limit: 999 })
  await tool.execute("call-2", {})
  assert.deepEqual(seen, [10, 3]) // MAX_ARC_LIMIT clamp; EMOTIONAL_ARC_LIMIT default
})
