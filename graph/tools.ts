import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { getWorkspaceDir } from "../config.ts"
import { log } from "../logger.ts"
import { NetworkStateManager } from "./state.ts"
import { scanMemories, formatScanResults, writeEntity, completeMemories } from "./ops.ts"
import type { EntityType, SourceMemories } from "./ops.ts"

const ENTITY_TYPES = ["people", "projects", "organizations", "topics"] as const

export function registerNetworkTools(
  api: OpenClawPluginApi,
  client: HyperspellClient,
  cfg: HyperspellConfig,
): void {
  const workspaceDir = getWorkspaceDir()
  const stateManager = new NetworkStateManager(workspaceDir)

  api.registerTool(
    {
      name: "hyperspell_network_scan",
      label: "Memory Network Scan",
      description:
        "Scan Hyperspell memories and return a batch of unprocessed ones with their content summaries. Use this to find new memories that need entity extraction.",
      parameters: Type.Object({
        batchSize: Type.Optional(
          Type.Number({ description: "Max memories to return (default: 20)" }),
        ),
      }),
      async execute(_toolCallId: string, params: { batchSize?: number }) {
        const batchSize = params.batchSize ?? cfg.knowledgeGraph.batchSize
        try {
          const memories = await scanMemories(client, stateManager, batchSize)
          const text = formatScanResults(memories, stateManager.getProcessedCount(), stateManager.getLastScanAt())
          return {
            content: [{ type: "text" as const, text }],
            details: { count: memories.length, memories },
          }
        } catch (err) {
          log.error("network scan failed", err)
          return {
            content: [{ type: "text" as const, text: `Scan failed: ${err instanceof Error ? err.message : String(err)}` }],
          }
        }
      },
    },
    { name: "hyperspell_network_scan" },
  )

  api.registerTool(
    {
      name: "hyperspell_network_write",
      label: "Memory Network Write",
      description:
        "Write or update an entity file in the memory network. Creates markdown files in memory/people/, memory/projects/, memory/organizations/, or memory/topics/.",
      parameters: Type.Object({
        type: Type.Union(ENTITY_TYPES.map((t) => Type.Literal(t)), {
          description: "Entity type: people, projects, organizations, or topics",
        }),
        slug: Type.String({ description: "URL-safe identifier (lowercase with hyphens, e.g. 'alice-chen')" }),
        name: Type.String({ description: "Display name of the entity" }),
        description: Type.String({ description: "Description of the entity" }),
        relationships: Type.Optional(
          Type.Array(Type.String(), {
            description: "Relationships in format 'relationship:type/slug', e.g. 'works-at:organizations/hyperspell'",
          }),
        ),
        sourceMemories: Type.Optional(
          Type.Record(Type.String(), Type.Array(Type.String()), {
            description: "Source memories by provider, e.g. { slack: ['C073WR69EPM'], google_mail: ['19bbe68026553623'] }",
          }),
        ),
        email: Type.Optional(Type.String({ description: "Email address (for people)" })),
        phone: Type.Optional(Type.String({ description: "Phone number (for people)" })),
        domain: Type.Optional(Type.String({ description: "Domain/homepage (for organizations)" })),
      }),
      async execute(
        _toolCallId: string,
        params: { type: EntityType; slug: string; name: string; description: string; relationships?: string[]; sourceMemories?: SourceMemories; email?: string; phone?: string; domain?: string },
      ) {
        try {
          const result = writeEntity(workspaceDir, params)
          return { content: [{ type: "text" as const, text: `Wrote ${result} (${params.name})` }] }
        } catch (err) {
          log.error(`network write failed: ${params.type}/${params.slug}`, err)
          return { content: [{ type: "text" as const, text: `Write failed: ${err instanceof Error ? err.message : String(err)}` }] }
        }
      },
    },
    { name: "hyperspell_network_write" },
  )

  api.registerTool(
    {
      name: "hyperspell_network_complete",
      label: "Memory Network Complete",
      description: "Mark a batch of memory IDs as processed so they won't appear in future scans.",
      parameters: Type.Object({
        memoryIds: Type.Array(Type.String(), { description: "List of resource_ids to mark as processed" }),
      }),
      async execute(_toolCallId: string, params: { memoryIds: string[] }) {
        try {
          const { newCount, totalCount } = completeMemories(stateManager, params.memoryIds)
          return {
            content: [{ type: "text" as const, text: `Marked ${newCount} new memories as processed (${totalCount} total). Last scan: ${stateManager.getLastScanAt()}` }],
          }
        } catch (err) {
          log.error("network complete failed", err)
          return { content: [{ type: "text" as const, text: `Complete failed: ${err instanceof Error ? err.message : String(err)}` }] }
        }
      },
    },
    { name: "hyperspell_network_complete" },
  )
}
