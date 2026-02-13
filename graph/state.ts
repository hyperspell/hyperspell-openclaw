import * as fs from "node:fs"
import * as path from "node:path"
import { log } from "../logger.ts"

const STATE_VERSION = 1
const STATE_FILENAME = ".network-state.json"

export interface NetworkState {
  processedIds: Record<string, string> // resource_id → ISO timestamp
  lastScanAt: string | null
  version: number
}

export class NetworkStateManager {
  private statePath: string
  private state: NetworkState

  constructor(workspaceDir: string) {
    const memoryDir = path.join(workspaceDir, "memory")
    fs.mkdirSync(memoryDir, { recursive: true })
    this.statePath = path.join(memoryDir, STATE_FILENAME)
    this.state = this.load()
  }

  private load(): NetworkState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8")
        const parsed = JSON.parse(raw)
        if (parsed.version === STATE_VERSION) {
          return parsed
        }
        log.warn(`Network state version mismatch (got ${parsed.version}, want ${STATE_VERSION}), resetting`)
      }
    } catch (err) {
      log.warn("Failed to load network state, starting fresh", err)
    }
    return { processedIds: {}, lastScanAt: null, version: STATE_VERSION }
  }

  save(): void {
    const tmpPath = this.statePath + ".tmp"
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmpPath, this.statePath)
    } catch (err) {
      log.error("Failed to save network state", err)
      try { fs.unlinkSync(tmpPath) } catch {}
    }
  }

  isProcessed(resourceId: string): boolean {
    return resourceId in this.state.processedIds
  }

  markProcessed(resourceIds: string[]): number {
    let count = 0
    const now = new Date().toISOString()
    for (const id of resourceIds) {
      if (!(id in this.state.processedIds)) {
        this.state.processedIds[id] = now
        count++
      }
    }
    return count
  }

  updateLastScan(): void {
    this.state.lastScanAt = new Date().toISOString()
  }

  getProcessedCount(): number {
    return Object.keys(this.state.processedIds).length
  }

  getLastScanAt(): string | null {
    return this.state.lastScanAt
  }
}
