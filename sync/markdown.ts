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
 * Hash state file lives alongside the workspace memory dir.
 * Maps "filePath::sectionTitle" -> { hash, resourceId }
 */
interface SyncHashMap {
  [key: string]: { hash: string; resourceId?: string }
}

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
    if (/^# /.test(line) && !currentSection?.lines.length) {
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

// ---------------------------------------------------------------------------
// Hash tracking (persisted to workspace)
// ---------------------------------------------------------------------------

function hashFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, HASH_FILE_NAME)
}

export function loadHashMap(workspaceDir: string): SyncHashMap {
  const p = hashFilePath(workspaceDir)
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"))
    }
  } catch (err) {
    log.error("Failed to read sync hash file", err)
  }
  return {}
}

export function saveHashMap(workspaceDir: string, map: SyncHashMap): void {
  const p = hashFilePath(workspaceDir)
  try {
    fs.writeFileSync(p, JSON.stringify(map, null, 2))
  } catch (err) {
    log.error("Failed to write sync hash file", err)
  }
}

function sectionKey(filePath: string, sectionTitle: string): string {
  return `${filePath}::${sectionTitle}`
}

// ---------------------------------------------------------------------------
// Public API — file-level sync (original, kept for backward compat)
// ---------------------------------------------------------------------------

export function getMemoryFiles(workspaceDir: string): string[] {
  const memoryDir = path.join(workspaceDir, "memory")

  if (!fs.existsSync(memoryDir)) {
    return []
  }

  const results: string[] = []

  function walk(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
): string[] {
  const files = getMemoryFiles(workspaceDir)

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
): Promise<{ synced: number; skipped: number; failed: number; errors: string[] }> {
  const file = readMarkdownFile(filePath)
  if (!file || !file.content) {
    return { synced: 0, skipped: 0, failed: 0, errors: file ? [] : ["Failed to read file"] }
  }

  const sections = parseMarkdownSections(file.content, file.title)
  if (sections.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, errors: [] }
  }

  const hashMap = loadHashMap(workspaceDir)
  const fileName = path.basename(filePath, ".md")
  let synced = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []

  for (const section of sections) {
    const key = sectionKey(filePath, section.title)
    const existing = hashMap[key]

    // Skip if content hasn't changed
    if (existing?.hash === section.contentHash) {
      skipped++
      continue
    }

    // Build a title that includes file-level context for retrieval
    // e.g. "2026-05-09: The day David's mum got sick"
    const memoryTitle = file.title !== section.title
      ? `${file.title} — ${section.title}`
      : section.title

    try {
      const result = await client.addMemory(section.content, {
        title: memoryTitle,
        resourceId: existing?.resourceId,
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

      hashMap[key] = {
        hash: section.contentHash,
        resourceId: result.resourceId,
      }
      synced++
      log.info(`Synced section: ${memoryTitle} -> ${result.resourceId}`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      errors.push(`${memoryTitle}: ${errorMsg}`)
      failed++
    }
  }

  // Persist updated hashes
  if (synced > 0) {
    saveHashMap(workspaceDir, hashMap)
  }

  return { synced, skipped, failed, errors }
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
  options?: { userId?: string; watchPaths?: string[] },
): Promise<{ synced: number; skipped: number; failed: number; errors: string[] }> {
  const files = getSyncableFiles(workspaceDir, options?.watchPaths)
  let totalSynced = 0
  let totalSkipped = 0
  let totalFailed = 0
  const allErrors: string[] = []

  for (const filePath of files) {
    const result = await syncMarkdownFileSectionized(client, filePath, workspaceDir, {
      userId: options?.userId,
    })
    totalSynced += result.synced
    totalSkipped += result.skipped
    totalFailed += result.failed
    allErrors.push(...result.errors)
  }

  return { synced: totalSynced, skipped: totalSkipped, failed: totalFailed, errors: allErrors }
}
