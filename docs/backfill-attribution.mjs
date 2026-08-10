// Backfill speaker labels onto historical hot-buffer rows (attribution v3 follow-up).
//
// Why: rows written before 2026-08-10 carry no speaker label, and the backend
// stamps every message's sender with the vault user — so the consolidator
// summarized David's words as A Linea's (and vice versa). The forward fix
// labels every new row; this script relabels the old ones.
//
// How it can be deterministic: hot-buffer message_ids are our own FNV ids,
// `u-<hash>` for user rows and `a-<hash>` for assistant rows — the role
// survives in the vault as each message's external_id. POST /messages upserts
// on (app, user, resource_id, message_id) and updates content in place, so
// re-posting `[David]: <original>` under the same message_id relabels the row
// without duplicating it.
//
// Safety:
//   - Rows whose text already starts with "[" are SKIPPED — covers rows the
//     forward fix already labeled, PR #60 group-chat prefixes, and cron
//     prompts ("[cron:...] ..."), which are not David speaking.
//   - Rows whose external_id isn't u-/a- prefixed are SKIPPED and counted
//     (can't recover the role — never guess).
//   - Every original row is appended to a JSONL backup BEFORE any write.
//
// Usage:
//   node docs/backfill-attribution.mjs                       # dry-run scan: counts + samples, no writes
//   node docs/backfill-attribution.mjs --pilot <resource_id> # relabel ONE resource (writes!)
//   node docs/backfill-attribution.mjs --execute             # relabel the whole vault (writes!)
//
// Labels match Alinea's live config (hotBuffer.userLabel / assistantLabel).
// Backup: ~/.openclaw/attribution-backfill/originals-<runstamp>.jsonl

import fs from "node:fs"
import path from "node:path"
import Hyperspell from "hyperspell"

const API_BASE_URL = "https://api.hyperspell.com"

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"))
	.plugins.entries["openclaw-hyperspell"].config
const apiKey = cfg.apiKey
const userId = cfg.userId
const USER_LABEL = cfg.hotBuffer?.userLabel ?? "User"
const ASSISTANT_LABEL = cfg.hotBuffer?.assistantLabel ?? "Assistant"

if (!apiKey || !userId) {
	console.error("apiKey/userId missing from config — aborting.")
	process.exit(1)
}

const client = new Hyperspell({ apiKey, userID: userId })
const ro = { headers: { "X-As-User": userId } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
const EXECUTE = args.includes("--execute")
const pilotIdx = args.indexOf("--pilot")
const PILOT = pilotIdx >= 0 ? args[pilotIdx + 1] : undefined
const WRITE = EXECUTE || !!PILOT

const backupDir = path.join(process.env.HOME, ".openclaw", "attribution-backfill")
const runstamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupFile = path.join(backupDir, `originals-${runstamp}.jsonl`)

function classify(msg) {
	const text = msg.children?.map((c) => c.text ?? "").join("\n") ?? ""
	const extId = msg.external_id ?? ""
	if (text.trim().length === 0) return { kind: "empty", text }
	if (text.startsWith("[")) return { kind: "already-labeled-or-special", text }
	if (extId.startsWith("u-")) return { kind: "relabel", role: "user", label: USER_LABEL, text }
	if (extId.startsWith("a-")) return { kind: "relabel", role: "assistant", label: ASSISTANT_LABEL, text }
	return { kind: "unknown-id", text }
}

async function listConversations() {
	const out = []
	let cursor = undefined
	do {
		const page = await client.memories.list(
			{ source: "vault", limit: 100, ...(cursor ? { cursor } : {}) },
			ro,
		)
		for (const it of page.items ?? []) {
			if ((it.type ?? "") === "conversation") out.push(it.resource_id ?? it.id)
		}
		cursor = page.next_cursor ?? undefined
	} while (cursor)
	return out
}

async function relabelBatch(resourceId, rows) {
	// Same wire shape as the plugin's sendMessages: upsert by message_id.
	const body = {
		source: "vault",
		messages: rows.map((r) => ({
			resource_id: resourceId,
			message_id: r.messageId,
			content: r.newContent,
			metadata: {
				openclaw_speaker_role: r.role,
				openclaw_speaker_name: r.label,
				openclaw_backfilled: "attribution-2026-08-10",
			},
		})),
	}
	const res = await fetch(`${API_BASE_URL}/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"X-As-User": userId,
		},
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`POST /messages ${res.status}: ${await res.text().catch(() => "")}`)
	return rows.length
}

const totals = { resources: 0, relabelUser: 0, relabelAssistant: 0, skippedLabeled: 0, skippedUnknownId: 0, empty: 0 }
const samples = []
let written = 0

const resourceIds = PILOT ? [PILOT] : await listConversations()
console.log(`${resourceIds.length} conversation resource(s) to scan${WRITE ? (PILOT ? " [PILOT WRITE]" : " [EXECUTE]") : " [dry-run]"}`)

if (WRITE) fs.mkdirSync(backupDir, { recursive: true })

for (const rid of resourceIds) {
	let doc
	try {
		doc = await client.memories.get(rid, { source: "vault" }, ro)
	} catch (e) {
		console.log(`  skip ${rid}: get failed (${String(e).slice(0, 80)})`)
		continue
	}
	totals.resources++
	const pending = []
	for (const msg of doc?.document?.children ?? []) {
		const c = classify(msg)
		if (c.kind === "relabel") {
			totals[c.role === "user" ? "relabelUser" : "relabelAssistant"]++
			if (samples.length < 6) samples.push(`${rid} ${msg.external_id} -> [${c.label}]: ${c.text.slice(0, 60)}`)
			pending.push({
				messageId: msg.external_id,
				role: c.role,
				label: c.label,
				original: c.text,
				newContent: `[${c.label}]: ${c.text}`,
			})
		} else if (c.kind === "already-labeled-or-special") totals.skippedLabeled++
		else if (c.kind === "unknown-id") totals.skippedUnknownId++
		else totals.empty++
	}

	if (WRITE && pending.length > 0) {
		for (const r of pending) {
			fs.appendFileSync(
				backupFile,
				JSON.stringify({ resource_id: rid, message_id: r.messageId, original: r.original }) + "\n",
			)
		}
		// Chunk to stay far under the 1000-message / 5MB batch limits.
		for (let i = 0; i < pending.length; i += 200) {
			written += await relabelBatch(rid, pending.slice(i, i + 200))
		}
		console.log(`  relabeled ${pending.length} row(s) in ${rid}`)
		await sleep(150)
	}
}

console.log("\n--- summary ---")
console.log(totals)
if (!WRITE) {
	console.log("\nsamples:")
	for (const s of samples) console.log(" ", s)
	console.log("\nDry run only — nothing written. Use --pilot <resource_id> or --execute.")
} else {
	console.log(`rows written: ${written}`)
	console.log(`backup of originals: ${backupFile}`)
}
