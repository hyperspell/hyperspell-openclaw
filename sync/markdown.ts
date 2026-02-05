import * as fs from "node:fs"
import * as path from "node:path"
import type { HyperspellClient } from "../client.ts"
import { log } from "../logger.ts"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/

interface MarkdownFile {
  filePath: string
  title: string
  content: string
  hyperspellId: string | null
}

/**
 * Parse frontmatter from markdown content
 */
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

/**
 * Serialize frontmatter back to string
 */
function serializeFrontmatter(frontmatter: Record<string, string>): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join("\n")}\n---\n`
}

/**
 * Read a markdown file and parse its content
 */
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

/**
 * Update the hyperspell_id in the frontmatter of a markdown file
 */
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

/**
 * Get all markdown files from the memory directory
 */
export function getMemoryFiles(workspaceDir: string): string[] {
  const memoryDir = path.join(workspaceDir, "memory")

  if (!fs.existsSync(memoryDir)) {
    return []
  }

  try {
    const files = fs.readdirSync(memoryDir)
    return files
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.join(memoryDir, file))
  } catch (err) {
    log.error("Failed to read memory directory", err)
    return []
  }
}

/**
 * Sync a single markdown file to Hyperspell
 */
export async function syncMarkdownFile(
  client: HyperspellClient,
  filePath: string,
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
    })

    // Update frontmatter with new resource ID if it changed or was newly created
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

/**
 * Sync all markdown files in the memory directory
 */
export async function syncAllMemoryFiles(
  client: HyperspellClient,
  workspaceDir: string,
): Promise<{ synced: number; failed: number; errors: string[] }> {
  const files = getMemoryFiles(workspaceDir)
  let synced = 0
  let failed = 0
  const errors: string[] = []

  for (const filePath of files) {
    const result = await syncMarkdownFile(client, filePath)
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
