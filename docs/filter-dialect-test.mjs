// Full characterization of the Hyperspell backend filter dialect for issue #40.
//
// We need an exclude filter that DROPS agent_end rows but KEEPS untagged
// hot-buffer rows. The obvious MongoDB-style answers ($exists:false, $or) were
// falsified by --filter-probe (returned 0 docs). This maps what the dialect
// ACTUALLY supports, against controlled canaries, so we ship a proven filter.
//
// Canaries (all share a unique term so one query returns them together):
//   U  — UNTAGGED, written via POST /messages  (the real hot-buffer row)
//   A  — tagged openclaw_source="agent_end" via memories.add (the row to EXCLUDE)
//   H  — tagged openclaw_source="hot_buffer"  via memories.add (Option 2 sim)
//   Um — UNTAGGED-but-with-metadata via POST /messages (tests whether /messages
//        even accepts metadata — i.e. whether Option 2 is possible for hot rows)
//   M  — tagged openclaw_source="mood_weather" via memories.add (issue #71 roll
//        record; the second value the multi-value exclude must drop)
//
// Goal filter: returns U=yes, A=no, status 200. Everything is deleted at the end.
// Issue #71 (multi-value exclude, post-#1921 re-verification): the
// $nin[agent_end,mood_weather] row must show U=Y, A=N, M=N; $and[$ne,$ne] is
// the fallback shape if $nin fails.
//
// Run:  node docs/filter-dialect-test.mjs

import Hyperspell from "hyperspell"
import fs from "node:fs"

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"))
  .plugins.entries["openclaw-hyperspell"].config
const apiKey = cfg.apiKey
const userId = cfg.userId
const client = new Hyperspell({ apiKey, userID: userId })
const ro = userId ? { headers: { "X-As-User": userId } } : undefined
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!userId) { console.error("no userId; aborting"); process.exit(1) }

const run = Date.now().toString(36)
const SHARED = `dialecttest-${run}` // common term in every canary
const tok = { U: `tokU-${run}`, A: `tokA-${run}`, H: `tokH-${run}`, Um: `tokUm-${run}`, M: `tokM-${run}` }
const Uid = `fdt-U-${run}`
const Umid = `fdt-Um-${run}`

async function postMessage(resourceId, token, extra) {
  const msg = { resource_id: resourceId, message_id: `m-${token}`, content: `${SHARED} ${token}. Safe to delete.`, ...extra }
  const res = await fetch("https://api.hyperspell.com/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-As-User": userId },
    body: JSON.stringify({ source: "vault", messages: [msg] }),
  })
  return { status: res.status, body: res.ok ? "" : await res.text() }
}

console.log("=== filter dialect test (issue #40) ===  run", run)

// --- write canaries ---
const created = [] // {label, resource_id, via}
const rU = await postMessage(Uid, tok.U)
console.log(`U  (/messages untagged)        -> ${rU.status}`)
if (rU.status < 300) created.push({ label: "U", resource_id: Uid, via: "messages" })

const rUm = await postMessage(Umid, tok.Um, { metadata: { openclaw_source: "hot_buffer" } })
console.log(`Um (/messages + metadata)      -> ${rUm.status} ${rUm.body ? "("+rUm.body.slice(0,60)+")" : ""}`)
if (rUm.status < 300) created.push({ label: "Um", resource_id: Umid, via: "messages" })

let A, H, M
try {
  A = await client.memories.add({ text: `${SHARED} ${tok.A}. Safe to delete.`, title: `FDT A ${run}`, collection: "openclaw", metadata: { openclaw_source: "agent_end" } }, ro)
  console.log(`A  (memories.add agent_end)    -> ${A.resource_id}`)
  created.push({ label: "A", resource_id: A.resource_id, via: "memories" })
} catch (e) { console.log("A add failed:", e?.status, e?.message) }
try {
  H = await client.memories.add({ text: `${SHARED} ${tok.H}. Safe to delete.`, title: `FDT H ${run}`, collection: "openclaw", metadata: { openclaw_source: "hot_buffer" } }, ro)
  console.log(`H  (memories.add hot_buffer)   -> ${H.resource_id}`)
  created.push({ label: "H", resource_id: H.resource_id, via: "memories" })
} catch (e) { console.log("H add failed:", e?.status, e?.message) }
try {
  M = await client.memories.add({ text: `${SHARED} ${tok.M}. Safe to delete.`, title: `FDT M ${run}`, collection: "mood-weather", metadata: { openclaw_source: "mood_weather" } }, ro)
  console.log(`M  (memories.add mood_weather) -> ${M.resource_id}`)
  created.push({ label: "M", resource_id: M.resource_id, via: "memories" })
} catch (e) { console.log("M add failed:", e?.status, e?.message) }

console.log("\nindexing… (4s)")
await sleep(4000)

// --- probe helper: which canaries come back under a given filter ---
async function probe(filter) {
  const opts = { max_results: 25, ...(filter ? { filter } : {}) }
  try {
    const r = await client.memories.search({ query: SHARED, options: opts }, ro)
    const hay = r.documents.map((d) => `${d.resource_id} ${d.title ?? ""} ${(d.highlights ?? []).map((h) => h.text).join(" ")}`).join(" || ")
    const has = (t, id) => hay.includes(t) || hay.includes(id)
    return { status: 200, n: r.documents.length, U: has(tok.U, Uid), Um: has(tok.Um, Umid), A: has(tok.A, A?.resource_id ?? "A?"), H: has(tok.H, H?.resource_id ?? "H?"), M: has(tok.M, M?.resource_id ?? "M?") }
  } catch (e) { return { status: e?.status ?? "ERR", err: e?.message } }
}

const FILTERS = [
  ["no filter (baseline)", undefined],
  ["$ne agent_end", { openclaw_source: { $ne: "agent_end" } }],
  ["$exists:false", { openclaw_source: { $exists: false } }],
  ["$or[$exists:false,$ne]", { $or: [{ openclaw_source: { $exists: false } }, { openclaw_source: { $ne: "agent_end" } }] }],
  ["$or[null,$ne]", { $or: [{ openclaw_source: null }, { openclaw_source: { $ne: "agent_end" } }] }],
  ["openclaw_source:null", { openclaw_source: null }],
  ["$nin[agent_end]", { openclaw_source: { $nin: ["agent_end"] } }],
  ["$not{$eq}", { openclaw_source: { $not: { $eq: "agent_end" } } }],
  ["$ne null", { openclaw_source: { $ne: null } }],
  ["$eq hot_buffer", { openclaw_source: { $eq: "hot_buffer" } }],
  ["$in[hot_buffer]", { openclaw_source: { $in: ["hot_buffer"] } }],
  ["$and[$ne]", { $and: [{ openclaw_source: { $ne: "agent_end" } }] }],
  // issue #71 — multi-value exclude candidates (post-#1921 re-verification).
  // Success criterion: U=Y, A=N, M=N, status 200. Prefer $nin; $and-of-$ne is the fallback.
  ["$nin[agent_end,mood_weather]", { openclaw_source: { $nin: ["agent_end", "mood_weather"] } }],
  ["$and[$ne,$ne]", { $and: [{ openclaw_source: { $ne: "agent_end" } }, { openclaw_source: { $ne: "mood_weather" } }] }],
]

console.log("\n=== truth table (want: U=Y, A=N, status 200; #71 rows also want M=N) ===")
console.log("filter".padEnd(30), "stat", " U ", "Um ", " A ", " H ", " M ", " n")
for (const [label, f] of FILTERS) {
  const r = await probe(f)
  if (r.status !== 200) { console.log(label.padEnd(30), String(r.status).padEnd(4), " — err:", r.err); continue }
  const y = (b) => (b ? " Y " : " . ")
  console.log(label.padEnd(30), "200 ", y(r.U), y(r.Um), y(r.A), y(r.H), y(r.M), String(r.n).padStart(2))
}

// --- cleanup everything ---
console.log("\n=== cleanup ===")
for (const c of created) {
  try { await client.memories.delete(c.resource_id, { source: "vault" }, ro); console.log("deleted", c.label, c.resource_id) }
  catch (e) {
    // fall back to search-by-token delete (works where direct delete 404s pre-consolidation)
    try {
      const r = await client.memories.search({ query: tok[c.label], options: { max_results: 5 } }, ro)
      for (const d of r.documents) { try { await client.memories.delete(d.resource_id, { source: d.source ?? "vault" }, ro) } catch {} }
      console.log("deleted(via search)", c.label)
    } catch { console.log("COULD NOT DELETE", c.label, c.resource_id, "— token", tok[c.label]) }
  }
}
console.log("\nKey: U=untagged hot row (KEEP), A=agent_end (DROP), Um=/messages+metadata (does tagging stick?), H=tagged hot_buffer (Option 2), M=mood_weather roll record (DROP — issue #71)")
