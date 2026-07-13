// Label logged retrieval-score samples as useful / noise for
// relevanceThreshold tuning (proposal 02 §3c).
//
// Reads the JSONL written by the auto-context hook when HYPERSPELL_SCORE_LOG
// names a file, groups lines into search events (one logScoreSamples call
// shares ts + sessionId + prompt), and prompts for a label per candidate:
//
//   u          = useful (you'd want this injected for THAT prompt)
//   n          = noise  (chatter/irrelevant; glad to lose it)
//   s / Enter  = skip   (can't judge — prefer skipping over guessing)
//   q          = quit this sitting (progress is already saved)
//
// Labels are per event × candidate — the same memory can be useful for one
// prompt and noise for another; that context-dependence is exactly what the
// threshold has to navigate. Each label appends immediately to a sibling
// <log>.labels.jsonl keyed by `${ts}|${resourceId}`; on restart already-labeled
// candidates are skipped, so labeling is resumable in short sittings.
//
// Label the WHOLE candidate pool, not just what was injected — cut candidates
// (cut: "threshold") are the false-negative evidence: if useful memories are
// already being cut at 0.6, that argues for LOWERING the threshold, and only
// labeled cut items can show it.
//
// Usage: node docs/score-review.mjs <score-log.jsonl>
//        (falls back to $HYPERSPELL_SCORE_LOG when no argument is given)

import fs from "node:fs"
import readline from "node:readline"

const logPath = process.argv[2] ?? process.env.HYPERSPELL_SCORE_LOG
if (!logPath || !fs.existsSync(logPath)) {
  console.error("usage: node docs/score-review.mjs <score-log.jsonl>")
  process.exit(1)
}
const labelsPath = `${logPath}.labels.jsonl`

const parseJsonl = (p) =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const rows = parseJsonl(logPath)
const labeled = new Set(parseJsonl(labelsPath).map((l) => l.key))
const keyOf = (c) => `${c.ts}|${c.resourceId}`

// Group into search events, preserving log order.
const events = new Map()
for (const r of rows) {
  const k = `${r.ts}|${r.sessionId ?? ""}|${r.prompt}`
  if (!events.has(k)) events.set(k, [])
  events.get(k).push(r)
}

const totalPending = rows.filter((r) => !labeled.has(keyOf(r))).length
console.log(
  `${rows.length} candidates in ${events.size} search events; ${labeled.size} already labeled, ${totalPending} pending`,
)

// Buffer input lines ourselves: readline's promise question() drops lines
// that arrive between questions (piped input) and never settles on EOF.
// EOF reads as quit, so a piped or aborted sitting still exits cleanly.
const rl = readline.createInterface({ input: process.stdin })
const bufferedLines = []
const waiters = []
let stdinClosed = false
rl.on("line", (l) => {
  const w = waiters.shift()
  if (w) w(l)
  else bufferedLines.push(l)
})
rl.on("close", () => {
  stdinClosed = true
  for (const w of waiters.splice(0)) w("q")
})
function ask(prompt) {
  process.stdout.write(prompt)
  if (bufferedLines.length > 0) return Promise.resolve(bufferedLines.shift())
  if (stdinClosed) return Promise.resolve("q")
  return new Promise((resolve) => waiters.push(resolve))
}

let done = 0
outer: for (const cands of events.values()) {
  const pending = cands.filter((c) => !labeled.has(keyOf(c)))
  if (pending.length === 0) continue
  console.log(`\n=== ${cands[0].ts} [${cands[0].scope}]`)
  console.log(`prompt: ${cands[0].prompt}`)
  for (const c of pending) {
    const status = c.selected ? "SELECTED" : `cut=${c.cut}`
    console.log(`\n  [${c.kind}] composite=${c.composite} (base ${c.base}) ${status}`)
    console.log(`  "${c.snippet}"`)
    const ans = (await ask("  useful / noise / skip / quit [u/n/s/q]? ")).trim().toLowerCase()
    if (ans === "q") break outer
    if (ans !== "u" && ans !== "n") continue
    const label = ans === "u" ? "useful" : "noise"
    fs.appendFileSync(labelsPath, `${JSON.stringify({ key: keyOf(c), label })}\n`)
    done++
  }
}
rl.close()
console.log(`\nlabeled ${done} candidate(s) this sitting -> ${labelsPath}`)
console.log("analyze with: node docs/score-analyze.mjs " + logPath)
