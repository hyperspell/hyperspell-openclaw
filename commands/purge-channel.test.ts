import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { HyperspellClient } from "../client.ts"
import {
  deleteMatches,
  findChannelMemories,
  formatMatchTable,
  type PurgeMatch,
} from "./purge-channel.ts"

type Listed = {
  resourceId: string
  source: string
  title: string | null
  metadata: Record<string, unknown>
}

function makeClient(memoriesBySource: Record<string, Listed[]>) {
  const listCalls: Array<Record<string, unknown> | undefined> = []
  const deleteCalls: Array<{ resourceId: string; options?: Record<string, unknown> }> = []
  const client = {
    async *listMemories(options?: { source?: string; userId?: string }) {
      listCalls.push(options)
      for (const m of memoriesBySource[options?.source ?? ""] ?? []) yield m
    },
    async deleteMemory(resourceId: string, options?: Record<string, unknown>) {
      deleteCalls.push({ resourceId, options })
      // Mirrors the real client: 404 is already mapped to {deleted:true}, so
      // {deleted:false} means a genuine failure.
      return { deleted: !resourceId.startsWith("fail-") }
    },
  } as unknown as HyperspellClient
  return { client, listCalls, deleteCalls }
}

describe("findChannelMemories", () => {
  it("matches exact and thread-suffixed channel tags, case-insensitively", async () => {
    const { client } = makeClient({
      vault: [
        { resourceId: "r1", source: "vault", title: "exact", metadata: { openclaw_channel_id: "chan-9" } },
        { resourceId: "r2", source: "vault", title: "thread", metadata: { openclaw_channel_id: "chan-9:thread:1" } },
        { resourceId: "r3", source: "vault", title: "case", metadata: { openclaw_channel_id: "CHAN-9" } },
        { resourceId: "r4", source: "vault", title: "other channel", metadata: { openclaw_channel_id: "chan-10" } },
        // Longer id sharing chan-9 as a bare prefix is a DIFFERENT channel.
        { resourceId: "r5", source: "vault", title: "prefix trap", metadata: { openclaw_channel_id: "chan-90" } },
        { resourceId: "r6", source: "vault", title: "untagged", metadata: {} },
        { resourceId: "r7", source: "vault", title: "non-string tag", metadata: { openclaw_channel_id: 9 } },
      ],
    })
    const matches = await findChannelMemories(client, "chan-9", { sources: ["vault"] })
    assert.deepEqual(
      matches.map((m) => [m.resourceId, m.via]),
      [
        ["r1", "channel_tag"],
        ["r2", "channel_tag"],
        ["r3", "channel_tag"],
      ],
    )
  })

  it("matches untagged rows by resourceId === session id (legacy hot-buffer identity)", async () => {
    const { client } = makeClient({
      vault: [
        { resourceId: "sess-legacy-1", source: "vault", title: "legacy", metadata: {} },
        { resourceId: "sess-other", source: "vault", title: "unrelated", metadata: {} },
      ],
    })
    const matches = await findChannelMemories(client, "chan-9", {
      sources: ["vault"],
      sessionIds: ["SESS-LEGACY-1"],
    })
    assert.deepEqual(
      matches.map((m) => [m.resourceId, m.via]),
      [["sess-legacy-1", "session_id"]],
    )
  })

  it("prefers channel_tag over session_id when both apply", async () => {
    const { client } = makeClient({
      vault: [
        {
          resourceId: "sess-1",
          source: "vault",
          title: "tagged",
          metadata: { openclaw_channel_id: "chan-9" },
        },
      ],
    })
    const matches = await findChannelMemories(client, "chan-9", {
      sources: ["vault"],
      sessionIds: ["sess-1"],
    })
    assert.equal(matches.length, 1)
    assert.equal(matches[0].via, "channel_tag")
  })

  it("scans each requested source with the right source/userId and performs no deletes", async () => {
    const { client, listCalls, deleteCalls } = makeClient({
      vault: [{ resourceId: "v1", source: "vault", title: null, metadata: { openclaw_channel_id: "chan-9" } }],
      notion: [],
    })
    const matches = await findChannelMemories(client, "chan-9", {
      sources: ["vault", "notion"],
      userId: "u1",
    })
    assert.deepEqual(listCalls, [
      { source: "vault", userId: "u1" },
      { source: "notion", userId: "u1" },
    ])
    assert.equal(matches.length, 1)
    // Discovery alone is the dry run — it must never delete anything.
    assert.equal(deleteCalls.length, 0)
  })
})

describe("deleteMatches", () => {
  const match = (resourceId: string): PurgeMatch => ({
    resourceId,
    source: "vault",
    title: null,
    via: "channel_tag",
  })

  it("deletes each match with its source/userId and counts deleted vs failed", async () => {
    const { client, deleteCalls } = makeClient({})
    const result = await deleteMatches(client, [match("r1"), match("fail-r2"), match("r3")], {
      userId: "u1",
    })
    assert.equal(result.deleted, 2)
    assert.equal(result.failed, 1)
    assert.equal(result.matched.length, 3)
    assert.deepEqual(deleteCalls, [
      { resourceId: "r1", options: { source: "vault", userId: "u1" } },
      { resourceId: "fail-r2", options: { source: "vault", userId: "u1" } },
      { resourceId: "r3", options: { source: "vault", userId: "u1" } },
    ])
  })

  it("handles an empty match list", async () => {
    const { client, deleteCalls } = makeClient({})
    const result = await deleteMatches(client, [], {})
    assert.deepEqual(result, { matched: [], deleted: 0, failed: 0 })
    assert.equal(deleteCalls.length, 0)
  })
})

describe("formatMatchTable", () => {
  it("renders aligned columns with a dash for missing titles", () => {
    const table = formatMatchTable([
      { resourceId: "r1", source: "vault", title: "Session with Bob", via: "channel_tag" },
      { resourceId: "sess-legacy-1", source: "vault", title: null, via: "session_id" },
    ])
    const lines = table.split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^RESOURCE ID\s{2,}SOURCE\s{2,}VIA\s{2,}TITLE$/)
    assert.match(lines[1], /^r1\s+vault\s+channel_tag\s+Session with Bob$/)
    assert.match(lines[2], /^sess-legacy-1\s+vault\s+session_id\s+-$/)
  })
})
