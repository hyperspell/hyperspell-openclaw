import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  COVERAGE_LOG_NAME,
  type CoverageEvent,
  flushCoverageLog,
  recordCoverageEvent,
} from "./coverage-log.ts"

function mkStateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-coverage-"))
}

function event(over?: Partial<CoverageEvent>): CoverageEvent {
  return {
    outcome: "empty",
    prompt: "what did we decide about the staging DB migration?",
    fetched: 0,
    candidates: 0,
    droppedCurrentSession: 0,
    topScore: null,
    rawTopScore: null,
    threshold: 0.6,
    ranking: true,
    shown: 0,
    shownChars: 0,
    sessionId: "sess-8f2c",
    ...over,
  }
}

test("coverage-log — appends one schema-stamped JSONL line per event", async () => {
  const stateRoot = mkStateRoot()
  recordCoverageEvent(event(), stateRoot)
  recordCoverageEvent(
    event({ outcome: "below_threshold", candidates: 4, topScore: 0.54 }),
    stateRoot,
  )
  await flushCoverageLog()

  const lines = fs
    .readFileSync(path.join(stateRoot, COVERAGE_LOG_NAME), "utf-8")
    .trim()
    .split("\n")
  assert.equal(lines.length, 2)
  const [first, second] = lines.map((l) => JSON.parse(l))
  assert.equal(first.v, 2)
  assert.ok(!Number.isNaN(Date.parse(first.ts)))
  assert.equal(first.outcome, "empty")
  assert.equal(first.topScore, null)
  assert.equal(second.outcome, "below_threshold")
  assert.equal(second.topScore, 0.54)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("coverage-log — prompt truncated to 500 chars", async () => {
  const stateRoot = mkStateRoot()
  const long = "x".repeat(600)
  recordCoverageEvent(event({ prompt: long }), stateRoot)
  await flushCoverageLog()

  const entry = JSON.parse(
    fs.readFileSync(path.join(stateRoot, COVERAGE_LOG_NAME), "utf-8").trim(),
  )
  assert.equal(entry.prompt.length, 500)
  assert.equal(entry.prompt, long.slice(0, 500))
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("coverage-log — oversized file rotates to .old and the live file starts fresh", async () => {
  const stateRoot = mkStateRoot()
  const p = path.join(stateRoot, COVERAGE_LOG_NAME)
  // Pre-seed just over the 5 MB cap so the next append rotates first.
  fs.writeFileSync(p, "x".repeat(5 * 1024 * 1024 + 1))

  recordCoverageEvent(event(), stateRoot)
  await flushCoverageLog()

  assert.ok(fs.existsSync(`${p}.old`), "previous generation kept as .old")
  const lines = fs.readFileSync(p, "utf-8").trim().split("\n")
  assert.equal(lines.length, 1, "live file holds exactly the new line")
  assert.equal(JSON.parse(lines[0]).outcome, "empty")
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("coverage-log — a failed append is swallowed, never thrown", async () => {
  const stateRoot = mkStateRoot()
  // A regular FILE as stateRoot makes path.join produce an unwritable path.
  const notADir = path.join(stateRoot, "not-a-dir")
  fs.writeFileSync(notADir, "plain file")
  assert.doesNotThrow(() => recordCoverageEvent(event(), notADir))
  // The queued write fails inside the chain; flush must resolve, not reject.
  await flushCoverageLog()
  fs.rmSync(stateRoot, { recursive: true, force: true })
})
