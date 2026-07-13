// Elbow-cutoff live score-distribution scan (proposal 13, PR #91).
//
// OWNER-RUN validation instrument: the elbow ships OFF by default, and this
// script is how real parameters get picked before anyone flips it on. It runs
// real prompts through the EXACT production pipeline — HyperspellClient-style
// search + rerank imported from ../lib/ranking.ts, never a reimplementation —
// and prints each query's descending composite curve with per-pair gaps,
// annotated with where the threshold falls, where the fixed maxResults cutoff
// falls, and where each candidate elbow parameterization would stop.
//
// Acceptance bar (proposal 13 §4.1): on ~30-50 real prompts, eyeball each
// distribution and mark where "the rest isn't really relevant"; a good
// parameterization (a) fires on a meaningful fraction of narrow queries,
// (b) lands within ±1 of your mark when it fires, and (c) essentially never
// fires on broad queries where everything is decent. No parameterization
// passing that bar → the feature stays off (and should be removed, not left
// as dead config).
//
// Usage:
//   node --experimental-strip-types docs/elbow-scan.mjs                 # built-in prompt mix
//   node --experimental-strip-types docs/elbow-scan.mjs --prompts f.txt # newline-delimited prompts
//   node --experimental-strip-types docs/elbow-scan.mjs -o scan.json    # JSON for parameter sweeps
//
// Reads the live plugin config (apiKey/userId/ranking/maxResults/threshold)
// from ~/.openclaw/openclaw.json exactly like docs/hotbuffer-verify.mjs.

import fs from "node:fs"
import Hyperspell from "hyperspell"
import { rerank, selectRanked } from "../lib/ranking.ts"

const cfgAll = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"))
const cfg = cfgAll.plugins.entries["openclaw-hyperspell"].config
const client = new Hyperspell({ apiKey: cfg.apiKey, userID: cfg.userId })

const args = process.argv.slice(2)
const promptsFile = args[args.indexOf("--prompts") + 1]
const jsonOut = args.includes("-o") ? args[args.indexOf("-o") + 1] : null

const BUILTIN_PROMPTS = [
  // narrow — a clear "right answer" should exist
  "what is Heath's relationship to Junii",
  "what did the Omuerta binding cost Tevre",
  "what editor config do I use",
  "when is the D&D session",
  // broad — many decent memories, elbow should NOT fire
  "what have we been working on lately",
  "how has the writing been going",
  "what do we usually talk about in the evenings",
]

const prompts =
  args.includes("--prompts") && promptsFile
    ? fs.readFileSync(promptsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    : BUILTIN_PROMPTS

// The sweep grid from proposal 13 §4.1.
const GRID = []
for (const gapRatio of [2, 2.5, 3])
  for (const minGap of [0.03, 0.05, 0.08])
    GRID.push({ enabled: true, minResults: 3, gapRatio, minGap })

const ranking = {
  // Live weights, with parse-time defaults mirrored for any field the live
  // config omits (parseRanking isn't importable without the full config module
  // graph; keep this list in sync with DEFAULT_RANKING).
  enabled: true,
  curationBoost: 0.2,
  chatterPenalty: 0.2,
  storyBoost: 0.15,
  storyTerms: [],
  candidateMultiplier: 3,
  chatterQuota: 2,
  recencyHalfLifeDays: 90,
  recencyMaxPenalty: 0.1,
  recencyCuratedFactor: 0.5,
  sourceWeights: {},
  dedupThreshold: 0.8,
  elbow: { enabled: false, minResults: 3, gapRatio: 2.5, minGap: 0.05 },
  ...(cfg.ranking ?? {}),
}
const maxResults = cfg.maxResults ?? 10
const threshold = cfg.relevanceThreshold ?? 0.4

const report = []
for (const prompt of prompts) {
  // Same call + mapping shape as HyperspellClient.search (client.ts).
  const res = await client.memories.search(
    {
      query: prompt,
      ...(Array.isArray(cfg.sources) && cfg.sources.length > 0 ? { sources: cfg.sources } : {}),
      options: { max_results: maxResults * ranking.candidateMultiplier },
    },
    cfg.userId ? { headers: { "X-As-User": cfg.userId } } : undefined,
  )
  const results = (res.documents ?? []).map((doc) => ({
    resourceId: doc.resource_id,
    title: doc.title ?? null,
    source: doc.source,
    score: doc.score ?? null,
    url: doc.metadata?.url ?? null,
    createdAt: doc.metadata?.created_at ?? null,
    highlights: (doc.highlights ?? []).map((h) => ({
      id: h.id,
      score: h.score,
      text: h.text,
    })),
  }))
  const ranked = rerank(results, ranking)
  const baseSel = selectRanked(ranked, maxResults, threshold, ranking.chatterQuota, ranking.dedupThreshold)

  const stops = GRID.map((elbow) => ({
    elbow,
    stop: selectRanked(ranked, maxResults, threshold, ranking.chatterQuota, ranking.dedupThreshold, elbow).length,
  }))

  console.log(`\n=== ${prompt}`)
  let prev = null
  ranked.forEach((r, i) => {
    const gap = prev === null ? "" : `  (gap ${(prev - r._composite).toFixed(3)})`
    const marks = [
      i === baseSel.length ? "← fixed cutoff" : "",
      r._composite < threshold && (prev === null || prev >= threshold) ? "← threshold line" : "",
      ...stops.filter((s) => s.stop === i).map((s) => `← elbow(${s.elbow.gapRatio}/${s.elbow.minGap})`),
    ].filter(Boolean).join("  ")
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r._composite.toFixed(3)} [${r._kind}] ${(r.title ?? r.resourceId).slice(0, 55)}${gap}  ${marks}`,
    )
    prev = r._composite
  })
  report.push({
    prompt,
    baseline: baseSel.length,
    curve: ranked.map((r) => ({ id: r.resourceId, kind: r._kind, composite: r._composite })),
    stops: stops.map((s) => ({ gapRatio: s.elbow.gapRatio, minGap: s.elbow.minGap, stop: s.stop })),
  })
}

// Aggregate: firing rate + median cut per parameterization.
console.log("\n=== sweep aggregate")
for (const g of GRID) {
  const rows = report.map((r) => r.stops.find((s) => s.gapRatio === g.gapRatio && s.minGap === g.minGap))
  const fired = report.filter((r, i) => rows[i].stop < r.baseline)
  const cuts = fired.map((r) => r.stops.find((s) => s.gapRatio === g.gapRatio && s.minGap === g.minGap).stop).sort((a, b) => a - b)
  const median = cuts.length ? cuts[Math.floor(cuts.length / 2)] : "-"
  console.log(
    `  gapRatio ${g.gapRatio} minGap ${g.minGap}: fired on ${fired.length}/${report.length} queries (${Math.round((100 * fired.length) / report.length)}%), median cut at ${median}`,
  )
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ maxResults, threshold, ranking, report }, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
