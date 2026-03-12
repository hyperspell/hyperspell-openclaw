# Contributing to OpenClaw Hyperspell Plugin

Thanks for your interest in contributing! This plugin connects [OpenClaw](https://openclaw.ai) agents to [Hyperspell](https://hyperspell.com) for memory and context retrieval.

## Getting Started

1. **Clone the repo:**
   ```bash
   git clone https://github.com/hyperspell/hyperspell-openclaw.git
   cd hyperspell-openclaw
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Check types:**
   ```bash
   npm run check-types
   ```

4. **Lint:**
   ```bash
   npm run lint
   ```

## Project Structure

```
├── client.ts              # Hyperspell API client wrapper
├── config.ts              # Plugin configuration + validation
├── index.ts               # Plugin entry point + lifecycle
├── logger.ts              # Structured logging
├── commands/
│   ├── setup.ts           # Interactive setup wizard
│   └── slash.ts           # Slash command handlers (/getcontext, /remember, /sync)
├── hooks/
│   ├── auto-context.ts    # Pre-turn context injection
│   └── memory-sync.ts     # Markdown file sync to Hyperspell
├── tools/
│   ├── search.ts          # hyperspell_search tool
│   └── remember.ts        # hyperspell_remember tool
├── graph/
│   ├── tools.ts           # Knowledge graph tools (scan, write, complete)
│   ├── ops.ts             # Graph operations (entity extraction, file I/O)
│   ├── state.ts           # Processed memory tracking
│   ├── cron.ts            # Periodic graph maintenance
│   └── index.ts           # Graph module entry point
├── sync/
│   └── markdown.ts        # Markdown file sync logic
├── lib/                   # Shared utilities
└── types/                 # TypeScript type definitions
```

## How It Works

The plugin provides three layers of memory integration:

1. **Auto-context** (`hooks/auto-context.ts`): Before each AI turn, searches Hyperspell for memories relevant to the user's message and injects them as context.

2. **AI tools** (`tools/`): The agent can actively search (`hyperspell_search`) and store (`hyperspell_remember`) memories during conversations.

3. **Knowledge graph** (`graph/`): Scans memories to extract entities (people, organizations, projects, topics) and builds a local knowledge graph as markdown files with relationship links.

## Making Changes

- **New tools**: Add to `tools/` and register in `index.ts`
- **New slash commands**: Add handlers in `commands/slash.ts`
- **New hooks**: Add to `hooks/` and wire up in `index.ts`
- **Client methods**: Extend `client.ts` (wraps the `hyperspell` SDK)

## Code Style

- TypeScript strict mode
- Biome for linting and formatting (`npm run lint:fix`)
- Explicit types on public API boundaries
- Error handling: catch, log, return user-friendly messages (don't throw from tool handlers)

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run check-types` and `npm run lint`
4. Open a PR with a clear description of what changed and why

## Questions?

- [Hyperspell Docs](https://docs.hyperspell.com)
- [OpenClaw Docs](https://docs.openclaw.ai)
- [Discord Community](https://discord.com/invite/clawd)
