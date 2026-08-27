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

// Writes are serialized onto this queue so events land in call order and a
// slow filesystem never blocks the turn (v2 fires on EVERY coverage-logged
// turn, hits included — the sync-write shortcut stopped being cheap enough,
// PR #133 review). The catch keeps the chain alive after a failed write.
let pending: Promise<void> = Promise.resolve()

/**
 * Append one coverage event to the LOCAL-ONLY coverage log
 * (`<workspaceDir>/.hyperspell-coverage.jsonl`). Never sent to the backend —
 * same trust domain as the hot-buffer state files already living there.
 * Prompt text is sensitive plaintext, so writes happen only behind the
 * explicit `coverageLog: true` opt-in (checked at call sites, default OFF).
 * Best-effort by contract: any failure is swallowed (debug-logged) — a
 * coverage write must never throw into, block, or delay the turn. The event
 * is stamped and serialized at call time (it describes THIS turn); only the
 * filesystem work is deferred to the queue.
 */
export function recordCoverageEvent(event: CoverageEvent, stateRoot?: string): void {
  const line = JSON.stringify({
    v: 2,
    ts: new Date().toISOString(),
    ...event,
    prompt: event.prompt.slice(0, MAX_PROMPT_CHARS),
  })
  pending = pending
    .then(() => appendLine(line, stateRoot))
    .catch((err) => {
      log.debug(`coverage-log: append failed — ${String(err)}`)
    })
}

/** Await every coverage write queued so far — tests and shutdown paths.
 * Never rejects: write failures are already swallowed inside the queue. */
export function flushCoverageLog(): Promise<void> {
  return pending
}

async function appendLine(line: string, stateRoot?: string): Promise<void> {
  const dir = stateRoot ?? getWorkspaceDir()
  const p = path.join(dir, COVERAGE_LOG_NAME)
  await rotateIfOversized(p)
  await fs.promises.appendFile(p, `${line}\n`)
}

/** One-generation rotation: current file > cap → rename to .old (replacing the
 * previous .old), start fresh. Total footprint bounded at ~2× MAX_LOG_BYTES. */
async function rotateIfOversized(p: string): Promise<void> {
  try {
    const st = await fs.promises.stat(p)
    if (st.size > MAX_LOG_BYTES) await fs.promises.rename(p, `${p}.old`)
  } catch {
    /* missing file or rename race — appendFile creates/handles it */
  }
}
