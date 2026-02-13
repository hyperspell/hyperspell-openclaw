import * as fs from "node:fs"
import * as path from "node:path"
import type { HyperspellClient } from "../client.ts"
import { log } from "../logger.ts"
import { NetworkStateManager } from "./state.ts"

const ENTITY_TYPES = ["people", "projects", "organizations", "topics"] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export interface SourceMemories {
  [source: string]: string[]
}

export interface ScannedMemory {
  resourceId: string
  source: string
  title: string | null
  summary: string
}

export interface WriteEntityParams {
  type: EntityType
  slug: string
  name: string
  description: string
  relationships?: string[]
  sourceMemories?: SourceMemories
  email?: string
  phone?: string
  domain?: string
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function summarizeMemoryData(data: unknown[], source: string): string {
  if (!Array.isArray(data) || data.length === 0) return ""

  const items = data as Array<Record<string, unknown>>

  if (source === "slack" || source === "google_mail") {
    const senders = new Map<string, string>()
    const messages: string[] = []
    for (const item of items) {
      const sender = item.sender as Record<string, unknown> | undefined
      if (sender?.name && sender?.email) {
        senders.set(String(sender.email), String(sender.name))
      }
      if (item.content && messages.length < 5) {
        messages.push(String(item.content).slice(0, 200))
      }
    }
    const parts: string[] = []
    if (senders.size > 0) {
      parts.push(`Participants: ${[...senders.entries()].map(([e, n]) => `${n} <${e}>`).join(", ")}`)
    }
    if (messages.length > 0) {
      parts.push(`Recent messages:\n${messages.join("\n---\n")}`)
    }
    return parts.join("\n\n")
  }

  if (source === "notion") {
    const parts: string[] = []
    for (const item of items.slice(0, 10)) {
      if (item.__type === "Title" && item.text) {
        parts.push(`## ${item.text}`)
      } else if (item.__type === "Markdown" && item.text) {
        parts.push(String(item.text).slice(0, 300))
      } else if (item.__type === "Table" && item.table_rows) {
        const rows = item.table_rows as string[][]
        if (rows[0]) parts.push(`Table: ${rows[0].join(" | ")}`)
      }
    }
    return parts.join("\n")
  }

  const parts: string[] = []
  for (const item of items.slice(0, 10)) {
    if (item.text) {
      parts.push(String(item.text).slice(0, 300))
    }
  }
  return parts.join("\n")
}

export async function scanMemories(
  client: HyperspellClient,
  stateManager: NetworkStateManager,
  batchSize: number,
): Promise<ScannedMemory[]> {
  const unprocessed: ScannedMemory[] = []

  for await (const mem of client.listMemories()) {
    if (stateManager.isProcessed(mem.resourceId)) continue
    if (mem.metadata?.graph_entity === "true" || mem.metadata?.graph_entity === true) continue
    if ((mem.metadata?.status as string) !== "completed") continue

    let summary = ""
    try {
      const full = await client.getMemory(mem.resourceId, mem.source)
      const data = full.data as unknown[] | undefined

      const participants = full.participants as Array<{ name?: string; email?: string }> | undefined
      const participantLine = participants?.length
        ? `Participants: ${participants.map((p) => `${p.name || ""} <${p.email || ""}>`).join(", ")}`
        : ""

      const dataSummary = data ? summarizeMemoryData(data, mem.source) : ""
      summary = [participantLine, dataSummary].filter(Boolean).join("\n\n")
    } catch {
      summary = "(content unavailable)"
    }

    unprocessed.push({
      resourceId: mem.resourceId,
      source: mem.source,
      title: mem.title,
      summary: summary.slice(0, 1000),
    })

    if (unprocessed.length >= batchSize) break
  }

  return unprocessed
}

export function formatScanResults(memories: ScannedMemory[], processedCount: number, lastScan: string | null): string {
  if (memories.length === 0) {
    return `No unprocessed memories found. ${processedCount} memories already processed. Last scan: ${lastScan || "never"}`
  }

  const formatted = memories
    .map((m) => {
      const lines = [`[${m.source}] ${m.title || "(untitled)"} (id: ${m.resourceId})`]
      if (m.summary) lines.push(m.summary)
      return lines.join("\n")
    })
    .join("\n\n---\n\n")

  return `Found ${memories.length} unprocessed memories:\n\n${formatted}`
}

export function writeEntity(workspaceDir: string, params: WriteEntityParams): string {
  const slug = slugify(params.slug)
  const dir = path.join(workspaceDir, "memory", params.type)
  const filePath = path.join(dir, `${slug}.md`)

  fs.mkdirSync(dir, { recursive: true })

  // Check for existing file and merge
  let existingSourceMemories: SourceMemories = {}
  let existingRelationships: string[] = []
  let hyperspellId = ""

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8")
    const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n?/)
    if (fmMatch) {
      const fmText = fmMatch[1]
      for (const line of fmText.split("\n")) {
        const idx = line.indexOf(":")
        if (idx <= 0) continue
        const key = line.slice(0, idx).trim()
        const val = line.slice(idx + 1).trim()
        if (key === "hyperspell_id") hyperspellId = val
        if (key === "source_memories") {
          try { existingSourceMemories = JSON.parse(val) } catch {}
        }
        if (key === "relationships") {
          try { existingRelationships = JSON.parse(val) } catch {}
        }
      }
    }
  }

  // Merge source memories
  const mergedSources: SourceMemories = { ...existingSourceMemories }
  if (params.sourceMemories) {
    for (const [source, ids] of Object.entries(params.sourceMemories)) {
      const existing = mergedSources[source] || []
      const merged = [...new Set([...existing, ...ids])]
      mergedSources[source] = merged
    }
  }

  // Merge relationships
  const mergedRelationships = [
    ...new Set([...existingRelationships, ...(params.relationships || [])]),
  ]

  // Build frontmatter
  const fm: Record<string, string> = {
    title: params.name,
    type: params.type.slice(0, -1), // "people" → "person"
    graph_entity: "true",
    source_memories: JSON.stringify(mergedSources),
    last_extracted: new Date().toISOString(),
  }
  if (hyperspellId) fm.hyperspell_id = hyperspellId
  if (mergedRelationships.length > 0) {
    fm.relationships = JSON.stringify(mergedRelationships)
  }
  if (params.email) fm.email = params.email
  if (params.phone) fm.phone = params.phone
  if (params.domain) fm.domain = params.domain

  // Build body
  const bodyParts = [`# ${params.name}\n`, params.description]

  const contactParts: string[] = []
  if (params.email) contactParts.push(`- Email: ${params.email}`)
  if (params.phone) contactParts.push(`- Phone: ${params.phone}`)
  if (params.domain) contactParts.push(`- Domain: ${params.domain}`)
  if (contactParts.length > 0) {
    bodyParts.push("\n## Contact\n")
    bodyParts.push(...contactParts)
  }

  if (mergedRelationships.length > 0) {
    bodyParts.push("\n## Relationships\n")
    for (const rel of mergedRelationships) {
      const [relationship, target] = rel.split(":")
      if (target) {
        const targetName = target.split("/").pop()?.replace(/-/g, " ") || target
        bodyParts.push(`- ${relationship}: [${targetName}](../${target}.md)`)
      } else {
        bodyParts.push(`- ${rel}`)
      }
    }
  }

  // Build file content
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  const content = `---\n${fmLines.join("\n")}\n---\n${bodyParts.join("\n")}\n`

  fs.writeFileSync(filePath, content)
  log.info(`Wrote entity: ${params.type}/${slug}.md`)

  return `${params.type}/${slug}.md`
}

export function completeMemories(stateManager: NetworkStateManager, memoryIds: string[]): { newCount: number; totalCount: number } {
  const newCount = stateManager.markProcessed(memoryIds)
  stateManager.updateLastScan()
  stateManager.save()
  return { newCount, totalCount: stateManager.getProcessedCount() }
}
