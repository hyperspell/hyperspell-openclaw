import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import type { HyperspellClient } from "../client.ts"
import { log } from "../logger.ts"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/

interface MarkdownFile {
  filePath: string
  title: string
  content: string
  hyperspellId: string | null
}

interface MarkdownSection {
  title: string
  content: string
  /** SHA-256 of trimmed content for change detection */
  contentHash: string
  /** Line range in source file for debugging */
  startLine: number
  endLine: number
}

/**
 * Sync manifest persisted at <workspaceDir>/.hyperspell-sync-hashes.json.
 *
 * Keyed by workspace-RELATIVE file path so the manifest survives the workspace
 * being mounted at a different absolute path (new host / container / $HOME).
 * Each file tracks every section it has synced (title -> { hash, resourceId }),
 * which lets re-sync detect renamed sections (same content hash resurfacing
 * under a new title) and deleted sections (title gone from source) instead of
 * leaking duplicate or orphaned memories into the retrieval layer.
 */
interface SectionRecord {
  hash: string
  resourceId?: string
}

interface FileManifest {
  sections: Record<string, SectionRecord>
}

interface SyncManifest {
  version: number
  files: Record<string, FileManifest>
}

const MANIFEST_VERSION = 1
const HASH_FILE_NAME = ".hyperspell-sync-hashes.json"

// ---------------------------------------------------------------------------
// Frontmatter helpers (unchanged from original)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterText = match[1]
  const body = content.slice(match[0].length)
  const frontmatter: Record<string, string> = {}

  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":")
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      frontmatter[key] = value
    }
  }

  return { frontmatter, body }
}

function serializeFrontmatter(frontmatter: Record<string, string>): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join("\n")}\n---\n`
}

function readMarkdownFile(filePath: string): MarkdownFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const { frontmatter, body } = parseFrontmatter(content)
    const title = frontmatter.title || path.basename(filePath, ".md")

    return {
      filePath,
      title,
      content: body.trim(),
      hyperspellId: frontmatter.hyperspell_id || null,
    }
  } catch (err) {
    log.error(`Failed to read markdown file: ${filePath}`, err)
    return null
  }
}

function updateFrontmatterId(filePath: string, hyperspellId: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const { frontmatter, body } = parseFrontmatter(content)

    frontmatter.hyperspell_id = hyperspellId

    const newContent = serializeFrontmatter(frontmatter) + body
    fs.writeFileSync(filePath, newContent)

    log.debug(`Updated frontmatter in ${filePath} with hyperspell_id: ${hyperspellId}`)
  } catch (err) {
    log.error(`Failed to update frontmatter in ${filePath}`, err)
  }
}

// ---------------------------------------------------------------------------
// Section-level parsing
// ---------------------------------------------------------------------------

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)
}

/**
 * Split markdown content into sections delimited by ## headings.
 * Content before the first ## heading becomes a section titled after the
 * file-level # heading (or the filename).
 *
 * Sections shorter than `minLength` characters are merged into the previous
 * section to avoid noisy micro-memories.
 */
export function parseMarkdownSections(
  content: string,
  fallbackTitle: string,
  minLength = 80,
): MarkdownSection[] {
  const lines = content.split("\n")
  const raw: Array<{ title: string; lines: string[]; startLine: number }> = []

  let fileTitle = fallbackTitle
  let currentSection: { title: string; lines: string[]; startLine: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Capture file-level title from # heading
    if (/^# /.test(line) && currentSection === null) {
      fileTitle = line.replace(/^# /, "").trim()
      continue
    }

    // New section on ## heading
    if (/^## /.test(line)) {
      if (currentSection) {
        raw.push(currentSection)
      }
      currentSection = {
        title: line.replace(/^## /, "").trim(),
        lines: [],
        startLine: i + 1,
      }
      continue
    }

    if (currentSection) {
      currentSection.lines.push(line)
    } else {
      // Content before any ## heading — becomes preamble section
      if (!raw.length) {
        currentSection = { title: fileTitle, lines: [line], startLine: i + 1 }
      }
    }
  }

  if (currentSection) {
    raw.push(currentSection)
  }

  // Merge short sections into the previous one
  const merged: MarkdownSection[] = []
  for (const section of raw) {
    const text = section.lines.join("\n").trim()
    if (!text) continue

    if (text.length < minLength && merged.length > 0) {
      // Append to previous section
      const prev = merged[merged.length - 1]
      prev.content += `\n\n### ${section.title}\n${text}`
      prev.contentHash = contentHash(prev.content)
      prev.endLine = section.startLine + section.lines.length
    } else {
      merged.push({
        title: section.title,
        content: text,
        contentHash: contentHash(text),
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length,
      })
    }
  }

  return merged
}

/**
 * Section titles key the manifest per file, so two sections sharing the same
 * ## heading in one file would collide — one resourceId tracked, the other
 * silently orphaned and re-uploaded on every sync. Disambiguate repeats so
 * each section maps to a stable, unique key.
 */
export function dedupeTitles(sections: MarkdownSection[]): MarkdownSection[] {
  const seen = new Map<string, number>()
  return sections.map((s) => {
    const n = (seen.get(s.title) ?? 0) + 1
    seen.set(s.title, n)
    return n === 1 ? s : { ...s, title: `${s.title} (${n})` }
  })
}

// ---------------------------------------------------------------------------
// Sync manifest (persisted to workspace, workspace-relative keys)
// ---------------------------------------------------------------------------

function manifestPath(workspaceDir: string): string {
  return path.join(workspaceDir, HASH_FILE_NAME)
}

/** Workspace-relative, posix-normalized key so the manifest is portable. */
export function fileKey(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/")
}

function emptyManifest(): SyncManifest {
  return { version: MANIFEST_VERSION, files: {} }
}

export function loadManifest(workspaceDir: string): SyncManifest {
  const p = manifestPath(workspaceDir)
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<SyncManifest>
      // Forward-migrate rather than discard. Throwing the manifest away on a
      // version bump means every section re-uploads on the next run — the
      // exact full-re-ingest load this guard exists to prevent. As long as the
      // `files` map is structurally a record we keep it: the per-section hash
      // check still gates every upload, so a stale-but-readable manifest is
      // strictly better than an empty one. Only a missing/corrupt `files`
      // (truly unusable) falls back to empty.
      if (parsed && typeof parsed.files === "object" && parsed.files !== null) {
        return { version: MANIFEST_VERSION, files: parsed.files }
      }
    }
  } catch (err) {
    log.error("Failed to read sync manifest", err)
  }
  return emptyManifest()
}

export function saveManifest(workspaceDir: string, manifest: SyncManifest): void {
  const p = manifestPath(workspaceDir)
  // Atomic write: a process killed mid-write (deploy/restart) would otherwise
  // leave a truncated JSON file, which loadManifest can only treat as corrupt
  // -> empty -> full re-ingest. Write to a temp sibling, then rename (atomic
  // on the same filesystem) so readers only ever see a complete manifest.
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2))
    fs.renameSync(tmp, p)
  } catch (err) {
    log.error("Failed to write sync manifest", err)
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Serializes manifest read-modify-write across the whole process. Startup bulk
 * sync and the live file_changed handler (plus independent per-file debounce
 * timers) would otherwise interleave load → await addMemory → save and lose
 * resourceId entries, causing the next sync to re-upload sections as brand-new
 * memories. Every load→sync→save runs inside this critical section.
 */
let syncChain: Promise<unknown> = Promise.resolve()
export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = syncChain.then(fn, fn)
  syncChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------------------------------------------------------------------
// Public API — file-level sync (original, kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Directory names skipped by default when walking memory/. The dreaming engine
 * writes first-person dream journals under memory/dreaming/ that are not user
 * memories; ingesting them pollutes retrieval (they score highly on emotional/
 * associative queries and crowd out real memories). Configurable via
 * `syncMemories.ignorePaths`.
 */
export const DEFAULT_IGNORE_DIRS = ["dreaming"]

/**
 * Skip a directory entry during the walk when it is a dot-directory/file
 * (e.g. `.dreams`, engine scaffolding) or a directory named in `ignore`.
 * Dot-entries are always skipped regardless of the configured list.
 */
function isIgnoredEntry(entry: fs.Dirent, ignore: Set<string>): boolean {
  if (entry.name.startsWith(".")) return true
  if (entry.isDirectory() && ignore.has(entry.name)) return true
  return false
}

export function getMemoryFiles(
  workspaceDir: string,
  ignorePaths?: string[],
): string[] {
  const memoryDir = path.join(workspaceDir, "memory")

  if (!fs.existsSync(memoryDir)) {
    return []
  }

  const ignore = new Set(ignorePaths ?? DEFAULT_IGNORE_DIRS)
  const results: string[] = []

  function walk(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isIgnoredEntry(entry, ignore)) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith(".md")) {
          results.push(fullPath)
        }
      }
    } catch (err) {
      log.error(`Failed to read directory: ${dir}`, err)
    }
  }

  walk(memoryDir)
  return results
}

/**
 * Collect all syncable files based on configuration.
 * Includes memory/*.md by default, plus any additional watchPaths.
 */
export function getSyncableFiles(
  workspaceDir: string,
  watchPaths?: string[],
  ignorePaths?: string[],
): string[] {
  const ignore = new Set(ignorePaths ?? DEFAULT_IGNORE_DIRS)
  const files = getMemoryFiles(workspaceDir, ignorePaths)

  if (watchPaths) {
    for (const wp of watchPaths) {
      const resolved = wp.startsWith("/") ? wp : path.join(workspaceDir, wp)

      if (!fs.existsSync(resolved)) continue

      const stat = fs.statSync(resolved)
      if (stat.isFile() && resolved.endsWith(".md")) {
        if (!files.includes(resolved)) {
          files.push(resolved)
        }
      } else if (stat.isDirectory()) {
        // Walk directory for .md files
        const walk = (dir: string) => {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (isIgnoredEntry(entry, ignore)) continue
              const fullPath = path.join(dir, entry.name)
              if (entry.isDirectory()) {
                walk(fullPath)
              } else if (entry.name.endsWith(".md") && !files.includes(fullPath)) {
                files.push(fullPath)
              }
            }
          } catch (_err) { /* skip unreadable dirs */ }
        }
        walk(resolved)
      }
    }
  }

  return files
}

/**
 * Original whole-file sync (kept for backward compatibility when
 * sectionize is false).
 */
export async function syncMarkdownFile(
  client: HyperspellClient,
  filePath: string,
  options?: { userId?: string },
): Promise<{ success: boolean; resourceId?: string; error?: string }> {
  const file = readMarkdownFile(filePath)
  if (!file) {
    return { success: false, error: "Failed to read file" }
  }

  if (!file.content) {
    return { success: false, error: "File has no content" }
  }

  try {
    const result = await client.addMemory(file.content, {
      title: file.title,
      resourceId: file.hyperspellId || undefined,
      collection: "openclaw",
      metadata: {
        openclaw_source: "memory_sync",
        file_path: filePath,
      },
      userId: options?.userId,
    })

    if (result.resourceId !== file.hyperspellId) {
      updateFrontmatterId(filePath, result.resourceId)
    }

    return { success: true, resourceId: result.resourceId }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to sync ${filePath}`, err)
    return { success: false, error: errorMsg }
  }
}

// ---------------------------------------------------------------------------
// Section-level sync (new)
// ---------------------------------------------------------------------------

/**
 * Sync a single markdown file to Hyperspell at section granularity.
 * Each ## section becomes a separate memory. Content hashes are tracked
 * so unchanged sections are skipped on subsequent syncs.
 *
 * The section title is prepended with the file-level context (e.g.
 * "2026-05-09 — The day David's mum got sick") for better retrieval.
 */
export async function syncMarkdownFileSectionized(
  client: HyperspellClient,
  filePath: string,
  workspaceDir: string,
  options?: { userId?: string },
): Promise<{
  synced: number
  skipped: number
  failed: number
  removed: number
  errors: string[]
}> {
  return withSyncLock(async () => {
    const empty = { synced: 0, skipped: 0, failed: 0, removed: 0, errors: [] as string[] }
    try {
      const file = readMarkdownFile(filePath)
      if (!file || !file.content) {
        return file ? empty : { ...empty, errors: ["Failed to read file"] }
      }

      const sections = dedupeTitles(parseMarkdownSections(file.content, file.title))
      if (sections.length === 0) {
        return empty
      }

      const manifest = loadManifest(workspaceDir)
      const key = fileKey(workspaceDir, filePath)
      const prevSections = manifest.files[key]?.sections ?? {}
      const fileName = path.basename(filePath, ".md")

      let synced = 0
      let skipped = 0
      let failed = 0
      let removed = 0
      let dirty = false
      const errors: string[] = []

      const currentTitles = new Set(sections.map((s) => s.title))

      // Sections in the manifest but absent from the current parse are either
      // renames (same content hash resurfacing under a new title) or true
      // deletions. Index leftovers by content hash so a renamed section can
      // reclaim its existing Hyperspell resource instead of creating a
      // duplicate + orphan. Hash collisions among removed sections are rare
      // and resolved best-effort (last writer wins).
      const orphanByHash = new Map<string, { title: string; resourceId?: string }>()
      for (const [title, rec] of Object.entries(prevSections)) {
        if (!currentTitles.has(title)) {
          orphanByHash.set(rec.hash, { title, resourceId: rec.resourceId })
        }
      }

      const newSections: Record<string, SectionRecord> = {}

      for (const section of sections) {
        const prev = prevSections[section.title]

        // Unchanged: keep the record, skip the upload.
        if (prev && prev.hash === section.contentHash) {
          newSections[section.title] = prev
          skipped++
          continue
        }

        // New title: if identical content was just removed under a different
        // heading, this is a rename — reuse the resource and claim it so it is
        // not also deleted as an orphan below.
        let reuseResourceId = prev?.resourceId
        if (!prev) {
          const renamedFrom = orphanByHash.get(section.contentHash)
          if (renamedFrom) {
            reuseResourceId = renamedFrom.resourceId
            orphanByHash.delete(section.contentHash)
            log.info(
              `Section renamed: "${renamedFrom.title}" -> "${section.title}" (${fileName}) — updating in place`,
            )
          }
        }

        const memoryTitle =
          file.title !== section.title ? `${file.title} — ${section.title}` : section.title

        try {
          const result = await client.addMemory(section.content, {
            title: memoryTitle,
            resourceId: reuseResourceId,
            collection: "openclaw",
            metadata: {
              openclaw_source: "memory_sync_section",
              file_path: filePath,
              file_name: fileName,
              section_title: section.title,
              content_hash: section.contentHash,
            },
            userId: options?.userId,
          })

          newSections[section.title] = {
            hash: section.contentHash,
            resourceId: result.resourceId,
          }
          synced++
          dirty = true
          log.info(`Synced section: ${memoryTitle} -> ${result.resourceId}`)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          errors.push(`${memoryTitle}: ${errorMsg}`)
          failed++
          // Preserve the prior record so a transient failure does not drop the
          // resourceId and force a duplicate upload next run.
          if (prev) newSections[section.title] = prev
        }
      }

      // Whatever remains is a genuine deletion: gone from source, no rename
      // reclaimed it. Delete the remote memory so retrieval does not keep
      // serving content the user removed.
      for (const { title, resourceId } of orphanByHash.values()) {
        if (!resourceId) {
          // Never got a resourceId — nothing to delete, just drop the record.
          dirty = true
          continue
        }
        const { deleted } = await client.deleteMemory(resourceId, {
          userId: options?.userId,
        })
        if (deleted) {
          removed++
          dirty = true
          log.info(`Removed deleted section "${title}" (${fileName}) -> ${resourceId}`)
        } else {
          // Keep the record so the delete is retried next run rather than
          // silently leaking the orphan into the retrieval layer. Count it
          // as a failure so the stats are consistent and callers that gate
          // logging on `failed > 0` actually surface it.
          newSections[title] = prevSections[title]
          failed++
          errors.push(`delete "${title}": failed`)
        }
      }

      if (Object.keys(newSections).length > 0) {
        manifest.files[key] = { sections: newSections }
      } else {
        delete manifest.files[key]
      }

      if (dirty) {
        saveManifest(workspaceDir, manifest)
      }

      return { synced, skipped, failed, removed, errors }
    } catch (err) {
      // The body is defensive everywhere above; this guards the lock chain
      // against an unexpected throw so one bad file cannot wedge the queue.
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Sectionized sync crashed for ${filePath}`, err)
      return { ...empty, errors: [msg] }
    }
  })
}

// ---------------------------------------------------------------------------
// Bulk sync (original whole-file approach)
// ---------------------------------------------------------------------------

export async function syncAllMemoryFiles(
  client: HyperspellClient,
  workspaceDir: string,
  options?: { userId?: string },
): Promise<{ synced: number; failed: number; errors: string[] }> {
  const files = getMemoryFiles(workspaceDir)
  let synced = 0
  let failed = 0
  const errors: string[] = []

  for (const filePath of files) {
    const result = await syncMarkdownFile(client, filePath, { userId: options?.userId })
    if (result.success) {
      synced++
      log.info(`Synced: ${path.basename(filePath)} -> ${result.resourceId}`)
    } else {
      failed++
      errors.push(`${path.basename(filePath)}: ${result.error}`)
    }
  }

  return { synced, failed, errors }
}

// ---------------------------------------------------------------------------
// Bulk sync (section-level approach)
// ---------------------------------------------------------------------------

/**
 * Sync all syncable files at section granularity.
 * Unchanged sections (by content hash) are skipped.
 */
export async function syncAllFilesSectionized(
  client: HyperspellClient,
  workspaceDir: string,
  options?: {
    userId?: string
    watchPaths?: string[]
    maxAgeDays?: number
    ignorePaths?: string[]
  },
): Promise<{
  synced: number
  skipped: number
  failed: number
  removed: number
  agedOut: number
  errors: string[]
}> {
  const files = getSyncableFiles(
    workspaceDir,
    options?.watchPaths,
    options?.ignorePaths,
  )

  // Age pre-filter: a file untouched for longer than maxAgeDays that is
  // already recorded in the manifest has been ingested at least once and is
  // not changing — re-parsing/hashing/diffing it every startup is pure churn.
  // Files NOT yet in the manifest are always processed regardless of age, so
  // a genuinely cold start (or a never-synced old file) still ingests once.
  // The live file_changed handler is unaffected: an edit bumps mtime, so
  // edited-but-old files re-enter the window naturally.
  const maxAgeDays = options?.maxAgeDays ?? 0
  let candidates = files
  let agedOut = 0
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const manifest = loadManifest(workspaceDir)
    candidates = files.filter((filePath) => {
      const key = fileKey(workspaceDir, filePath)
      const known = manifest.files[key] !== undefined
      if (!known) return true
      try {
        if (fs.statSync(filePath).mtimeMs >= cutoff) return true
      } catch {
        return true // stat failed — be safe, process it
      }
      agedOut++
      return false
    })
    if (agedOut > 0) {
      log.info(
        `Skipping ${agedOut} unchanged file(s) older than ${maxAgeDays}d (already synced)`,
      )
    }
  }

  let totalSynced = 0
  let totalSkipped = 0
  let totalFailed = 0
  let totalRemoved = 0
  const allErrors: string[] = []

  for (const filePath of candidates) {
    const result = await syncMarkdownFileSectionized(client, filePath, workspaceDir, {
      userId: options?.userId,
    })
    totalSynced += result.synced
    totalSkipped += result.skipped
    totalFailed += result.failed
    totalRemoved += result.removed
    allErrors.push(...result.errors)
  }

  return {
    synced: totalSynced,
    skipped: totalSkipped,
    failed: totalFailed,
    removed: totalRemoved,
    agedOut,
    errors: allErrors,
  }
}
