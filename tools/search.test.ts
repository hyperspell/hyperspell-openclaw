import assert from "node:assert/strict"
import { test } from "node:test"
import type { HyperspellClient } from "../client.ts"
import { parseConfig } from "../config.ts"
import { createSearchToolFactory } from "./search.ts"

const cfg = parseConfig({ apiKey: "k", userId: "u1" })

/** Minimal stand-in for the SDK's APIError (status + Headers). */
function apiError(status: number, headers?: Record<string, string>) {
  const err = new Error(`${status} error`) as Error & {
    status: number
    headers?: Headers
  }
  err.status = status
  if (headers) err.headers = new Headers(headers)
  return err
}

function toolWith(searchRaw: () => Promise<unknown>) {
  const client = { async searchRaw() { return searchRaw() } } as unknown as HyperspellClient
  return createSearchToolFactory(client, cfg)({})
}

async function runText(tool: ReturnType<ReturnType<typeof createSearchToolFactory>>) {
  const res = await tool.execute("call-1", { query: "anything" })
  return (res.content[0] as { text: string }).text
}

test("search tool — a 429/Retry-After surfaces an explicit throttle, not 'no memories'", async () => {
  const tool = toolWith(() => Promise.reject(apiError(429, { "retry-after": "55" })))
  const text = await runText(tool)
  assert.match(text, /rate-limited/)
  assert.match(text, /~55s/)
  assert.match(text, /NOT an empty memory/)
  assert.doesNotMatch(text, /No relevant memories found/)
})

test("search tool — a transient 5xx says it is not an empty memory", async () => {
  const tool = toolWith(() => Promise.reject(apiError(500)))
  const text = await runText(tool)
  assert.match(text, /transient backend error/)
  assert.match(text, /NOT an empty memory/)
})

test("search tool — a 4xx surfaces the raw failure (no throttle framing)", async () => {
  const tool = toolWith(() => Promise.reject(apiError(422)))
  const text = await runText(tool)
  assert.match(text, /Search failed:/)
  assert.doesNotMatch(text, /rate-limited/)
})

test("search tool — an empty result set still reports no memories (not an error)", async () => {
  const tool = toolWith(() => Promise.resolve({ documents: [] }))
  const text = await runText(tool)
  assert.match(text, /No relevant memories found/)
})
