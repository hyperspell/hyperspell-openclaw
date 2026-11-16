import assert from "node:assert/strict"
import { test } from "node:test"
import { initLogger, log } from "./logger.ts"

type Captured = { info: string[]; debug: string[] }

function capture(): { logger: Parameters<typeof initLogger>[0]; seen: Captured } {
  const seen: Captured = { info: [], debug: [] }
  return {
    logger: {
      info: (msg: string) => seen.info.push(msg),
      warn: () => {},
      error: () => {},
      debug: (msg: string) => seen.debug.push(msg),
    },
    seen,
  }
}

// log.diag exists so operator-meaningful one-line diagnostics survive the host
// dropping the plugin debug channel from gateway.log (issue #118): with the
// plugin's own debug flag on, they must go out via INFO — never debug.
test("log.diag — emits via the info channel when debug is enabled", () => {
  const { logger, seen } = capture()
  initLogger(logger, true)
  try {
    log.diag("auto-context: cut 2 of 5 candidates")
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(seen.info, ["hyperspell: auto-context: cut 2 of 5 candidates"])
  assert.deepEqual(seen.debug, [], "diag never touches the debug channel")
})

test("log.diag — fully silent when debug is disabled", () => {
  const { logger, seen } = capture()
  initLogger(logger, false)
  try {
    log.diag("auto-context: cut 2 of 5 candidates")
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(seen.info, [])
  assert.deepEqual(seen.debug, [])
})

// The host logger's contract is (message: string) only, so anything passed
// after the message is dropped. The reason for a failure has to be in the line.
test("log.error — folds a caught error's message into the line the host receives", () => {
  const lines: unknown[][] = []
  initLogger({ info: () => {}, warn: () => {}, debug: () => {}, error: (...a: unknown[]) => lines.push(a) }, false)
  try {
    log.error("emotional-state store failed", new Error("POST /emotional-state failed (422): too long"))
    log.error("no detail")
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(lines, [
    ["hyperspell: emotional-state store failed: POST /emotional-state failed (422): too long"],
    ["hyperspell: no detail"],
  ])
})

test("log.warn — non-Error details are stringified, never thrown on", () => {
  const lines: string[] = []
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  initLogger({ info: () => {}, error: () => {}, debug: () => {}, warn: (m: string) => lines.push(m) }, false)
  try {
    log.warn("sync skipped", "disk full", { code: 28 }, cyclic)
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(lines, ['hyperspell: sync skipped: disk full {"code":28} [object Object]'])
})

test("log.error — a long detail is cut, so an echoed request body cannot flood the log", () => {
  const lines: string[] = []
  initLogger({ info: () => {}, warn: () => {}, debug: () => {}, error: (m: string) => lines.push(m) }, false)
  try {
    log.error("store failed", new Error(`(422): ${"t".repeat(700_000)}`))
  } finally {
    initLogger(console, false)
  }
  assert.ok(lines[0].startsWith("hyperspell: store failed: (422): ttt"))
  assert.ok(lines[0].endsWith("… (700007 chars)"))
  assert.ok(lines[0].length < 600)
})
