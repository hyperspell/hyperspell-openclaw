import * as fs from "node:fs"
import * as path from "node:path"
import { getWorkspaceDir } from "../config.ts"
import { log } from "../logger.ts"

export const COVERAGE_LOG_NAME = ".hyperspell-coverage.jsonl"
// Truncation bounds line size and what sits on disk; 500 chars is enough to
// judge "should this have found something" without full-prompt fidelity.
const MAX_PROMPT_CHARS = 500
// One-generation rotation caps the total footprint at ~2× this (current + .old).
const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface CoverageLane {
  lane: "personal" | "shared"
  status: "ok" | "error"
  candidates?: number
  topScore?: number | null
  rawTopScore?: number | null
}

export interface CoverageEvent {
  outcome: "empty" | "below_threshold" | "filtered" | "injected"
  prompt: string
  fetched: number
  candidates: number
  droppedCurrentSession: number
  topScore: number | null
  rawTopScore: number | null
  threshold: number
  ranking: boolean
  shown: number
  shownChars: number
  selected?: Array<{
    resourceId: string
    kind?: string
    writer?: string | null
    injectedChars?: number
  }>
  sessionId?: string
  userId?: string
  lanes?: CoverageLane[]
}

/**
 * Append one coverage event to the LOCAL-ONLY coverage log
 * (`<workspaceDir>/.hyperspell-coverage.jsonl`). Never sent to the backend —
 * same trust domain as the hot-buffer state files already living there.
 * Prompt text is sensitive plaintext, so writes happen only behind the
 * explicit `coverageLog: true` opt-in (checked at call sites, default OFF).
 * Best-effort by contract: any failure is swallowed (debug-logged) — a
 * coverage write must never throw into, block, or delay the turn.
 */
export function recordCoverageEvent(event: CoverageEvent, stateRoot?: string): void {
  try {
    const dir = stateRoot ?? getWorkspaceDir()
    const p = path.join(dir, COVERAGE_LOG_NAME)
    rotateIfOversized(p)
    const line = JSON.stringify({
      v: 2,
      ts: new Date().toISOString(),
      ...event,
      prompt: event.prompt.slice(0, MAX_PROMPT_CHARS),
    })
    fs.appendFileSync(p, `${line}\n`)
  } catch (err) {
    log.debug(`coverage-log: append failed — ${String(err)}`)
  }
}

/** One-generation rotation: current file > cap → rename to .old (replacing the
 * previous .old), start fresh. Total footprint bounded at ~2× MAX_LOG_BYTES. */
function rotateIfOversized(p: string): void {
  try {
    if (fs.statSync(p).size > MAX_LOG_BYTES) fs.renameSync(p, `${p}.old`)
  } catch {
    /* missing file or rename race — appendFileSync creates/handles it */
  }
}
