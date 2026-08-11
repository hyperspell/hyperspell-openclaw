// Full read-only vault export → git-backed local mirror (roadmap Phase 2).
//
// Why: the vault is the one part of the agent's identity NOT under the
// operator's control — identity files live in the git-backed workspace, but
// memory lives on Hyperspell's servers. This script converts vendor-lifetime
// into record-lifetime: a complete local snapshot of every vault/trace
// resource (consolidated content + raw rows) plus the emotional-state
// register, written as JSONL into the workspace so the existing daily
// git backup carries it.
//
// READ-ONLY against the API. Local writes go only to <workspace>/vault-mirror/.
// Snapshot-in-place: each run overwrites the same files, so git history holds
// the increments and a diff shows exactly what memory changed since last run.
//
// Usage:
//   node docs/vault-export.mjs             # full export
//   node docs/vault-export.mjs --limit 20  # smoke run on the newest 20 resources
//
// Output files (in <workspace>/vault-mirror/):
//   memories-<source>.jsonl   one line per resource: the full memories.get doc
//   emotional-states.jsonl    latest register (per relationship if configured)
//   manifest.json             counts, timestamps, app/user, failures
//   RESTORE.md                the restoration runbook (written once, kept)

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import Hyperspell from "hyperspell"

const API_BASE_URL = "https://api.hyperspell.com"

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))
	.plugins.entries["openclaw-hyperspell"].config
const apiKey = cfg.apiKey
const userId = cfg.userId
if (!apiKey) {
	console.error("apiKey missing from config — aborting.")
	process.exit(1)
}

const client = new Hyperspell({ apiKey, userID: userId })
const ro = userId ? { headers: { "X-As-User": userId } } : undefined

const args = process.argv.slice(2)
const limitIdx = args.indexOf("--limit")
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity

const workspace = path.join(os.homedir(), ".openclaw", "workspace")
const outDir = path.join(workspace, "vault-mirror")
// Trace exports are huge (~877 MB observed live) and the workspace repo
// pushes to GitHub, which hard-rejects files >100 MB — so traces go to a
// plain directory OUTSIDE the git workspace. Vault (~25 MB) stays inside,
// riding the daily git backup.
const archiveDir = path.join(os.homedir(), ".openclaw", "vault-archive")
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(archiveDir, { recursive: true })

// Plugin-owned sources only: vault (hot buffer, /remember, synced memory files)
// and trace (auto-trace sessions). Connected sources (notion/slack/gmail…) are
// mirrors of data that already lives elsewhere — not part of the agent's own
// record, and re-exportable from their origins.
const SOURCES = ["vault", "trace"]
const dirFor = (source) => (source === "trace" ? archiveDir : outDir)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listAll(source) {
	const out = []
	let cursor
	do {
		const page = await client.memories.list(
			{ source, limit: 100, ...(cursor ? { cursor } : {}) },
			ro,
		)
		for (const it of page.items ?? []) out.push(it)
		cursor = page.next_cursor ?? undefined
	} while (cursor && out.length < LIMIT)
	return out.slice(0, LIMIT === Infinity ? out.length : LIMIT)
}

async function fetchFull(source, resourceId, attempt = 0) {
	try {
		return await client.memories.get(resourceId, { source }, ro)
	} catch (e) {
		// One retry on transient failures; a mirror with silent holes is worse
		// than a slow run.
		if (attempt < 1) {
			await sleep(1500)
			return fetchFull(source, resourceId, attempt + 1)
		}
		throw e
	}
}

const manifest = {
	exported_at: new Date().toISOString(),
	user: userId ?? null,
	sources: {},
	emotional_states: 0,
	failures: [],
}

for (const source of SOURCES) {
	console.log(`Listing ${source}…`)
	let items
	try {
		items = await listAll(source)
	} catch (e) {
		console.log(`  list ${source} failed: ${String(e).slice(0, 120)}`)
		manifest.failures.push({ source, stage: "list", error: String(e).slice(0, 200) })
		continue
	}
	console.log(`  ${items.length} resource(s)`)

	const outPath = path.join(dirFor(source), `memories-${source}.jsonl`)
	const tmpPath = `${outPath}.tmp`
	const fd = fs.openSync(tmpPath, "w")
	let ok = 0

	// Batches of 5 keep the run to minutes without hammering the backend.
	for (let i = 0; i < items.length; i += 5) {
		const batch = items.slice(i, i + 5)
		const docs = await Promise.allSettled(
			batch.map((it) => fetchFull(source, it.resource_id ?? it.id)),
		)
		for (let j = 0; j < docs.length; j++) {
			const it = batch[j]
			const rid = it.resource_id ?? it.id
			if (docs[j].status === "fulfilled") {
				fs.writeSync(
					fd,
					JSON.stringify({ resource_id: rid, source, listing: it, doc: docs[j].value }) + "\n",
				)
				ok++
			} else {
				manifest.failures.push({
					source,
					resource_id: rid,
					stage: "get",
					error: String(docs[j].reason).slice(0, 200),
				})
			}
		}
		if (i % 100 === 0 && i > 0) console.log(`  …${i}/${items.length}`)
	}
	fs.closeSync(fd)
	fs.renameSync(tmpPath, outPath)
	manifest.sources[source] = { listed: items.length, exported: ok }
	console.log(`  wrote ${ok}/${items.length} → ${path.basename(outPath)}`)
}

// Emotional-state register: latest per configured relationship (plus the
// unscoped latest). GET /emotional-state is the verified endpoint shape.
console.log("Fetching emotional states…")
const states = []
const relIds = [undefined, cfg.relationshipId].filter((v, i, a) => a.indexOf(v) === i)
for (const rel of relIds) {
	try {
		const url = new URL(`${API_BASE_URL}/emotional-state`)
		if (rel) url.searchParams.set("relationship_id", rel)
		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${apiKey}`, ...(userId ? { "X-As-User": userId } : {}) },
		})
		if (res.ok) {
			const data = await res.json()
			if (data) states.push({ relationship_id: rel ?? null, state: data })
		}
	} catch (e) {
		manifest.failures.push({ stage: "emotional-state", relationship_id: rel ?? null, error: String(e).slice(0, 200) })
	}
}
fs.writeFileSync(
	path.join(outDir, "emotional-states.jsonl"),
	states.map((s) => JSON.stringify(s)).join("\n") + (states.length ? "\n" : ""),
)
manifest.emotional_states = states.length

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))

console.log("\nExport complete:")
for (const [source, s] of Object.entries(manifest.sources)) {
	console.log(`  ${source}: ${s.exported}/${s.listed}`)
}
console.log(`  emotional states: ${manifest.emotional_states}`)
console.log(`  failures: ${manifest.failures.length}`)
console.log(`  → ${outDir}`)
if (manifest.failures.length > 0) {
	console.log("  (failures listed in manifest.json — re-run to fill holes; snapshot-in-place is idempotent)")
}
