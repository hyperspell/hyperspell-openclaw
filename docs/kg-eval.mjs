// Knowledge Graph enablement eval probe (proposal/06 §4.2).
//
// Raw-retrieval comparison for the who/what question set: for each frozen
// question, hit the search API directly (no agent in the loop), then use the
// sync manifest to decide which hits were served from Memory Network entity
// files (memory/people|projects|organizations|topics). Run once BEFORE
// enabling the graph (baseline) and again AFTER 2-3 cron cycles; diffing the
// two outputs isolates "search surfaces the entity file" from "the agent
// uses it well".
//
// Per question it prints: top-N titles/resourceIds/scores, which hits resolve
// to entity files, and the score gap between the best entity-file hit and the
// best non-entity hit.
//
// Usage:
//   node docs/kg-eval.mjs                         # uses docs/kg-eval-questions.json
//   node docs/kg-eval.mjs my-questions.json       # custom fixture
//   node docs/kg-eval.mjs --limit 10              # top-N per question (default 8)
//
// Fixture format (freeze real names from the install's history BEFORE the
// baseline run — see proposal/06 §4.1 for the 8-question template):
//   ["Who is Alice Chen?", "What's Alice Chen's email?", ...]

import Hyperspell from "hyperspell"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const args = process.argv.slice(2)
const limitIdx = args.indexOf("--limit")
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) || 8 : 8
const fixtureArg = args.find((a, i) => !a.startsWith("--") && (limitIdx < 0 || i !== limitIdx + 1))

const openclawConfig = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"),
)
const cfg = openclawConfig.plugins.entries["openclaw-hyperspell"].config
const apiKey = cfg.apiKey?.startsWith("${")
  ? process.env[cfg.apiKey.slice(2, -1)]
  : cfg.apiKey
const userId = cfg.userId
const workspaceDir = (openclawConfig.agents?.defaults?.workspace ?? path.join(os.homedir(), ".openclaw", "workspace"))
  .replace(/^~(?=$|[\\/])/, os.homedir())

const fixturePath = fixtureArg ?? path.join("docs", "kg-eval-questions.json")
if (!fs.existsSync(fixturePath)) {
  console.error(
    `No question fixture at ${fixturePath} — create it first (JSON array of the 8 frozen questions, proposal/06 §4.1).`,
  )
  process.exit(1)
}
const questions = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
if (!Array.isArray(questions) || questions.length === 0) {
  console.error("Fixture must be a non-empty JSON array of question strings.")
  process.exit(1)
}

// Map resourceId -> entity file it was synced from, via the sync manifest
// (sync/markdown.ts SyncManifest: files[relPath].sections[title].resourceId).
const ENTITY_DIRS = ["memory/people/", "memory/projects/", "memory/organizations/", "memory/topics/"]
const entityByResourceId = new Map()
try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, ".hyperspell-sync-hashes.json"), "utf8"),
  )
  for (const [relPath, fileManifest] of Object.entries(manifest.files ?? {})) {
    if (!ENTITY_DIRS.some((d) => relPath.startsWith(d))) continue
    for (const record of Object.values(fileManifest.sections ?? {})) {
      if (record.resourceId) entityByResourceId.set(record.resourceId, relPath)
    }
  }
} catch {
  console.error("No readable sync manifest — every hit will count as non-entity (expected on the baseline run).")
}

const client = new Hyperspell({ apiKey, userID: userId })
const requestOptions = userId ? { headers: { "X-As-User": userId } } : undefined

console.log(`kg-eval: ${questions.length} questions, top ${limit}, ${entityByResourceId.size} entity-file resourceIds known\n`)

for (const question of questions) {
  const response = await client.memories.search(
    { query: question, options: { max_results: limit } },
    requestOptions,
  )
  const hits = response.documents.map((doc) => ({
    resourceId: doc.resource_id,
    title: doc.title ?? "(untitled)",
    source: doc.source,
    score: doc.score ?? 0,
    entityFile: entityByResourceId.get(doc.resource_id) ?? null,
  }))

  console.log(`Q: ${question}`)
  for (const hit of hits) {
    const tag = hit.entityFile ? ` ← ENTITY ${hit.entityFile}` : ""
    console.log(`   ${hit.score.toFixed(3)}  [${hit.source}] ${hit.title} (${hit.resourceId})${tag}`)
  }
  const bestEntity = hits.find((h) => h.entityFile)
  const bestOther = hits.find((h) => !h.entityFile)
  if (bestEntity && bestOther) {
    console.log(`   → entity-vs-rest score gap: ${(bestEntity.score - bestOther.score).toFixed(3)}`)
  } else if (bestEntity) {
    console.log("   → only entity-file hits in top results")
  } else {
    console.log("   → no entity-file hit surfaced")
  }
  console.log()
}
