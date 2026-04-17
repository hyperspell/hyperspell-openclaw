# OpenClaw Hyperspell Plugin

![Hyperspell x OpenClaw](https://github.com/user-attachments/assets/5ac86aab-0f0f-4f14-bde5-0652e625aa86)

OpenClaw plugin for [Hyperspell](https://hyperspell.com) - Context and memory for your AI agents.

## Installation

```bash
openclaw plugins install --dangerously-force-unsafe-install @hyperspell/openclaw-hyperspell
```

> **Note:** The `--dangerously-force-unsafe-install` flag is required because OpenClaw's automated install scanner detects standard operations that are essential to how the plugin works — opening your browser during setup, scheduling background jobs, and securely communicating with the Hyperspell API. These are normal, expected behaviors and the plugin does not execute arbitrary code or access data beyond what is needed to function. The source is fully open and auditable in this repository.

## Quick Start

Run the interactive setup wizard:

```bash
openclaw openclaw-hyperspell setup
```

The setup wizard will guide you through:
1. Creating a Hyperspell account (if you don't have one)
2. Configuring your API key
3. Setting up your User ID for multi-tenant memory
4. Connecting your apps (Notion, Slack, Google Drive, etc.)
5. Enabling memory sync for local markdown files
6. Syncing existing memory files to Hyperspell

## Manual Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-hyperspell"
    },
    "entries": {
      "openclaw-hyperspell": {
        "enabled": true,
        "config": {
          "apiKey": "${HYPERSPELL_API_KEY}",
          "userId": "your-email",
          "autoContext": true,
          "syncMemories": true,
          "sources": "vault,notion,slack",
          "dreaming": {
            "enabled": true
          }
        }
      },
      "memory-core": {
        "enabled": true
      }
    }
  }
}
```

Set the environment variable in `~/.openclaw/.env`:

```bash
HYPERSPELL_API_KEY=hs_...
```

### Running alongside Dreaming

OpenClaw's memory slot (`plugins.slots.memory`) is exclusive, but the `memory-core` dreaming engine is an explicit exception: it can sidecar-load alongside the slot owner so Dreaming keeps running while Hyperspell handles remote search and storage.

To enable this, all four settings must be true at once:

| Setting | Value |
|---|---|
| `plugins.slots.memory` | `openclaw-hyperspell` |
| `plugins.entries.openclaw-hyperspell.enabled` | `true` |
| `plugins.entries.openclaw-hyperspell.config.dreaming.enabled` | `true` |
| `plugins.entries.memory-core.enabled` | `true` |

The `dreaming.enabled: true` flag on the Hyperspell plugin's config is what tells OpenClaw to load `memory-core` as a sidecar (see `resolveDreamingSidecarEngineId` in OpenClaw's plugin loader). Without it, `memory-core` is treated as a normal memory plugin and the slot policy disables it.

**Two distinct memory tracks:**

- **Hyperspell** — remote, cross-source (Slack, Notion, Drive, Gmail, vault, ...). Runs on every agent turn via `autoContext` and `autoTrace`. Owns the memory slot.
- **Dreaming** — local, consolidates daily notes and session transcripts into `workspace/MEMORY.md` on cron (light every 6h, deep nightly, REM weekly). Does not read Hyperspell's remote memories. Reads only local files the agent runner writes.

The two systems don't share state at runtime. They can be enabled independently.

## CLI Commands

### `openclaw openclaw-hyperspell setup`

Interactive setup wizard that walks you through configuration, connecting apps, and syncing memory files.

### `openclaw openclaw-hyperspell status`

Check your current configuration and connection status.

### `openclaw openclaw-hyperspell connect`

Open the Hyperspell connect page to link your accounts (Notion, Slack, Google Drive, etc.). After connecting, your sources are automatically updated in the config.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | `${HYPERSPELL_API_KEY}` | Hyperspell API key |
| `userId` | string | - | User ID for multi-tenant memory (can be your email) |
| `autoContext` | boolean | `true` | Auto-inject relevant memories before each AI turn |
| `syncMemories` | boolean | `false` | Sync markdown files in `workspace/memory/` to Hyperspell |
| `sources` | string | - | Comma-separated sources to search (e.g., `vault,notion,slack`) |
| `maxResults` | number | `10` | Maximum memories per context injection |
| `debug` | boolean | `false` | Enable verbose logging |
| `dreaming.enabled` | boolean | `false` | Allow `memory-core` to sidecar-load so Dreaming can consolidate local session transcripts into `workspace/MEMORY.md`. See [Running alongside Dreaming](#running-alongside-dreaming). |

## Slash Commands

### `/getcontext <query>`

Search your memories for relevant context.

```
/getcontext Q1 budget planning
```

### `/remember <text>`

Save something to memory.

```
/remember Meeting with Alice: discussed Q1 budget, need to follow up on headcount
```

### `/sync`

Manually sync all markdown files in `workspace/memory/` to Hyperspell.

```
/sync
```

## Memory Sync

When `syncMemories: true`, the plugin syncs markdown files from your agent's workspace memory directory (e.g., `~/.openclaw/workspace/memory/`) to Hyperspell. This includes all `.md` files in subdirectories.

**How it works:**

- Each markdown file is uploaded to Hyperspell as a memory in the `openclaw` collection
- The returned `resource_id` is stored in the file's YAML frontmatter as `hyperspell_id`
- On subsequent syncs, files with an existing `hyperspell_id` are updated rather than duplicated
- Files are synced automatically on startup and when they change

**Example frontmatter after sync:**

```markdown
---
title: Meeting Notes
hyperspell_id: abc123-def456
---

# Meeting Notes
...
```

## AI Tools

The plugin registers tools that the AI can use autonomously:

- **hyperspell_search** - Search through connected sources
- **hyperspell_remember** - Save information to memory

## Auto-Context

When `autoContext: true` (default), the plugin automatically:

1. Intercepts each user message before the AI responds
2. Searches Hyperspell for relevant memories
3. Injects matching context into the AI's prompt

This ensures the AI always has access to relevant information from your connected sources.

## Available Sources

### Documents & Storage
- `vault` - User-created or synced memories
- `notion` - Notion pages and databases
- `google_drive` - Google Drive files
- `box` - Box files
- `dropbox` - Dropbox files
- `onedrive` - Microsoft OneDrive files

### Communication
- `slack` - Slack messages
- `google_mail` - Gmail messages

### Calendars & Meetings
- `google_calendar` - Google Calendar events
- `zoom` - Zoom meeting recordings and transcripts
- `fathom` - Fathom meeting recordings
- `fireflies` - Fireflies.ai meeting transcripts

### Project Management
- `linear` - Linear issues and comments

### CRM
- `hubspot` - HubSpot contacts, companies, and deals
- `attio` - Attio CRM contacts, companies, and deals

### Developer Tools
- `github` - GitHub repositories and commits

### Other
- `web_crawler` - Crawled web pages

## Knowledge Graph

The plugin can automatically build a local knowledge graph from your memories:

1. **Scan** memories for entities (people, organizations, projects, topics)
2. **Extract** structured information and relationships
3. **Write** entity files to `memory/people/`, `memory/organizations/`, etc.
4. **Link** entities via markdown relationship references

Enable the graph tools by using `hyperspell_network_scan`, `hyperspell_network_write`, and `hyperspell_network_complete` in your agent workflows.

---

## Troubleshooting

### "No relevant memories found"
- Check that your sources are connected: `openclaw openclaw-hyperspell status`
- Verify your API key is set: `echo $HYPERSPELL_API_KEY`
- Make sure content has been indexed (initial sync can take a few minutes)

### Memory sync not working
- Ensure `syncMemories: true` in your config
- Check that markdown files are in `~/.openclaw/workspace/memory/`
- Run `/sync` manually to trigger a sync and see any errors

### Auto-context not injecting
- Verify `autoContext: true` in your config
- Enable `debug: true` to see what queries are being made
- Check that you have memories matching your conversation topics

### Enabling `memory-core` disabled Hyperspell
- This means `memory-core` was placed in `plugins.slots.memory`. The slot should stay on `openclaw-hyperspell`; `memory-core` rides alongside as a sidecar.
- Restore: set `plugins.slots.memory = "openclaw-hyperspell"`, set both plugins `enabled: true`, and add `dreaming: { enabled: true }` to the Hyperspell config. See [Running alongside Dreaming](#running-alongside-dreaming).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT
