import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import type { HyperspellClient } from "../client.ts"
import {
  dedupeTitles,
  fileKey,
  getMemoryFiles,
  getSyncableFiles,
  loadManifest,
  parseMarkdownSections,
  resolveSyncSource,
  saveManifest,
  syncAllFilesSectionized,
  syncMarkdownFile,
  syncMarkdownFileSectionized,
  withSyncLock,
} from "./markdown.ts"

// Bodies must exceed the 80-char short-section merge threshold so each ##
// stays its own section.
const BODY_A =
  "Section A body — long enough to clear the eighty character merge threshold for sure."
const BODY_A2 =
  "Section A REWRITTEN — still well past the eighty character threshold so it stays a section."
const BODY_B =
  "Section B body — also comfortably over the eighty character short-merge threshold here."

// ---------------------------------------------------------------------------
// parseMarkdownSections
// ---------------------------------------------------------------------------

test("parseMarkdownSections — splits on ## headings", () => {
  const sections = parseMarkdownSections(`## A\n${BODY_A}\n## B\n${BODY_B}`, "note")
  assert.equal(sections.length, 2)
  assert.deepEqual(
    sections.map((s) => s.title),
    ["A", "B"],
  )
  assert.equal(sections[0].content, BODY_A)
  assert.equal(sections[1].content, BODY_B)
  // 16-hex content hash
  assert.match(sections[0].contentHash, /^[0-9a-f]{16}$/)
})

test("parseMarkdownSections — short trailing section merges into previous", () => {
  const content = [
    "# 2026-05-09 — Saturday",
    "",
    "## The day David's mum got sick",
    BODY_A,
    "",
    "## What I'm holding",
    BODY_B,
    "",
    "## Short note",
    "🖤",
  ].join("\n")

  const sections = parseMarkdownSections(content, "note")
  assert.equal(sections.length, 2)
  assert.deepEqual(
    sections.map((s) => s.title),
    ["The day David's mum got sick", "What I'm holding"],
  )
  // The < 80-char "Short note" folds into the previous section.
  assert.match(sections[1].content, /### Short note/)
  assert.match(sections[1].content, /🖤/)
})

test("parseMarkdownSections — empty/whitespace content yields no sections", () => {
  assert.deepEqual(parseMarkdownSections("", "note"), [])
  assert.deepEqual(parseMarkdownSections("   \n\n  ", "note"), [])
})

test("parseMarkdownSections — content hash is stable and change-sensitive", () => {
  const a = parseMarkdownSections(`## A\n${BODY_A}`, "note")[0]
  const aAgain = parseMarkdownSections(`## A\n${BODY_A}`, "note")[0]
  const aEdited = parseMarkdownSections(`## A\n${BODY_A2}`, "note")[0]
  assert.equal(a.contentHash, aAgain.contentHash)
  assert.notEqual(a.contentHash, aEdited.contentHash)
})

test("parseMarkdownSections — '# ' line inside a section is content, not the file title", () => {
  const content = `## A\n# This is body text, not a file title — and well over eighty chars long.\n${BODY_A}\n## B\n${BODY_B}`
  const sections = parseMarkdownSections(content, "note")
  assert.deepEqual(
    sections.map((s) => s.title),
    ["A", "B"],
  )
  // The '# ' line must be preserved in section A, not swallowed as a title.
  assert.match(sections[0].content, /# This is body text, not a file title/)
})

// ---------------------------------------------------------------------------
// dedupeTitles
// ---------------------------------------------------------------------------

test("dedupeTitles — disambiguates repeated section titles", () => {
  const parsed = parseMarkdownSections(`## Dup\n${BODY_A}\n## Dup\n${BODY_B}`, "note")
  const deduped = dedupeTitles(parsed)
  assert.deepEqual(
    deduped.map((s) => s.title),
    ["Dup", "Dup (2)"],
  )
})

// ---------------------------------------------------------------------------
// fileKey — workspace-relative, posix-normalized, portable
// ---------------------------------------------------------------------------

test("fileKey — relative to workspace, never absolute", () => {
  assert.equal(fileKey("/ws", "/ws/memory/2026-05-09.md"), "memory/2026-05-09.md")
  assert.equal(fileKey("/ws", "/ws/MEMORY.md"), "MEMORY.md")
})

test("fileKey — files outside the workspace stay deterministic", () => {
  assert.equal(fileKey("/ws/sub", "/ws/other.md"), "../other.md")
})

// ---------------------------------------------------------------------------
// loadManifest / saveManifest — self-healing + roundtrip
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-sync-"))
}

// ---------------------------------------------------------------------------
// getMemoryFiles / getSyncableFiles — ignore dot-dirs + configured paths
// ---------------------------------------------------------------------------

function seedMemoryTree(ws: string): void {
  const mem = path.join(ws, "memory")
  fs.mkdirSync(path.join(mem, ".dreams"), { recursive: true })
  fs.mkdirSync(path.join(mem, "dreaming", "rem"), { recursive: true })
  fs.mkdirSync(path.join(mem, "topics"), { recursive: true })
  fs.writeFileSync(path.join(mem, "2026-06-19.md"), "# Real memory\n")
  fs.writeFileSync(path.join(mem, "topics", "work.md"), "# Nested real memory\n")
  fs.writeFileSync(path.join(mem, ".dreams", "2026-06-14.md"), "# Dream\n")
  fs.writeFileSync(path.join(mem, "dreaming", "rem", "2026-06-14.md"), "# REM\n")
}

test("getMemoryFiles — skips .dreams (dot-dir) and dreaming/ by default", () => {
  const ws = tmpDir()
  seedMemoryTree(ws)
  const got = getMemoryFiles(ws).map((f) => fileKey(ws, f)).sort()
  assert.deepEqual(got, ["memory/2026-06-19.md", "memory/topics/work.md"])
})

test("getMemoryFiles — dot-dirs stay excluded even when ignorePaths is emptied", () => {
  const ws = tmpDir()
  seedMemoryTree(ws)
  // Empty list re-enables dreaming/, but dot-directories are ALWAYS skipped.
  const got = getMemoryFiles(ws, []).map((f) => fileKey(ws, f)).sort()
  assert.deepEqual(got, [
    "memory/2026-06-19.md",
    "memory/dreaming/rem/2026-06-14.md",
    "memory/topics/work.md",
  ])
})

test("getSyncableFiles — applies the same ignore to walked watchPaths", () => {
  const ws = tmpDir()
  seedMemoryTree(ws)
  const extra = path.join(ws, "extra")
  fs.mkdirSync(path.join(extra, "dreaming"), { recursive: true })
  fs.mkdirSync(path.join(extra, ".hidden"), { recursive: true })
  fs.writeFileSync(path.join(extra, "keep.md"), "# Keep\n")
  fs.writeFileSync(path.join(extra, "dreaming", "drop.md"), "# Drop\n")
  fs.writeFileSync(path.join(extra, ".hidden", "drop.md"), "# Drop\n")
  const got = getSyncableFiles(ws, [{ path: extra }]).map((f) => fileKey(ws, f)).sort()
  assert.deepEqual(got, [
    "extra/keep.md",
    "memory/2026-06-19.md",
    "memory/topics/work.md",
  ])
})

test("getSyncableFiles — watchPath overlapping memory/ does not duplicate files", () => {
  const ws = tmpDir()
  seedMemoryTree(ws)
  const got = getSyncableFiles(ws, [{ path: "memory/topics" }]).map((f) => fileKey(ws, f))
  assert.deepEqual(got.sort(), ["memory/2026-06-19.md", "memory/topics/work.md"])
})

// ---------------------------------------------------------------------------
// resolveSyncSource — provenance labels
// ---------------------------------------------------------------------------

test("resolveSyncSource — memory/ file resolves to \"memory\"", () => {
  const ws = "/ws"
  assert.equal(resolveSyncSource("/ws/memory/note.md", ws, []), "memory")
})

test("resolveSyncSource — labeled watchPath wins over its slug", () => {
  const got = resolveSyncSource("/ws/notes/brainstem/2026-07-06.md", "/ws", [
    { path: "notes/brainstem", source: "brainstem_daily" },
  ])
  assert.equal(got, "brainstem_daily")
})

test("resolveSyncSource — unlabeled watchPath derives a slug", () => {
  const got = resolveSyncSource("/ws/notes/brainstem/2026-07-06.md", "/ws", [
    { path: "notes/brainstem" },
  ])
  assert.equal(got, "notes_brainstem")
})

test("resolveSyncSource — longest-prefix watchPath beats a shorter one", () => {
  const got = resolveSyncSource("/ws/notes/brainstem/2026-07-06.md", "/ws", [
    { path: "notes", source: "notes" },
    { path: "notes/brainstem", source: "brainstem_daily" },
  ])
  assert.equal(got, "brainstem_daily")
})

test("resolveSyncSource — watchPath nested in memory/ beats the memory label", () => {
  const got = resolveSyncSource("/ws/memory/generated/x.md", "/ws", [
    { path: "memory/generated", source: "generated" },
  ])
  assert.equal(got, "generated")
})

test("resolveSyncSource — unmatched file resolves to undefined", () => {
  assert.equal(resolveSyncSource("/ws/other/x.md", "/ws", [{ path: "notes" }]), undefined)
})

test("loadManifest — missing file returns empty manifest", () => {
  const dir = tmpDir()
  try {
    assert.deepEqual(loadManifest(dir), { version: 1, files: {} })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("loadManifest — unusable shapes self-heal to empty", () => {
  const dir = tmpDir()
  const p = path.join(dir, ".hyperspell-sync-hashes.json")
  try {
    // Legacy flat shape: no `files` key -> unusable -> empty.
    fs.writeFileSync(p, '{"/abs/file.md::A":{"hash":"x","resourceId":"r"}}')
    assert.deepEqual(loadManifest(dir), { version: 1, files: {} })

    // Corrupt JSON -> empty.
    fs.writeFileSync(p, "not json at all {")
    assert.deepEqual(loadManifest(dir), { version: 1, files: {} })

    // `files` present but null -> unusable -> empty.
    fs.writeFileSync(p, '{"version":1,"files":null}')
    assert.deepEqual(loadManifest(dir), { version: 1, files: {} })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("loadManifest — version mismatch with valid files is forward-migrated, not discarded", () => {
  const dir = tmpDir()
  const p = path.join(dir, ".hyperspell-sync-hashes.json")
  try {
    // A future/older version but a structurally valid files map must be
    // preserved — discarding it would force a full re-ingest, the exact
    // load this guard exists to prevent.
    const files = { "memory/n.md": { sections: { A: { hash: "h", resourceId: "r" } } } }
    fs.writeFileSync(p, JSON.stringify({ version: 99, files }))
    assert.deepEqual(loadManifest(dir), { version: 1, files })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("saveManifest/loadManifest — roundtrip", () => {
  const dir = tmpDir()
  try {
    const manifest = {
      version: 1,
      files: { "memory/n.md": { sections: { A: { hash: "h", resourceId: "r" } } } },
    }
    saveManifest(dir, manifest)
    assert.deepEqual(loadManifest(dir), manifest)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// withSyncLock — process-wide serialization
// ---------------------------------------------------------------------------

test("withSyncLock — serializes overlapping operations (no interleave)", async () => {
  const events: string[] = []
  const task = (id: number) =>
    withSyncLock(async () => {
      events.push(`s${id}`)
      await new Promise((r) => setTimeout(r, 5))
      events.push(`e${id}`)
    })
  await Promise.all([task(1), task(2), task(3)])
  assert.deepEqual(events, ["s1", "e1", "s2", "e2", "s3", "e3"])
})

test("withSyncLock — a rejecting op does not wedge the chain", async () => {
  await assert.rejects(
    withSyncLock(async () => {
      throw new Error("nope")
    }),
    /nope/,
  )
  const events: string[] = []
  await withSyncLock(async () => {
    events.push("ran")
  })
  assert.deepEqual(events, ["ran"])
})

// ---------------------------------------------------------------------------
// syncMarkdownFileSectionized — incremental, rename, orphan, failure
// ---------------------------------------------------------------------------

type AddOptions = {
  resourceId?: string
  title?: string
  metadata?: Record<string, unknown>
}

function makeClient(opts?: { failAddOn?: (text: string) => boolean; deleteOk?: boolean }) {
  const addCalls: Array<{ text: string; options: AddOptions }> = []
  const deleteCalls: string[] = []
  let counter = 0
  const client = {
    async addMemory(text: string, options?: AddOptions) {
      addCalls.push({ text, options: options ?? {} })
      if (opts?.failAddOn?.(text)) throw new Error("addMemory boom")
      return { resourceId: options?.resourceId ?? `res-${++counter}` }
    },
    async deleteMemory(resourceId: string) {
      deleteCalls.push(resourceId)
      return { deleted: opts?.deleteOk ?? true }
    },
  }
  return { client: client as unknown as HyperspellClient, addCalls, deleteCalls }
}

function workspace(): { dir: string; note: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-sync-"))
  fs.mkdirSync(path.join(dir, "memory"))
  return {
    dir,
    note: path.join(dir, "memory", "note.md"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test("syncMarkdownFileSectionized — first sync uploads every section, manifest keyed relative", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.synced, 2)
    assert.equal(r.skipped, 0)
    assert.equal(r.removed, 0)
    assert.equal(addCalls.length, 2)

    const manifest = loadManifest(ws.dir)
    assert.deepEqual(Object.keys(manifest.files), ["memory/note.md"])
    assert.deepEqual(
      Object.keys(manifest.files["memory/note.md"].sections).sort(),
      ["A", "B"],
    )
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — unchanged re-sync skips everything (no uploads)", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    const afterFirst = addCalls.length

    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    assert.equal(r.synced, 0)
    assert.equal(r.skipped, 2)
    assert.equal(addCalls.length, afterFirst) // no further uploads
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — edited section upserts under the same resourceId", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    const base = addCalls.length

    fs.writeFileSync(ws.note, `## A\n${BODY_A2}\n## B\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.synced, 1)
    assert.equal(r.skipped, 1)
    const reupload = addCalls.slice(base)
    assert.equal(reupload.length, 1)
    assert.equal(reupload[0].options.resourceId, "res-1") // reused, not new
    assert.match(reupload[0].options.title ?? "", /A$/)

    // Third sync with no change proves the new hash persisted.
    const r3 = await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    assert.equal(r3.synced, 0)
    assert.equal(r3.skipped, 2)
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — renamed heading reuses resource, no duplicate, no orphan", async () => {
  const ws = workspace()
  const { client, addCalls, deleteCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    const base = addCalls.length

    // Rename "A" -> "C", body byte-identical.
    fs.writeFileSync(ws.note, `## C\n${BODY_A}\n## B\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.synced, 1) // the rename, updated in place
    assert.equal(r.skipped, 1) // B untouched
    assert.equal(r.removed, 0)
    assert.equal(deleteCalls.length, 0) // not treated as a deletion

    const reupload = addCalls.slice(base)
    assert.equal(reupload.length, 1)
    assert.equal(reupload[0].options.resourceId, "res-1") // reclaimed
    assert.match(reupload[0].options.title ?? "", /C$/)

    const sections = loadManifest(ws.dir).files["memory/note.md"].sections
    assert.deepEqual(Object.keys(sections).sort(), ["B", "C"]) // "A" gone
    assert.equal(sections.C.resourceId, "res-1")
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — deleted section is removed remotely and pruned", async () => {
  const ws = workspace()
  const { client, deleteCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    fs.writeFileSync(ws.note, `## A\n${BODY_A}`) // B deleted
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.removed, 1)
    assert.equal(r.synced, 0)
    assert.equal(r.skipped, 1)
    assert.deepEqual(deleteCalls, ["res-2"])

    const sections = loadManifest(ws.dir).files["memory/note.md"].sections
    assert.deepEqual(Object.keys(sections), ["A"])
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — failed orphan delete counts as failed and retries", async () => {
  const ws = workspace()
  try {
    const ok = makeClient()
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(ok.client, ws.note, ws.dir)

    const failing = makeClient({ deleteOk: false })
    fs.writeFileSync(ws.note, `## A\n${BODY_A}`) // B deleted, but delete will fail
    const r = await syncMarkdownFileSectionized(failing.client, ws.note, ws.dir)

    assert.equal(r.removed, 0)
    assert.equal(r.failed, 1) // delete failure is now counted
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /delete "B": failed/)

    // B's record is retained so the delete is retried next run.
    const sections = loadManifest(ws.dir).files["memory/note.md"].sections
    assert.deepEqual(Object.keys(sections).sort(), ["A", "B"])
    assert.equal(sections.B.resourceId, "res-2")

    const retry = makeClient() // delete succeeds this time
    const r2 = await syncMarkdownFileSectionized(retry.client, ws.note, ws.dir)
    assert.equal(r2.removed, 1)
    assert.deepEqual(retry.deleteCalls, ["res-2"])
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — duplicate ## titles become distinct memories", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## Dup\n${BODY_A}\n## Dup\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.synced, 2)
    const titles = addCalls.map((c) => c.options.title)
    assert.match(titles[0] ?? "", /Dup$/)
    assert.match(titles[1] ?? "", /Dup \(2\)$/)

    const sections = loadManifest(ws.dir).files["memory/note.md"].sections
    assert.deepEqual(Object.keys(sections).sort(), ["Dup", "Dup (2)"])
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — failed upload preserves resourceId (no duplicate next run)", async () => {
  const ws = workspace()
  try {
    const first = makeClient()
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    await syncMarkdownFileSectionized(first.client, ws.note, ws.dir)

    // Edit A; this client throws on the new A content.
    const failing = makeClient({ failAddOn: (t) => t === BODY_A2 })
    fs.writeFileSync(ws.note, `## A\n${BODY_A2}\n## B\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(failing.client, ws.note, ws.dir)

    assert.equal(r.failed, 1)
    assert.equal(r.synced, 0)
    assert.equal(r.skipped, 1)
    assert.equal(r.errors.length, 1)

    // Prior record (resourceId) survived the transient failure.
    const sections = loadManifest(ws.dir).files["memory/note.md"].sections
    assert.equal(sections.A.resourceId, "res-1")

    // Recovery run reuses res-1 instead of minting a duplicate.
    const recover = makeClient()
    const r2 = await syncMarkdownFileSectionized(recover.client, ws.note, ws.dir)
    assert.equal(r2.synced, 1)
    assert.equal(recover.addCalls[0].options.resourceId, "res-1")
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// syncAllFilesSectionized — age pre-filter
// ---------------------------------------------------------------------------

test("syncAllFilesSectionized — old + already-manifested file is skipped (aged out)", async () => {
  const ws = workspace()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)

    // First pass with no cutoff: ingests and records in the manifest.
    const first = makeClient()
    const r1 = await syncAllFilesSectionized(first.client, ws.dir, { maxAgeDays: 0 })
    assert.equal(r1.synced, 2)
    assert.equal(r1.agedOut, 0)

    // Backdate the file well past the cutoff.
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    fs.utimesSync(ws.note, old, old)

    // Second pass with a 30d cutoff: file is known + stale -> not even read.
    const second = makeClient()
    const r2 = await syncAllFilesSectionized(second.client, ws.dir, { maxAgeDays: 30 })
    assert.equal(r2.agedOut, 1)
    assert.equal(r2.synced, 0)
    assert.equal(r2.skipped, 0)
    assert.equal(second.addCalls.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("syncAllFilesSectionized — old but NOT-yet-manifested file still syncs once", async () => {
  const ws = workspace()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    fs.utimesSync(ws.note, old, old)

    // Cold manifest: age cutoff must not strand never-ingested content.
    const { client, addCalls } = makeClient()
    const r = await syncAllFilesSectionized(client, ws.dir, { maxAgeDays: 30 })
    assert.equal(r.agedOut, 0)
    assert.equal(r.synced, 2)
    assert.equal(addCalls.length, 2)
  } finally {
    ws.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Provenance metadata (openclaw_sync_source)
// ---------------------------------------------------------------------------

test("syncMarkdownFileSectionized — syncSource stamps openclaw_sync_source on every section", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}\n## B\n${BODY_B}`)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir, {
      syncSource: "brainstem_daily",
    })

    assert.equal(r.synced, 2)
    assert.equal(addCalls.length, 2)
    for (const call of addCalls) {
      assert.equal(call.options.metadata?.openclaw_sync_source, "brainstem_daily")
      // Pipeline discriminator untouched — retrieval filters depend on it.
      assert.equal(call.options.metadata?.openclaw_source, "memory_sync_section")
    }
// graph_entity frontmatter propagation (Memory Network self-scan loop guard)
// ---------------------------------------------------------------------------

type CapturedMetadata = { metadata?: Record<string, unknown> }

const ENTITY_FILE = [
  "---",
  "title: Alice Chen",
  "type: person",
  "graph_entity: true",
  "---",
  "# Alice Chen",
  "",
  BODY_A,
].join("\n")

test("syncMarkdownFileSectionized — graph_entity frontmatter lands in every section's metadata", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, ENTITY_FILE)
    const r = await syncMarkdownFileSectionized(client, ws.note, ws.dir)

    assert.equal(r.synced, 1)
    const metadata = (addCalls[0].options as CapturedMetadata).metadata
    assert.equal(metadata?.graph_entity, "true")
  } finally {
    ws.cleanup()
  }
})

test("syncMarkdownFileSectionized — no syncSource means no openclaw_sync_source key", async () => {
test("syncMarkdownFileSectionized — ordinary files get no graph_entity metadata", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, `## A\n${BODY_A}`)
    await syncMarkdownFileSectionized(client, ws.note, ws.dir)
    assert.equal(addCalls.length, 1)
    assert.equal("openclaw_sync_source" in (addCalls[0].options.metadata ?? {}), false)

    const metadata = (addCalls[0].options as CapturedMetadata).metadata
    assert.equal(metadata?.graph_entity, undefined)
  } finally {
    ws.cleanup()
  }
})

test("syncAllFilesSectionized — mixed memory/ + watchPath fixture tags each origin", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.mkdirSync(path.join(ws.dir, "notes", "brainstem"), { recursive: true })
    const daily = path.join(ws.dir, "notes", "brainstem", "2026-07-06.md")
    fs.writeFileSync(daily, `## Consolidation\n${BODY_A}`)
    fs.writeFileSync(ws.note, `## Curated\n${BODY_B}`)

    const r = await syncAllFilesSectionized(client, ws.dir, {
      watchPaths: [{ path: "notes/brainstem", source: "brainstem_daily" }],
    })

    assert.equal(r.synced, 2)
    const byFile = new Map(
      addCalls.map((c) => [c.options.metadata?.file_path, c.options.metadata]),
    )
    assert.equal(byFile.get(daily)?.openclaw_sync_source, "brainstem_daily")
    assert.equal(byFile.get(ws.note)?.openclaw_sync_source, "memory")
  } finally {
    ws.cleanup()
  }
})

test("syncAllFilesSectionized — dot-dir under a watchPath is excluded from the walk", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.mkdirSync(path.join(ws.dir, "notes", "brainstem", ".drafts"), { recursive: true })
    fs.writeFileSync(
      path.join(ws.dir, "notes", "brainstem", ".drafts", "wip.md"),
      `## Draft\n${BODY_A}`,
    )
    fs.writeFileSync(
      path.join(ws.dir, "notes", "brainstem", "2026-07-06.md"),
      `## Consolidation\n${BODY_B}`,
    )

    const r = await syncAllFilesSectionized(client, ws.dir, {
      watchPaths: [{ path: "notes/brainstem", source: "brainstem_daily" }],
    })

    assert.equal(r.synced, 1)
    assert.equal(addCalls.length, 1)
    assert.match(String(addCalls[0].options.metadata?.file_path), /2026-07-06\.md$/)
test("syncMarkdownFile (legacy whole-file) — graph_entity frontmatter lands in metadata", async () => {
  const ws = workspace()
  const { client, addCalls } = makeClient()
  try {
    fs.writeFileSync(ws.note, ENTITY_FILE)
    const r = await syncMarkdownFile(client, ws.note)

    assert.equal(r.success, true)
    const metadata = (addCalls[0].options as CapturedMetadata).metadata
    assert.equal(metadata?.graph_entity, "true")
  } finally {
    ws.cleanup()
  }
})
