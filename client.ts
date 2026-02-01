import Hyperspell from "hyperspell"
import type { HyperspellConfig, HyperspellSource } from "./config.ts"
import { log } from "./logger.ts"

export type SearchResult = {
  resourceId: string
  title: string | null
  source: HyperspellSource
  score: number | null
  url: string | null
  createdAt: string | null
}

export type Integration = {
  id: string
  name: string
  provider: HyperspellSource
  icon: string
}

export class HyperspellClient {
  private client: Hyperspell
  private config: HyperspellConfig

  constructor(config: HyperspellConfig) {
    this.config = config
    this.client = new Hyperspell({
      apiKey: config.apiKey,
    })
    log.info("client initialized")
  }

  async search(
    query: string,
    options?: { limit?: number; sources?: HyperspellSource[] },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? this.config.maxResults
    const sources =
      options?.sources ?? (this.config.sources.length > 0 ? this.config.sources : undefined)

    log.debugRequest("memories.search", { query, limit, sources })

    const response = await this.client.memories.search({
      query,
      sources,
      options: {
        max_results: limit,
      },
    })

    const results: SearchResult[] = response.documents.map((doc) => ({
      resourceId: doc.resource_id,
      title: doc.title ?? null,
      source: doc.source as HyperspellSource,
      score: doc.score ?? null,
      url: doc.metadata?.url as string | null ?? null,
      createdAt: doc.metadata?.created_at as string | null ?? null,
    }))

    log.debugResponse("memories.search", { count: results.length })
    return results
  }

  async addMemory(
    text: string,
    options?: { title?: string; metadata?: Record<string, string | number | boolean> },
  ): Promise<{ resourceId: string }> {
    log.debugRequest("memories.add", {
      textLength: text.length,
      title: options?.title,
    })

    const result = await this.client.memories.add({
      text,
      title: options?.title,
      metadata: {
        ...options?.metadata,
        openclaw_source: "command",
      },
    })

    log.debugResponse("memories.add", { resourceId: result.resource_id })
    return { resourceId: result.resource_id }
  }

  async listIntegrations(): Promise<Integration[]> {
    log.debugRequest("integrations.list", {})

    const response = await this.client.integrations.list()

    const integrations: Integration[] = response.integrations.map((int) => ({
      id: int.id,
      name: int.name,
      provider: int.provider as HyperspellSource,
      icon: int.icon,
    }))

    log.debugResponse("integrations.list", { count: integrations.length })
    return integrations
  }

  async getConnectUrl(integrationId: string): Promise<{ url: string; expiresAt: string }> {
    log.debugRequest("integrations.connect", { integrationId })

    const response = await this.client.integrations.connect(integrationId)

    log.debugResponse("integrations.connect", { url: response.url })
    return {
      url: response.url,
      expiresAt: response.expires_at,
    }
  }
}
