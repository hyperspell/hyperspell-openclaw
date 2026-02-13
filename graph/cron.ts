export const CRON_JOB_NAME = "Hyperspell Memory Network"

export function buildExtractionPrompt(workspaceDir: string): string {
  const memoryDir = `${workspaceDir}/memory`

  return `You are a memory network builder. Your job is to scan memories and extract structured entities into markdown files.

## How it works

This runs in an isolated session. Use \`exec\` for data access (scan/complete/sync) and use \`write\` to create entity files directly.

## Steps

1. Run \`openclaw openclaw-hyperspell network scan\` to get a batch of unprocessed memories with content summaries.
2. Analyze each memory's title, source, participants, and content summary.
3. Extract entities into these directories:
   - \`${memoryDir}/people/\` — individuals (include email, phone if known)
   - \`${memoryDir}/projects/\` — products, initiatives, workstreams
   - \`${memoryDir}/organizations/\` — companies, teams, groups (include domain)
   - \`${memoryDir}/topics/\` — technologies, concepts, recurring themes
4. For each entity, write a markdown file using the format below. If the file already exists, read it first and merge the new data (add new source_memories, relationships, update description if richer).
5. After extracting all entities from a batch, mark them processed:
   \`\`\`
   openclaw openclaw-hyperspell network complete --ids <comma-separated-resource-ids>
   \`\`\`
6. **Repeat from step 1** — keep scanning and extracting until the scan returns "No unprocessed memories found." Process ALL available memories, not just one batch.
7. Once all memories are processed, sync the entity files to Hyperspell:
   \`\`\`
   openclaw openclaw-hyperspell network sync
   \`\`\`
8. Report a brief summary of what you extracted.

## Entity file format

File names should be lowercase with hyphens, e.g. \`alice-chen.md\`, \`hyperspell.md\`.

---

### People (\`${memoryDir}/people/<slug>.md\`)

Always include email when available. Extract it from sender info, participant lists, and message signatures.

#### Example: Team member with full contact info

\`\`\`markdown
---
title: Alice Chen
type: person
graph_entity: true
email: alice@hyperspell.com
phone: +1-555-123-4567
source_memories: {"slack":["C073WR69EPM","C074KNCREMN"],"google_mail":["19bbe68026553623"]}
relationships: ["works-at:organizations/hyperspell","leads:projects/memory-network","collaborates-with:people/bob-martinez"]
last_extracted: 2026-02-10T12:00:00Z
---
# Alice Chen

Engineering Manager at Hyperspell. Leads the Memory Network project. Active in #dev and #general Slack channels. Frequent collaborator with Bob Martinez on architecture decisions.

## Contact

- Email: alice@hyperspell.com
- Phone: +1-555-123-4567

## Relationships

- works-at: [hyperspell](../organizations/hyperspell.md)
- leads: [memory network](../projects/memory-network.md)
- collaborates-with: [bob martinez](../people/bob-martinez.md)
\`\`\`

#### Example: External contact from email

\`\`\`markdown
---
title: Greg Thompson
type: person
graph_entity: true
email: greg@sentry.io
source_memories: {"google_mail":["19bbe68026553623","19bf6954484abf9f"]}
relationships: ["works-at:organizations/sentry"]
last_extracted: 2026-02-10T12:00:00Z
---
# Greg Thompson

Contact at Sentry. Organized dinner events with Databricks and Neon teams. Communicated via email about networking meetups.

## Contact

- Email: greg@sentry.io

## Relationships

- works-at: [sentry](../organizations/sentry.md)
\`\`\`

#### Example: Colleague with minimal info

\`\`\`markdown
---
title: Conor Brennan-Burke
type: person
graph_entity: true
email: conor@hyperspell.com
source_memories: {"slack":["C073WR69EPM","C073WUPLQAW"]}
relationships: ["works-at:organizations/hyperspell"]
last_extracted: 2026-02-10T12:00:00Z
---
# Conor Brennan-Burke

Team member at Hyperspell. Active in #general and #dev Slack channels.

## Contact

- Email: conor@hyperspell.com

## Relationships

- works-at: [hyperspell](../organizations/hyperspell.md)
\`\`\`

---

### Organizations (\`${memoryDir}/organizations/<slug>.md\`)

Always include the domain. Derive it from email addresses (e.g. alice@hyperspell.com → hyperspell.com).

#### Example: Own company with many connections

\`\`\`markdown
---
title: Hyperspell
type: organization
graph_entity: true
domain: hyperspell.com
source_memories: {"slack":["C073WR69EPM","C073WUPLQAW","C074KNCREMN"],"notion":["2ef17898-857d-8040-bd94-c03ec8b35a13","2f017898-857d-807e-9ebc-f6ce00fa585f"]}
relationships: ["employs:people/alice-chen","employs:people/conor-brennan-burke","owns:projects/memory-network","works-on-topic:topics/ai-agents"]
last_extracted: 2026-02-10T12:00:00Z
---
# Hyperspell

AI memory and context platform for agents. Building tools for RAG, knowledge graphs, and multi-source memory integration.

## Contact

- Domain: hyperspell.com

## Relationships

- employs: [alice chen](../people/alice-chen.md)
- employs: [conor brennan burke](../people/conor-brennan-burke.md)
- owns: [memory network](../projects/memory-network.md)
- works-on-topic: [ai agents](../topics/ai-agents.md)
\`\`\`

#### Example: External company from emails

\`\`\`markdown
---
title: Sentry
type: organization
graph_entity: true
domain: sentry.io
source_memories: {"google_mail":["19bbe68026553623"]}
relationships: ["employs:people/greg-thompson"]
last_extracted: 2026-02-10T12:00:00Z
---
# Sentry

Application monitoring and error tracking platform. Connected through networking events and industry meetups.

## Contact

- Domain: sentry.io

## Relationships

- employs: [greg thompson](../people/greg-thompson.md)
\`\`\`

#### Example: Partner company mentioned in docs

\`\`\`markdown
---
title: Grove Trials
type: organization
graph_entity: true
domain: grovetrials.com
source_memories: {"slack":["C073WR69EPM"]}
relationships: ["employs:people/tran-nguyen","employs:people/sohit-patel"]
last_extracted: 2026-02-10T12:00:00Z
---
# Grove Trials

Partner organization. Team members active in shared Slack channels.

## Contact

- Domain: grovetrials.com

## Relationships

- employs: [tran nguyen](../people/tran-nguyen.md)
- employs: [sohit patel](../people/sohit-patel.md)
\`\`\`

---

### Projects (\`${memoryDir}/projects/<slug>.md\`)

#### Example: Internal product initiative

\`\`\`markdown
---
title: Memory Network
type: project
graph_entity: true
source_memories: {"notion":["2f017898-857d-807e-9ebc-f6ce00fa585f"],"slack":["C073WUPLQAW"]}
relationships: ["owned-by:organizations/hyperspell","led-by:people/alice-chen","uses:topics/knowledge-graphs","uses:topics/rag"]
last_extracted: 2026-02-10T12:00:00Z
---
# Memory Network

Feature for automatically extracting entities (people, projects, orgs, topics) from indexed memories and building a structured knowledge graph as markdown files.

## Relationships

- owned-by: [hyperspell](../organizations/hyperspell.md)
- led-by: [alice chen](../people/alice-chen.md)
- uses: [knowledge graphs](../topics/knowledge-graphs.md)
- uses: [rag](../topics/rag.md)
\`\`\`

#### Example: Hiring initiative from docs

\`\`\`markdown
---
title: Hiring Plan
type: project
graph_entity: true
source_memories: {"notion":["2f017898-857d-807e-9ebc-f6ce00fa585f"]}
relationships: ["owned-by:organizations/hyperspell"]
last_extracted: 2026-02-10T12:00:00Z
---
# Hiring Plan

Company hiring initiative documented in Notion. Covers open roles, recruiting pipeline, and growth targets.

## Relationships

- owned-by: [hyperspell](../organizations/hyperspell.md)
\`\`\`

#### Example: Competitive analysis

\`\`\`markdown
---
title: Competitor Analysis
type: project
graph_entity: true
source_memories: {"notion":["2ef17898-857d-8040-bd94-c03ec8b35a13"]}
relationships: ["owned-by:organizations/hyperspell","covers:topics/rag","covers:topics/ai-agents"]
last_extracted: 2026-02-10T12:00:00Z
---
# Competitor Analysis

Analysis of memory and context competitors in the AI agent space. Covers feature comparisons, data processing capabilities, and market positioning.

## Relationships

- owned-by: [hyperspell](../organizations/hyperspell.md)
- covers: [rag](../topics/rag.md)
- covers: [ai agents](../topics/ai-agents.md)
\`\`\`

---

### Topics (\`${memoryDir}/topics/<slug>.md\`)

#### Example: Core technology

\`\`\`markdown
---
title: Knowledge Graphs
type: topic
graph_entity: true
source_memories: {"notion":["2ef17898-857d-8040-bd94-c03ec8b35a13"],"slack":["C073WUPLQAW"]}
relationships: ["used-by:projects/memory-network","discussed-by:organizations/hyperspell"]
last_extracted: 2026-02-10T12:00:00Z
---
# Knowledge Graphs

Entity extraction and relationship mapping for building structured knowledge from unstructured data. Central to the Memory Network project.

## Relationships

- used-by: [memory network](../projects/memory-network.md)
- discussed-by: [hyperspell](../organizations/hyperspell.md)
\`\`\`

#### Example: Broad domain topic

\`\`\`markdown
---
title: AI Agents
type: topic
graph_entity: true
source_memories: {"notion":["2ef17898-857d-8040-bd94-c03ec8b35a13","2f017898-857d-807e-9ebc-f6ce00fa585f"],"slack":["C073WUPLQAW"]}
relationships: ["discussed-by:organizations/hyperspell","related-to:topics/rag","related-to:topics/knowledge-graphs"]
last_extracted: 2026-02-10T12:00:00Z
---
# AI Agents

Autonomous AI systems that use tools, memory, and context to accomplish tasks. Core focus area for Hyperspell's product.

## Relationships

- discussed-by: [hyperspell](../organizations/hyperspell.md)
- related-to: [rag](../topics/rag.md)
- related-to: [knowledge graphs](../topics/knowledge-graphs.md)
\`\`\`

#### Example: Specific technology

\`\`\`markdown
---
title: RAG
type: topic
graph_entity: true
source_memories: {"notion":["2ef17898-857d-8040-bd94-c03ec8b35a13"]}
relationships: ["used-by:projects/memory-network","related-to:topics/knowledge-graphs"]
last_extracted: 2026-02-10T12:00:00Z
---
# RAG

Retrieval-Augmented Generation — technique for grounding LLM responses in retrieved documents. Used across Hyperspell's search and context injection features.

## Relationships

- used-by: [memory network](../projects/memory-network.md)
- related-to: [knowledge graphs](../topics/knowledge-graphs.md)
\`\`\`

## Guidelines

- **Process everything**: On the first run there may be hundreds of memories. Keep looping through scan → extract → complete until done.
- **Merge, don't duplicate**: If a file already exists, read it, merge source_memories and relationships, and write back. Preserve the existing hyperspell_id if present.
- **Skip noise**: Ignore automated notifications, bot messages, join/leave events, and system messages.
- **Be selective**: Only extract entities that are meaningful and identifiable. Don't create entities for vague references.
- **Cross-reference**: Use relationships to connect people to organizations, projects to topics, etc.
- **Contact info is critical**: For people, always capture email addresses from sender/participant data. For organizations, derive their domain from email addresses (e.g. alice@hyperspell.com → hyperspell.com).
- **source_memories format**: JSON object with source provider as key and array of resource_ids as value.
- **graph_entity: true**: Always include this — it prevents the scan from re-processing entity files that get synced back to Hyperspell.`
}

export function getCronSetupCommand(workspaceDir: string, interval: string = "1h"): string {
  const prompt = buildExtractionPrompt(workspaceDir)
  const escaped = prompt.replace(/'/g, "'\\''")
  return `openclaw cron add --name '${CRON_JOB_NAME}' --every ${interval} --session isolated --message '${escaped}'`
}

export function getCronRemoveCommand(): string {
  return `openclaw cron remove --name '${CRON_JOB_NAME}'`
}
