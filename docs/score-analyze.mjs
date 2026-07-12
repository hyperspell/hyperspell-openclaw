// Analyze labeled retrieval-score samples: does some relevanceThreshold value
// actually separate useful memory from noise? (proposal 02 §3d)
//
// Joins the score log (HYPERSPELL_SCORE_LOG JSONL) with the labels written by
// docs/score-review.mjs and prints:
//   1. per-label composite distributions (count/min/median/max + histogram)
//   2. a threshold sweep 0.40..0.90 step 0.05 — useful-recall(t) and
//      noise-cut(t), overall and per kind (the composite bakes in ±0.2 kind
//      adjustments, so a global threshold move is NOT kind-neutral)
//   3. the same sweep against the raw base relevance, to expose how much of
//      the separation is the boosts doing the work
//
// Decision rule (§3d): adopt the largest t with useful-recall(t) >= 0.90 and
// noise-cut(t) − noise-cut(0.60) >= 0.15, given >= 40 useful and >= 40 noise
// labels over >= 5 distinct days, and only if the per-kind sweep doesn't show
// the gain coming entirely from one kind that chatterPenalty/chatterQuota
// would handle more surgically. If no t clears all four: keep 0.6 and record
// that the threshold is not the binding lever.
//
// Usage: node docs/score-analyze.mjs <score-log.jsonl> [labels.jsonl]
//        (labels default to <score-log>.labels.jsonl)

import fs from "node:fs"

const logPath = process.argv[2] ?? process.env.HYPERSPELL_SCORE_LOG
if (!logPath || !fs.existsSync(logPath)) {
  console.error("usage: node docs/score-analyze.mjs <score-log.jsonl> [labels.jsonl]")
  process.exit(1)
}
const labelsPath = process.argv[3] ?? `${logPath}.labels.jsonl`

const parseJsonl = (p) =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const rows = parseJsonl(logPath)
const labels = new Map(parseJsonl(labelsPath).map((l) => [l.key, l.label]))
const joined = rows
  .map((r) => ({ ...r, label: labels.get(`${r.ts}|${r.resourceId}`) }))
  .filter((r) => r.label === "useful" || r.label === "noise")

if (joined.length === 0) {
  console.error(`no labeled candidates in ${labelsPath} — run docs/score-review.mjs first`)
  process.exit(1)
}

const useful = joined.filter((r) => r.label === "useful")
const noise = joined.filter((r) => r.label === "noise")
const days = new Set(joined.map((r) => r.ts.slice(0, 10)))
console.log(`labeled: ${useful.length} useful, ${noise.length} noise, across ${days.size} distinct day(s)`)
if (useful.length < 40 || noise.length < 40 || days.size < 5) {
  console.log(
    "NOTE: below the >=40 useful / >=40 noise / >=5 distinct-days floor (proposal 02 §3d) — keep labeling before deciding",
  )
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : " n/a")
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN
}

function distribution(name, group) {
  const scores = group.map((r) => r.composite)
  if (scores.length === 0) {
    console.log(`\n${name}: n=0`)
    return
  }
  console.log(
    `\n${name}: n=${scores.length} min=${fmt(Math.min(...scores))} median=${fmt(median(scores))} max=${fmt(Math.max(...scores))}`,
  )
  const buckets = new Map()
  for (const s of scores) {
    // Integer bucket avoids float-key drift; the epsilon keeps an exact 0.60
    // in the 0.60–0.65 bucket (0.6/0.05 is 11.999… in floats).
    const b = Math.floor(s / 0.05 + 1e-9)
    buckets.set(b, (buckets.get(b) ?? 0) + 1)
  }
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const n = buckets.get(b)
    console.log(`  ${fmt(b * 0.05)}-${fmt((b + 1) * 0.05)}  ${"#".repeat(Math.min(n, 60))} (${n})`)
  }
}
distribution("useful (composite)", useful)
distribution("noise (composite)", noise)

const frac = (group, pred) => (group.length === 0 ? Number.NaN : group.filter(pred).length / group.length)

function sweep(title, u, n, field) {
  console.log(`\n${title}  (useful n=${u.length}, noise n=${n.length})`)
  console.log("     t   useful-recall  noise-cut  d-noise-cut vs 0.60")
  const cutAt060 = frac(n, (r) => r[field] < 0.6)
  for (let i = 40; i <= 90; i += 5) {
    const t = i / 100
    const recall = frac(u, (r) => r[field] >= t)
    const cut = frac(n, (r) => r[field] < t)
    const delta = cut - cutAt060
    const sign = delta >= 0 ? "+" : ""
    console.log(`  ${t.toFixed(2)}       ${fmt(recall)}         ${fmt(cut)}        ${sign}${fmt(delta)}`)
  }
}

sweep("threshold sweep — composite (overall)", useful, noise, "composite")
for (const kind of [...new Set(joined.map((r) => r.kind))].sort()) {
  sweep(
    `threshold sweep — composite (kind=${kind})`,
    useful.filter((r) => r.kind === kind),
    noise.filter((r) => r.kind === kind),
    "composite",
  )
}
sweep("threshold sweep — base relevance (overall)", useful, noise, "base")
