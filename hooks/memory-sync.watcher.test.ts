import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { buildMemorySyncWatcher } from "./memory-sync.ts"
import { parseConfig } from "../config.ts"

// buildMemorySyncWatcher resolves roots via getWorkspaceDir(), which reads the
// workspace out of an OpenClaw config file; point OPENCLAW_CONFIG_PATH at a
// temp config so the watcher runs against a scratch workspace.

let tmpDir: string
let workspaceDir: string
let prevConfigPath: string | undefined

function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({ apiKey: "hs-test", syncMemories: true, ...overrides })
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Write until the watcher reports the event. fs.watch arms asynchronously
 * (recursive watches use FSEvents on macOS, which has both an arming delay and
 * a coalescing latency), so a single write racing start() is silently missed
 * under load. Re-touching is what makes this test load-independent.
 */
async function writeUntilSeen(
  target: string,
  body: string,
  seen: () => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (!seen()) {
    if (Date.now() > deadline) throw new Error(`watcher never reported ${target}`)
    fs.writeFileSync(target, `${body}\n<!-- ${attempt++} -->`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-watch-"))
  workspaceDir = path.join(tmpDir, "workspace")
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true })
  const configPath = path.join(tmpDir, "openclaw.json")
  fs.writeFileSync(
    configPath,
    JSON.stringify({ agents: { defaults: { workspace: workspaceDir } } }),
  )
  prevConfigPath = process.env.OPENCLAW_CONFIG_PATH
  process.env.OPENCLAW_CONFIG_PATH = configPath
})

afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH
  else process.env.OPENCLAW_CONFIG_PATH = prevConfigPath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test("watcher fires for files created under memory/", async () => {
  const seen: string[] = []
  const watcher = buildMemorySyncWatcher(makeConfig(), (event) => {
    seen.push(event.file_path)
  })
  watcher.start()
  try {
    const target = path.join(workspaceDir, "memory", "note.md")
    await writeUntilSeen(target, "# hello", () => seen.includes(target))
  } finally {
    watcher.stop()
  }
})

test("watcher covers configured watchPaths roots", async () => {
  const extraDir = path.join(tmpDir, "notes")
  fs.mkdirSync(extraDir, { recursive: true })
  const seen: string[] = []
  const watcher = buildMemorySyncWatcher(
    makeConfig({ syncMemories: { watchPaths: [extraDir] } }),
    (event) => {
      seen.push(event.file_path)
    },
  )
  watcher.start()
  try {
    const target = path.join(extraDir, "extra.md")
    await writeUntilSeen(target, "# extra", () => seen.includes(target))
  } finally {
    watcher.stop()
  }
})

test("stop() ends delivery and missing roots are skipped without throwing", async () => {
  const seen: string[] = []
  const watcher = buildMemorySyncWatcher(
    makeConfig({
      syncMemories: { watchPaths: [path.join(tmpDir, "does-not-exist")] },
    }),
    (event) => {
      seen.push(event.file_path)
    },
  )
  watcher.start()
  watcher.stop()
  fs.writeFileSync(path.join(workspaceDir, "memory", "after-stop.md"), "# late")
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(seen.length, 0)
})
