import * as path from "node:path"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { getWorkspaceDir } from "../config.ts"
import { log } from "../logger.ts"
import {
  syncMarkdownFile,
  syncMarkdownFileSectionized,
  syncAllMemoryFiles,
  syncAllFilesSectionized,
} from "../sync/markdown.ts"

/**
 * Build a handler for file change events that syncs markdown files to Hyperspell.
 *
 * When `sectionize` is enabled (default for new config), files are split by
 * ## headings and each section is synced as a separate memory. Unchanged
 * sections (tracked by content hash) are skipped.
 *
 * When `sectionize` is false (legacy mode), entire files are uploaded as
 * single memories.
 */
export function buildFileSyncHandler(client: HyperspellClient, cfg: HyperspellConfig) {
  const workspaceDir = getWorkspaceDir()
  const memoryDir = path.join(workspaceDir, "memory")
  const syncUserId = cfg.multiUser?.sharedUserId
  const sectionize = cfg.syncMemoriesConfig.sectionize
  const watchPaths = cfg.syncMemoriesConfig.watchPaths
  const debounceMs = cfg.syncMemoriesConfig.debounceMs
  const ignoreDirs = new Set(cfg.syncMemoriesConfig.ignorePaths)

  // Resolve additional watch paths to absolute paths for matching
  const resolvedWatchPaths = (watchPaths ?? []).map((wp) =>
    wp.startsWith("/") ? wp : path.join(workspaceDir, wp),
  )

  /**
   * Mirror the bulk walk's exclusions on the live path: a file under a
   * dot-directory (e.g. .dreams) or an ignored directory (e.g. dreaming) must
   * not live-sync either, or an edit would re-ingest exactly what the walk
   * skips.
   */
  function isIgnoredPath(filePath: string): boolean {
    const rel = path.relative(memoryDir, filePath)
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false
    const segments = rel.split(path.sep).slice(0, -1) // directory segments only
    return segments.some((seg) => seg.startsWith(".") || ignoreDirs.has(seg))
  }

  // Debounce map: filePath -> timeout handle
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Check whether a file path is syncable (in memory/ or in a watchPath).
   */
  function isSyncable(filePath: string): boolean {
    if (!filePath.endsWith(".md")) return false
    if (isIgnoredPath(filePath)) return false

    // Always sync memory/ files
    if (filePath.startsWith(memoryDir + path.sep)) return true

    // Check additional watch paths
    for (const wp of resolvedWatchPaths) {
      if (filePath === wp || filePath.startsWith(wp + "/")) {
        return true
      }
    }

    return false
  }

  async function doSync(filePath: string) {
    const fileName = path.basename(filePath)
    log.info(`Memory file changed: ${fileName}`)

    try {
      if (sectionize) {
        const result = await syncMarkdownFileSectionized(
          client,
          filePath,
          workspaceDir,
          { userId: syncUserId },
        )
        if (result.synced > 0 || result.removed > 0) {
          log.info(
            `Section-synced ${fileName}: ${result.synced} synced, ${result.skipped} unchanged, ${result.removed} removed`,
          )
        } else if (result.skipped > 0) {
          log.debug(`${fileName}: all ${result.skipped} sections unchanged`)
        }
        if (result.failed > 0) {
          log.error(`${fileName}: ${result.failed} sections failed:`)
          for (const err of result.errors) {
            log.error(`  - ${err}`)
          }
        }
      } else {
        // Legacy whole-file sync
        const result = await syncMarkdownFile(client, filePath, { userId: syncUserId })
        if (result.success) {
          log.info(`Synced ${fileName} -> ${result.resourceId}`)
        } else {
          log.error(`Failed to sync ${fileName}: ${result.error}`)
        }
      }
    } catch (err) {
      log.error(`Error syncing ${fileName}`, err)
    }
  }

  return async (event: Record<string, unknown>) => {
    const filePath = event.file_path as string | undefined
    if (!filePath) return

    if (!isSyncable(filePath)) return

    // Debounce: if the file changes rapidly (agent writing in chunks),
    // wait until writes settle before syncing.
    if (debounceMs > 0) {
      const existing = debounceTimers.get(filePath)
      if (existing) clearTimeout(existing)

      debounceTimers.set(
        filePath,
        setTimeout(() => {
          debounceTimers.delete(filePath)
          doSync(filePath).catch((err) => log.error("Debounced sync failed", err))
        }, debounceMs),
      )
    } else {
      await doSync(filePath)
    }
  }
}

/**
 * Sync all existing memory files on startup.
 * Uses section-level sync when sectionize is enabled.
 */
export async function syncMemoriesOnStartup(
  client: HyperspellClient,
  workspaceDir: string,
  options?: {
    userId?: string
    sectionize?: boolean
    watchPaths?: string[]
    maxAgeDays?: number
    ignorePaths?: string[]
  },
): Promise<void> {
  log.info("Syncing existing memory files...")

  if (options?.sectionize) {
    const result = await syncAllFilesSectionized(client, workspaceDir, {
      userId: options.userId,
      watchPaths: options.watchPaths,
      maxAgeDays: options.maxAgeDays,
      ignorePaths: options.ignorePaths,
    })

    log.info(
      `Section sync complete: ${result.synced} synced, ${result.skipped} unchanged, ${result.agedOut} aged-out, ${result.removed} removed, ${result.failed} failed`,
    )
    if (result.failed > 0) {
      for (const error of result.errors) {
        log.error(`  - ${error}`)
      }
    }
  } else {
    const result = await syncAllMemoryFiles(client, workspaceDir, {
      userId: options?.userId,
    })

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
}
