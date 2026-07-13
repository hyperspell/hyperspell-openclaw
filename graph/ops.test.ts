import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import type { HyperspellClient } from "../client.ts"
import { parseConfig } from "../config.ts"
import { isEntityFileMemory, scanMemories } from "./ops.ts"
import { NetworkStateManager } from "./state.ts"

type FakeMemory = {
  resourceId: string
  source: string
  title: string | null
  metadata: Record<string, unknown>
}

// Fake client: serves the same memory list to every userId and records which
// userIds were scanned, so tests can assert the multiUser fan-out.
function makeClient(memories: FakeMemory[]) {
  const scannedUserIds: Array<string | undefined> = []
  const client = {
    async *listMemories(options?: { userId?: string }) {
      scannedUserIds.push(options?.userId)
      yield* memories
    },
    async getMemory() {
      return { data: [], participants: [] }
    },
  }
  return { client: client as unknown as HyperspellClient, scannedUserIds }
}

function tmpWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-ops-"))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const singleUserCfg = parseConfig({ apiKey: "test-key", userId: "u1" })

function completed(
  resourceId: string,
  metadata: Record<string, unknown> = {},
): FakeMemory {
  return {
    resourceId,
    source: "vault",
    title: resourceId,
    metadata: { status: "completed", ...metadata },
  }
}

// ---------------------------------------------------------------------------
// isEntityFileMemory
// ---------------------------------------------------------------------------

test("isEntityFileMemory — graph_entity metadata marks entity records (string and boolean)", () => {
  assert.equal(isEntityFileMemory({ graph_entity: "true" }), true)
  assert.equal(isEntityFileMemory({ graph_entity: true }), true)
  assert.equal(isEntityFileMemory({}), false)
  assert.equal(isEntityFileMemory(undefined), false)
})

test("isEntityFileMemory — entity-directory file_path marks records synced before propagation", () => {
  for (const type of ["people", "projects", "organizations", "topics"]) {
    assert.equal(
      isEntityFileMemory({ file_path: `/ws/memory/${type}/alice-chen.md` }),
      true,
      type,
    )
  }
  // Ordinary memory files are NOT entity files — the guard must stay narrow.
  assert.equal(isEntityFileMemory({ file_path: "/ws/memory/note.md" }), false)
  assert.equal(isEntityFileMemory({ file_path: "/ws/memory/journal/people.md" }), false)
})

// ---------------------------------------------------------------------------
// scanMemories — self-scan loop guard (proposal/06 §3.3)
// ---------------------------------------------------------------------------

test("scanMemories — entity-derived records are skipped, source memories are not", async () => {
  const ws = tmpWorkspace()
  try {
    const { client } = makeClient([
      // Synced entity section WITH propagated frontmatter metadata.
      completed("entity-tagged", {
        openclaw_source: "memory_sync_section",
        graph_entity: "true",
        file_path: "/ws/memory/people/alice-chen.md",
      }),
      // Synced entity section from BEFORE the propagation fix: no
      // graph_entity metadata, only the entity-directory path.
      completed("entity-legacy", {
        openclaw_source: "memory_sync_section",
        file_path: "/ws/memory/projects/memory-network.md",
      }),
      completed("real-source-memory"),
    ])
    const stateManager = new NetworkStateManager(ws.dir)

    const scanned = await scanMemories(client, stateManager, 20, singleUserCfg)
    assert.deepEqual(
      scanned.map((m) => m.resourceId),
      ["real-source-memory"],
    )
  } finally {
    ws.cleanup()
  }
})

test("scanMemories — processed and non-completed records are still skipped", async () => {
  const ws = tmpWorkspace()
  try {
    const { client } = makeClient([
      completed("already-done"),
      { resourceId: "pending", source: "vault", title: null, metadata: { status: "pending" } },
      completed("fresh"),
    ])
    const stateManager = new NetworkStateManager(ws.dir)
    stateManager.markProcessed(["already-done"])

    const scanned = await scanMemories(client, stateManager, 20, singleUserCfg)
    assert.deepEqual(
      scanned.map((m) => m.resourceId),
      ["fresh"],
    )
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// scanMemories — multiUser fan-out (the CLI bypass fixed in this PR)
// ---------------------------------------------------------------------------

test("scanMemories — multiUser config fans out over every mapped user id plus shared", async () => {
  const ws = tmpWorkspace()
  try {
    const cfg = parseConfig({
      apiKey: "test-key",
      multiUser: {
        senderMap: {
          "alice-phone": { userId: "alice", name: "Alice" },
          "bob-phone": { userId: "bob", name: "Bob" },
        },
        sharedUserId: "shared",
      },
    })
    const { client, scannedUserIds } = makeClient([])
    const stateManager = new NetworkStateManager(ws.dir)

    await scanMemories(client, stateManager, 20, cfg)
    assert.deepEqual(scannedUserIds.sort(), ["alice", "bob", "shared"])
  } finally {
    ws.cleanup()
  }
})

test("scanMemories — single-user install without a userId scans the default identity", async () => {
  const ws = tmpWorkspace()
  try {
    const cfg = parseConfig({ apiKey: "test-key" })
    const { client, scannedUserIds } = makeClient([completed("m1")])
    const stateManager = new NetworkStateManager(ws.dir)

    const scanned = await scanMemories(client, stateManager, 20, cfg)
    assert.deepEqual(scannedUserIds, [undefined])
    assert.deepEqual(
      scanned.map((m) => m.resourceId),
      ["m1"],
    )
  } finally {
    ws.cleanup()
  }
})
