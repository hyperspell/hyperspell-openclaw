import * as path from "node:path"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { getWorkspaceDir } from "../config.ts"
import { log } from "../logger.ts"
import { syncMarkdownFile, syncAllMemoryFiles } from "../sync/markdown.ts"

/**
 * Build a handler for file change events that syncs markdown files to Hyperspell
 */
export function buildFileSyncHandler(client: HyperspellClient, _cfg: HyperspellConfig) {
  const workspaceDir = getWorkspaceDir()
  const memoryDir = path.join(workspaceDir, "memory")

  return async (event: Record<string, unknown>) => {
    const filePath = event.file_path as string | undefined
    if (!filePath) return

    // Only process markdown files in the workspace's memory directory
    if (!filePath.startsWith(memoryDir) || !filePath.endsWith(".md")) {
      return
    }

    const fileName = path.basename(filePath)
    log.info(`Memory file changed: ${fileName}`)

    try {
      const result = await syncMarkdownFile(client, filePath)
      if (result.success) {
        log.info(`Synced ${fileName} -> ${result.resourceId}`)
      } else {
        log.error(`Failed to sync ${fileName}: ${result.error}`)
      }
    } catch (err) {
      log.error(`Error syncing ${fileName}`, err)
    }
  }
}

/**
 * Sync all existing memory files on startup
 */
export async function syncMemoriesOnStartup(
  client: HyperspellClient,
  workspaceDir: string,
): Promise<void> {
  log.info("Syncing existing memory files...")

  const result = await syncAllMemoryFiles(client, workspaceDir)

  if (result.synced > 0) {
    log.info(`Synced ${result.synced} memory files`)
  }
  if (result.failed > 0) {
    log.error(`Failed to sync ${result.failed} files:`)
    for (const error of result.errors) {
      log.error(`  - ${error}`)
    }
  }
  if (result.synced === 0 && result.failed === 0) {
    log.info("No memory files found in memory/ directory")
  }
}
