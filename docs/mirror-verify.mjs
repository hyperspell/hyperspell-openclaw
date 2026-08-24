// Mirror verification — her Phase 0 items 2 and 3, as one runnable check.
//
//   node docs/mirror-verify.mjs            # staleness + parse integrity + live spot-check
//   node docs/mirror-verify.mjs --no-live  # offline: staleness + parse only
//   node docs/mirror-verify.mjs --max-age-days 8
//
// "A backup nobody has restored from is a belief, not a backup." This script
// READS records back out of the mirror and confirms they are intact,
// parseable, and (spot-checked) still match live — and it fails LOUDLY when
// the mirror is stale, because a mirror that silently stops is worse than no
// mirror ("it launders confidence").
//
// Exit codes: 0 ok · 2 stale · 3 corrupt/unparseable · 4 live spot-check
// failed · 5 mirror missing. Availability errors during the live check are
// reported as availability (exit 4 with a note), never as "data missing".
// READ-ONLY throughout.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Hyperspell from "hyperspell"

const args = process.argv.slice(2)
const noLive = args.includes("--no-live")
const maxAgeIdx = args.indexOf("--max-age-days")
const MAX_AGE_DAYS = maxAgeIdx >= 0 ? Number(args[maxAgeIdx + 1]) : 8
const SAMPLE = 5

const workspace = path.join(os.homedir(), ".openclaw", "workspace")
const mirrorDir = path.join(workspace, "vault-mirror")
const archiveFile = path.join(os.homedir(), ".openclaw", "vault-archive", "memories-trace.jsonl")

const fail = (code, msg) => {
	console.error(`FAIL(${code}): ${msg}`)
	process.exit(code)
}

// --- 1. Staleness ---
const manifestPath = path.join(mirrorDir, "manifest.json")
if (!fs.existsSync(manifestPath)) fail(5, `no mirror manifest at ${manifestPath}`)
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const exportedAt = Date.parse(manifest.exported_at ?? "")
if (Number.isNaN(exportedAt)) fail(3, "manifest.exported_at missing/unparseable")
const ageDays = (Date.now() - exportedAt) / 86_400_000
console.log(`mirror age: ${ageDays.toFixed(1)} day(s) (exported ${manifest.exported_at})`)
if (ageDays > MAX_AGE_DAYS) fail(2, `mirror is ${ageDays.toFixed(1)} days old (max ${MAX_AGE_DAYS}) — the refresh cron is not doing its job`)

// --- 2. Parse integrity: sample lines from every mirror file ---
const sampled = []
for (const file of [path.join(mirrorDir, "memories-vault.jsonl"), path.join(mirrorDir, "emotional-states.jsonl"), archiveFile]) {
	if (!fs.existsSync(file)) fail(5, `mirror file missing: ${file}`)
	const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0)
	if (lines.length === 0) fail(3, `${path.basename(file)} is empty`)
	const step = Math.max(1, Math.floor(lines.length / SAMPLE))
	for (let i = 0; i < lines.length; i += step) {
		let row
		try {
			row = JSON.parse(lines[i])
		} catch (e) {
			fail(3, `${path.basename(file)} line ${i + 1} does not parse: ${String(e).slice(0, 120)}`)
		}
		const id = row.resource_id ?? row.resourceId ?? row.state?.resource_id
		if (!id && !row.relationship_id) fail(3, `${path.basename(file)} line ${i + 1} has no resource id`)
		if (file.includes("memories-vault") && id) sampled.push(id)
	}
	console.log(`${path.basename(file)}: ${lines.length} row(s), samples parse clean`)
}

// --- 3. Live spot-check: sampled vault ids still resolve upstream ---
if (noLive) {
	console.log("live spot-check skipped (--no-live). OK.")
	process.exit(0)
}
const live = path.join(os.homedir(), ".openclaw", "openclaw.json")
const cfg = JSON.parse(fs.readFileSync(live, "utf8")).plugins?.entries?.["openclaw-hyperspell"]?.config ?? {}
const client = new Hyperspell({ apiKey: cfg.apiKey, userID: cfg.userId })
const picks = sampled.slice(0, 3)
for (const id of picks) {
	try {
		const doc = await client.memories.get(id, { source: "vault" })
		if (!doc || (doc.resource_id ?? doc.resourceId) !== id) fail(4, `live record ${id} did not match the mirror's id`)
		console.log(`live spot-check ok: ${id}`)
	} catch (e) {
		fail(4, `live spot-check could not fetch ${id}: ${String(e).slice(0, 140)} (availability or drift — investigate before trusting either copy)`)
	}
}
console.log("mirror verified: fresh, parseable, live-consistent. OK.")
