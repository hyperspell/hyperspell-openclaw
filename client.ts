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

export type SearchWithAnswerResult = {
  answer: string | null
  documents: SearchResult[]
}

export type Integration = {
  id: string
  name: string
  provider: HyperspellSource
  icon: string
}

export type Connection = {
  id: string
  integrationId: string
  label: string | null
  provider: HyperspellSource
}

export type EmotionalStateResponse = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
  status: string
}

export type EmotionalStateLatest = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
}

const API_BASE_URL = "https://api.hyperspell.com"

export class HyperspellClient {
  private client: Hyperspell
  private config: HyperspellConfig

  constructor(config: HyperspellConfig) {
    this.config = config
    this.client = new Hyperspell({
      apiKey: config.apiKey,
      userID: config.userId,
    })
    log.info(`client initialized${config.userId ? ` for user ${config.userId}` : ""}`)
  }

  private rawHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    }
    if (this.config.userId) {
      headers["X-As-User"] = this.config.userId
    }
    return headers
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

  async searchRaw(
    query: string,
    options?: { limit?: number; sources?: HyperspellSource[] },
  ): Promise<Record<string, unknown>> {
    const limit = options?.limit ?? this.config.maxResults
    const sources =
      options?.sources ?? (this.config.sources.length > 0 ? this.config.sources : undefined)

    log.debugRequest("memories.search (raw)", { query, limit, sources })

    const response = await this.client.memories.search({
      query,
      sources,
      options: {
        max_results: limit,
      },
    })

    log.debugResponse("memories.search (raw)", { count: response.documents.length })

    return response as unknown as Record<string, unknown>
  }

  async searchWithAnswer(
    query: string,
    options?: { limit?: number; sources?: HyperspellSource[] },
  ): Promise<SearchWithAnswerResult> {
    const limit = options?.limit ?? this.config.maxResults
    const sources =
      options?.sources ?? (this.config.sources.length > 0 ? this.config.sources : undefined)

    log.debugRequest("memories.search (with answer)", { query, limit, sources })

    const response = await this.client.memories.search({
      query,
      sources,
      answer: true,
      options: {
        max_results: limit,
      },
    })

    const documents: SearchResult[] = response.documents.map((doc) => ({
      resourceId: doc.resource_id,
      title: doc.title ?? null,
      source: doc.source as HyperspellSource,
      score: doc.score ?? null,
      url: doc.metadata?.url as string | null ?? null,
      createdAt: doc.metadata?.created_at as string | null ?? null,
    }))

    log.debugResponse("memories.search (with answer)", {
      count: documents.length,
      hasAnswer: !!response.answer,
    })

    return {
      answer: response.answer ?? null,
      documents,
    }
  }

  async addMemory(
    text: string,
    options?: {
      title?: string
      resourceId?: string
      collection?: string
      metadata?: Record<string, string | number | boolean>
    },
  ): Promise<{ resourceId: string }> {
    log.debugRequest("memories.add", {
      textLength: text.length,
      title: options?.title,
      resourceId: options?.resourceId,
      collection: options?.collection,
    })

    const result = await this.client.memories.add({
      text,
      title: options?.title,
      resource_id: options?.resourceId,
      collection: options?.collection,
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

  async *listMemories(
    options?: { source?: HyperspellSource; collection?: string; pageSize?: number },
  ): AsyncGenerator<{
    resourceId: string
    source: HyperspellSource
    title: string | null
    metadata: Record<string, unknown>
  }> {
    log.debugRequest("memories.list", { source: options?.source, collection: options?.collection })

    const params: Record<string, unknown> = {
      size: options?.pageSize ?? 100,
    }
    if (options?.source) params.source = options.source
    if (options?.collection) params.collection = options.collection

    for await (const memory of this.client.memories.list(params as any)) {
      yield {
        resourceId: memory.resource_id,
        source: memory.source as HyperspellSource,
        title: memory.title ?? null,
        metadata: (memory.metadata ?? {}) as Record<string, unknown>,
      }
    }
  }

  async getMemory(
    resourceId: string,
    source: HyperspellSource,
  ): Promise<Record<string, unknown>> {
    log.debugRequest("memories.get", { resourceId, source })

    const response = await this.client.memories.get(resourceId, { source })
    const raw = response as unknown as Record<string, unknown>

    log.debugResponse("memories.get", { resourceId, hasData: "data" in raw })
    return raw
  }

  async listConnections(): Promise<Connection[]> {
    log.debugRequest("connections.list", {})

    const response = await this.client.connections.list()

    const connections: Connection[] = response.connections.map((conn) => ({
      id: conn.id,
      integrationId: conn.integration_id,
      label: conn.label,
      provider: conn.provider as HyperspellSource,
    }))

    log.debugResponse("connections.list", { count: connections.length })
    return connections
  }

  // -- Emotional State (raw fetch — not in public SDK) -----------------------

  async storeEmotionalState(
    conversation: string,
    options?: {
      sessionId?: string
      relationshipId?: string
      metadata?: Record<string, string | number | boolean>
    },
  ): Promise<EmotionalStateResponse> {
    log.debugRequest("emotional-state.store", {
      conversationLength: conversation.length,
      relationshipId: options?.relationshipId,
    })

    const body: Record<string, unknown> = { conversation }
    if (options?.sessionId) body.session_id = options.sessionId
    if (options?.relationshipId) body.relationship_id = options.relationshipId
    if (options?.metadata) body.metadata = options.metadata

    const res = await fetch(`${API_BASE_URL}/emotional-state`, {
      method: "POST",
      headers: this.rawHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`POST /emotional-state failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const result: EmotionalStateResponse = {
      resourceId: data.resource_id,
      summary: data.summary,
      extractedAt: data.extracted_at,
      sessionId: data.session_id ?? null,
      relationshipId: data.relationship_id ?? null,
      status: data.status,
    }

    log.debugResponse("emotional-state.store", { resourceId: result.resourceId })
    return result
  }

  async getEmotionalState(relationshipId?: string): Promise<EmotionalStateLatest | null> {
    log.debugRequest("emotional-state.get", { relationshipId })

    const url = new URL(`${API_BASE_URL}/emotional-state`)
    if (relationshipId) url.searchParams.set("relationship_id", relationshipId)

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.rawHeaders(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`GET /emotional-state failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    if (data === null) {
      log.debugResponse("emotional-state.get", { found: false })
      return null
    }

    const result: EmotionalStateLatest = {
      resourceId: data.resource_id,
      summary: data.summary,
      extractedAt: data.extracted_at,
      sessionId: data.session_id ?? null,
      relationshipId: data.relationship_id ?? null,
    }

    log.debugResponse("emotional-state.get", { found: true, resourceId: result.resourceId })
    return result
  }

  async deleteEmotionalState(relationshipId?: string): Promise<{ deletedCount: number }> {
    log.debugRequest("emotional-state.delete", { relationshipId })

    const url = new URL(`${API_BASE_URL}/emotional-state`)
    if (relationshipId) url.searchParams.set("relationship_id", relationshipId)

    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.rawHeaders(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`DELETE /emotional-state failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    const result = { deletedCount: data.deleted_count }

    log.debugResponse("emotional-state.delete", result)
    return result
  }
}
