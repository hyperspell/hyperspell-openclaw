# OpenClaw Hyperspell Plugin

![Hyperspell x OpenClaw](https://github.com/user-attachments/assets/5ac86aab-0f0f-4f14-bde5-0652e625aa86)

OpenClaw plugin for [Hyperspell](https://hyperspell.com) - Context and memory for your AI agents.

## Installation

```bash
openclaw plugins install @hyperspell/openclaw-hyperspell
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hyperspell": {
        "enabled": true,
        "config": {
          "apiKey": "${HYPERSPELL_API_KEY}",
          "autoContext": true
        }
      }
    }
  }
}

```

Or set the environment variable:

```bash
export HYPERSPELL_API_KEY=hs_...
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | `${HYPERSPELL_API_KEY}` | Hyperspell API key |
| `userId` | string | - | User ID to scope searches (for non-JWT API keys) |
| `autoContext` | boolean | `true` | Auto-inject relevant memories before each AI turn |
| `sources` | string | - | Comma-separated sources to search (e.g., `notion,slack`) |
| `maxResults` | number | `10` | Maximum memories per context injection |
| `debug` | boolean | `false` | Enable verbose logging |

## Slash Commands

### `/context <query>`

Search your memories for relevant context.

```
/context Q1 budget planning
```

### `/connect <source>`

Connect an account to Hyperspell. Opens the OAuth flow in your browser.

```
/connect notion
/connect slack
/connect google_drive
```

### `/remember <text>`

Save something to memory.

```
/remember Meeting with Alice: discussed Q1 budget, need to follow up on headcount
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

- `collections` - User-created collections
- `notion` - Notion pages and databases
- `slack` - Slack messages
- `google_calendar` - Google Calendar events
- `google_mail` - Gmail messages
- `google_drive` - Google Drive files
- `box` - Box files
- `vault` - Vault documents
- `web_crawler` - Crawled web pages
