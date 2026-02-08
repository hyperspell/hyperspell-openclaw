# OpenClaw Hyperspell Plugin

![Hyperspell x OpenClaw](https://github.com/user-attachments/assets/5ac86aab-0f0f-4f14-bde5-0652e625aa86)

OpenClaw plugin for [Hyperspell](https://hyperspell.com) - Context and memory for your AI agents.

## Installation

```bash
openclaw plugins install @hyperspell/openclaw-hyperspell
```

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
    "entries": {
      "openclaw-hyperspell": {
        "enabled": true,
        "config": {
          "apiKey": "${HYPERSPELL_API_KEY}",
          "userId": "your-email",
          "autoContext": true,
          "syncMemories": true,
          "sources": "vault,notion,slack"
        }
      }
    }
  }
}
```

Set the environment variable in `~/.openclaw/.env`:

```bash
HYPERSPELL_API_KEY=hs_...
```

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

- `vault` - User-created or synced memories
- `notion` - Notion pages and databases
- `slack` - Slack messages
- `google_calendar` - Google Calendar events
- `google_mail` - Gmail messages
- `google_drive` - Google Drive files
- `box` - Box files
- `web_crawler` - Crawled web pages
