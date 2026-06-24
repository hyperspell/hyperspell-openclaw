// Verify the hot-buffer read path is fixed (hyperspell PR #1899).
//
// Bug it confirms gone: /memories/query returned HTTP 500 on ANY query that
// matched a realtime hot-buffer row, while the row was still "hot" (before the
// ~60s server-side consolidation into a vault Resource). Root cause was
// HybridSearch asserting Chunk.id is not None; MessageRetriever built hot chunks
// with id=None.
//
// What this does: writes one labeled canary straight to the hot buffer (exactly
// what the agent_end hook does), then searches for it repeatedly across the
// pre-consolidation window, logging the STATUS of every call. Best-effort
// deletes the canary at the end so it doesn't linger in the vault.
//
//   PASS  = zero 500s across the whole window AND the canary surfaces early
//           (t+0 / t+1.5s — i.e. genuinely served from the hot buffer).
//   FAIL  = any 500 (fix not live / not deployed to this row's path), or the
//           canary never surfaces.
//
// Usage:
//   node docs/hotbuffer-verify.mjs                 # run the verification (self-cleans)
//   node docs/hotbuffer-verify.mjs --cleanup       # delete leftover canaries from THIS script
//   node docs/hotbuffer-verify.mjs --cleanup TOKEN # delete any vault resource matching TOKEN
//                                                   #   (use the nonce/secret word from a Test-2
//                                                   #    blind-sister probe, e.g. lighthouse-velvet)
//   add --dry-run to --cleanup to list matches without deleting.

import Hyperspell from "hyperspell"
import fs from "node:fs"

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"))
  .plugins.entries["openclaw-hyperspell"].config
const apiKey = cfg.apiKey
const userId = cfg.userId // "alinea" in her live config; X-As-User is required for /messages
const client = new Hyperspell({ apiKey, userID: userId })
const ro = userId ? { headers: { "X-As-User": userId } } : undefined
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!userId) {
  console.error("No userId in config — POST /messages requires X-As-User. Aborting.")
  process.exit(1)
}

// Markers this script stamps on its own canaries, used by default --cleanup.
const CANARY_ID_PREFIX = "hbverify-session-"
const CANARY_MARK = "Hot-buffer verification canary"

const args = process.argv.slice(2)
const doCleanup = args.includes("--cleanup")
const doFilterProbe = args.includes("--filter-probe")
const dryRun = args.includes("--dry-run")
const tokenArg = args.find((a) => !a.startsWith("--"))

// Write a labeled hot-buffer canary; returns { resourceId, secret, nonce }.
async function writeCanary(tag) {
  const n = `${tag}-` + Date.now().toString(36)
  const secret = `lighthouse-${n}`
  const resourceId = `${CANARY_ID_PREFIX}${n}`
  const res = await fetch("https://api.hyperspell.com/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-As-User": userId,
    },
    body: JSON.stringify({
      source: "vault",
      messages: [
        {
          resource_id: resourceId,
          message_id: `a-${n}`,
          content: `${CANARY_MARK} ${n}. Secret word: ${secret}. Safe to delete.`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`write failed ${res.status}: ${await res.text()}`)
  return { resourceId, secret, nonce: n }
}

async function searchHit(secret, resourceId, filter) {
  const opts = { max_results: 5, ...(filter ? { filter } : {}) }
  const r = await client.memories.search({ query: secret, options: opts }, ro)
  return {
    docs: r.documents.length,
    hit: r.documents.some((d) => d.resource_id === resourceId),
  }
}

/**
 * Empirically validate issue #40 + the proposed fixes against the LIVE backend
 * dialect (read-only besides one self-deleted canary). Proves whether the
 * untagged hot row is dropped by the current filter and whether the $exists /
 * $or fixes actually re-admit it — BEFORE anyone ships a filter that could fail
 * the same silent way.
 */
async function filterProbe() {
  console.log("=== filter dialect probe (issue #40) ===")
  const { resourceId, secret, nonce } = await writeCanary("hbfilter")
  console.log(`wrote canary ${resourceId} (nonce ${nonce})`)
  await sleep(2500) // let it index

  const cases = [
    ["no filter (baseline)", undefined, "TRUE"],
    ["current  { $ne: agent_end }", { openclaw_source: { $ne: "agent_end" } }, "FALSE (repro #40)"],
    ["Option1a { $exists: false }", { openclaw_source: { $exists: false } }, "TRUE"],
    [
      "Option1  { $or: [$exists:false, $ne] }",
      { $or: [{ openclaw_source: { $exists: false } }, { openclaw_source: { $ne: "agent_end" } }] },
      "TRUE",
    ],
  ]
  for (const [label, filter, expect] of cases) {
    try {
      const { docs, hit } = await searchHit(secret, resourceId, filter)
      console.log(`  ${label.padEnd(40)} | 200 | docs=${docs} | hit=${hit}  (expect ${expect})`)
    } catch (e) {
      const status = e?.status ?? ""
      console.log(`  ${label.padEnd(40)} | ${status} ERROR ${e?.message ?? e}  (expect ${expect})`)
      if (label.includes("$exists")) {
        console.log("    ^ $exists not supported by this dialect — prefer Option 4 (gate on autoTrace) / Option 2 (tag writes).")
      }
    }
  }

  try {
    await client.memories.delete(resourceId, { source: "vault" }, ro)
    console.log(`cleanup: deleted ${resourceId}`)
  } catch (e) {
    console.log(`cleanup: could not delete ${resourceId}; run --cleanup ${nonce}`)
  }
  console.log(
    "\nVerdict: Option 1 is viable iff the $exists / $or rows came back 200 + hit=TRUE.",
  )
}

function resourceText(d) {
  const title = d.title ?? ""
  const hl = (d.highlights ?? []).map((h) => h?.text ?? "").join(" ")
  return { title, hl, id: String(d.resource_id ?? "") }
}

/**
 * Conservative cleanup: only deletes a resource when `token` (or this script's
 * own canary signature) actually appears in its id/title/highlight text — never
 * on a bare relevance hit. Lists everything; --dry-run skips the delete.
 */
async function cleanup(token) {
  const queries = token ? [token] : [CANARY_MARK, "hbverify", "Safe to delete"]
  const matches = new Map() // resourceId -> { source, title }
  console.log(`=== cleanup ${dryRun ? "(dry-run) " : ""}===`)
  console.log(token ? `token: ${JSON.stringify(token)}` : "target: this script's own canaries")

  for (const q of queries) {
    let docs = []
    try {
      const r = await client.memories.search({ query: q, options: { max_results: 25 } }, ro)
      docs = r.documents ?? []
    } catch (e) {
      console.log(`  search ${JSON.stringify(q)} ERROR ${e?.status ?? ""} ${e?.message ?? e}`)
      continue
    }
    for (const d of docs) {
      const { title, hl, id } = resourceText(d)
      const hay = `${id}\n${title}\n${hl}`
      const isMatch = token
        ? hay.includes(token)
        : id.startsWith(CANARY_ID_PREFIX) || hay.includes(CANARY_MARK) || hay.includes("hbverify-")
      if (isMatch && id) matches.set(id, { source: d.source ?? "vault", title })
    }
  }

  if (matches.size === 0) {
    console.log("  no matching resources found — nothing to delete.")
    return 0
  }

  let deleted = 0
  for (const [rid, info] of matches) {
    const label = `${rid}  [${info.source}]  ${JSON.stringify(info.title || "")}`
    if (dryRun) {
      console.log(`  would delete: ${label}`)
      continue
    }
    try {
      await client.memories.delete(rid, { source: info.source }, ro)
      deleted++
      console.log(`  deleted: ${label}`)
    } catch (e) {
      console.log(`  FAILED to delete ${rid}: ${e?.status ?? ""} ${e?.message ?? e}`)
    }
  }
  console.log(`\n${dryRun ? `${matches.size} match(es) — none deleted (dry-run).` : `deleted ${deleted}/${matches.size}.`}`)
  return matches.size
}

if (doCleanup) {
  await cleanup(tokenArg)
  process.exit(0)
}

if (doFilterProbe) {
  await filterProbe()
  process.exit(0)
}

// ---- verification run ----
const nonce = "hbverify-" + Date.now().toString(36)
const secret = `lighthouse-${nonce}`
const resourceId = `${CANARY_ID_PREFIX}${nonce}`
const messageId = `a-${nonce}`
const content = `${CANARY_MARK} ${nonce}. Secret word: ${secret}. Safe to delete.`

console.log("=== hot-buffer verify ===")
console.log("userId:", userId, "| nonce:", nonce)

// 1) Write the canary directly to the hot buffer (mirrors the agent_end hook).
const wr = await fetch("https://api.hyperspell.com/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-As-User": userId,
  },
  body: JSON.stringify({
    source: "vault",
    messages: [{ resource_id: resourceId, message_id: messageId, content }],
  }),
})
console.log(`write POST /messages -> ${wr.status}${wr.ok ? "" : "  " + (await wr.text())}`)
if (!wr.ok) {
  console.error("FAIL: could not write canary to hot buffer.")
  process.exit(1)
}

// 2) Search across the pre-consolidation window. Log STATUS of every call.
//    A 500 anywhere = the read-path bug is still live for this path.
let any500 = false
let firstHitMs = null
const t0 = Date.now()
const schedule = [0, 1500, 3000, 6000, 12000, 25000, 45000, 70000]
let prev = 0
for (const at of schedule) {
  if (at > prev) await sleep(at - prev)
  prev = at
  const elapsed = Date.now() - t0
  try {
    const r = await client.memories.search({ query: secret, options: { max_results: 5 } }, ro)
    const hit = r.documents.some(
      (d) => d.resource_id === resourceId || (d.title ?? "").includes(nonce),
    )
    if (hit && firstHitMs === null) firstHitMs = elapsed
    console.log(`  t+${elapsed}ms  OK    docs=${r.documents.length}  hit=${hit}`)
  } catch (e) {
    const status = e?.status ?? ""
    if (String(status).startsWith("5")) any500 = true
    console.log(`  t+${elapsed}ms  FAIL ${status}  ${e?.message ?? e}`)
  }
}

// 3) Best-effort cleanup so the canary doesn't pollute the vault / dreams.
try {
  await client.memories.delete(resourceId, { source: "vault" }, ro)
  console.log(`cleanup: deleted ${resourceId}`)
} catch (e) {
  console.log(`cleanup: could not delete ${resourceId} (${e?.status ?? ""} ${e?.message ?? e})`)
  console.log(`         run:  node docs/hotbuffer-verify.mjs --cleanup ${nonce}`)
}

// 4) Verdict.
const pass = !any500 && firstHitMs !== null && firstHitMs <= 6000
console.log("\n=== verdict ===")
console.log(`  no 500s:          ${!any500 ? "yes" : "NO  <-- read-path bug still live"}`)
console.log(`  surfaced:         ${firstHitMs !== null ? `yes, first at t+${firstHitMs}ms` : "NO  <-- never found"}`)
console.log(`  surfaced in-window(<=6s): ${firstHitMs !== null && firstHitMs <= 6000 ? "yes" : "no"}`)
console.log(pass ? "\nPASS — hot-buffer instant recall works end-to-end." : "\nFAIL — see above.")
process.exit(pass ? 0 : 1)
