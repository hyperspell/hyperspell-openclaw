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

### `openclaw openclaw-hyperspell purge-channel <channelId>`

Find — and with `--yes`, delete — memories that were synced from a specific conversation/channel. Use it for retroactive cleanup after adding a channel to `excludeChannels`, which is [forward-only](#excludechannels-is-forward-only).

```
openclaw openclaw-hyperspell purge-channel 1521620672726438171          # dry run: list what would be deleted
openclaw openclaw-hyperspell purge-channel 1521620672726438171 --yes    # actually delete
```

| Flag | Description |
|------|-------------|
| `--source <sources>` | Comma-separated Hyperspell sources to scan. Default `vault` — the hot-buffer consolidation target and default `hotBuffer.source`. |
| `--user <userId>` | `X-As-User` to scan/delete under. Default: the configured `userId`. In `multiUser` deployments, run once per mapped userId. |
| `--session <ids>` | Comma-separated OpenClaw session ids — matches legacy **untagged** hot-buffer resources through the `resource_id === session id` identity. |
| `--resource <ids>` | Explicit resource ids to delete (escape hatch for traces or `/remember` memories you identified manually, e.g. via `hyperspell_search`). |
| `--yes` | Actually delete. Without it the command is a **dry run** that prints the matches and exits. |

Matching uses the same semantics as the quarantine check itself: exact id or thread suffix (`<channelId>:...`), case-insensitive. Discovery enumerates memories and filters client-side on the `openclaw_channel_id` metadata tag — deleted rows are reported per resource, and a resource that is already gone counts as deleted.

**Finding session ids for `--session`:** OpenClaw session keys embed the conversation id (`agent:<agentId>:<provider>:channel:<channelId>[...]` — the same format the plugin's quarantine matching parses). Look up the quarantined conversation's sessions in OpenClaw's session store and pass their session ids; each hot-buffer resource id equals its session id.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | `${HYPERSPELL_API_KEY}` | Hyperspell API key |
| `userId` | string | - | User ID for multi-tenant memory (can be your email) |
| `autoContext` | boolean | `true` | Auto-inject relevant memories before each AI turn |
| `emotionalContext` | boolean | `false` | Persist an emotional-state register at session end and inject the recent arc at session start |
| `moodWeatherChance` | number | `0` | Probability (0–1) that a fresh session rolls exogenous "mood weather". `0` disables. Suggested starting value: `0.03`–`0.05` — rare enough to read as weather, not a gimmick. Requires `emotionalContext`. |
| `syncMemories` | boolean | `false` | Sync markdown files in `workspace/memory/` to Hyperspell |
| `sources` | string | - | Comma-separated sources to search (e.g., `vault,notion,slack`) |
| `maxResults` | number | `10` | Maximum memories per context injection |
| `relevanceThreshold` | number | `0.6` | Minimum (composite) score a memory needs to be injected by auto-context |
| `ranking` | object | see below | Composite re-ranking of auto-context results — see [Composite ranking](#composite-ranking--surfacing-your-active-work) |
| `ranking.storyTerms` | string[] | `[]` | **Off until you set it.** Words/phrases identifying your active creative work, so it outranks conversation chatter (matched at word boundaries, case-insensitive) |
| `excludeChannels` | string[] | `[]` | Conversation/channel ids fully quarantined from memory: no context injection, no memory writes, no memory tools. Threads inherit. **Forward-only** — see [below](#excludechannels-is-forward-only). |
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

### `/previewcontext`

Show exactly what Hyperspell would inject at the start of the next session — the emotional-context arc, the auto-context setting, and the startup-orientation blocks — without starting a session or touching any session state. Read-only and idempotent: run it twice and you get the same report.

Mood weather is shown as its configured chance only (e.g. "configured chance 8% per session") and is **never rolled by the preview** — each real session rolls independently at injection time, so the actual mood (if any) is only observable in the live session.

```
/previewcontext
```

## Memory Sync

When `syncMemories: true`, the plugin syncs markdown files from your agent's workspace memory directory (e.g., `~/.openclaw/workspace/memory/`) to Hyperspell. This includes all `.md` files in subdirectories.

**How it works:**

- Each markdown file is uploaded to Hyperspell as a memory in the `openclaw` collection
- The returned `resource_id` is stored in the file's YAML frontmatter as `hyperspell_id`
- On subsequent syncs, files with an existing `hyperspell_id` are updated rather than duplicated
- Files are synced automatically on startup and when they change
- Startup sync runs in the **background** — the agent boots immediately and sync proceeds without blocking it
- A per-section content hash is tracked in `<workspace>/.hyperspell-sync-hashes.json`, so unchanged sections are skipped on subsequent syncs (no re-ingestion)

**Tuning sync (object form):**

```jsonc
"syncMemories": {
  "enabled": true,
  "sectionize": true,     // split files on ## headings into separate memories
  "watchPaths": [],        // extra files/dirs to sync beyond memory/
  "debounceMs": 2000,      // wait for writes to settle before syncing
  "maxAgeDays": 30          // startup skips already-synced files older than this
}
```

`maxAgeDays` bounds steady-state load: on startup, files whose mtime is older than the cutoff **and** already recorded in the sync manifest are skipped without re-reading. Files not yet in the manifest are always synced once regardless of age, and editing an old file bumps its mtime back into the window. Set to `0` to disable the cutoff.

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
- **hyperspell_emotional_arc** - Re-fetch the recent emotional arc mid-conversation (requires `emotionalContext: true`); returns the same block injected at session start, e.g. after compaction removed it

## Auto-Context

When `autoContext: true` (default), the plugin automatically:

1. Intercepts each user message before the AI responds
2. Searches Hyperspell for relevant memories
3. Injects matching context into the AI's prompt

This ensures the AI always has access to relevant information from your connected sources.

### Composite ranking — surfacing your active work

Raw semantic relevance rewards *frequency*: a phrase repeated across a hundred
auto-saved conversation fragments looks "most similar" to everything and buries
quieter, truer memory — like the manuscript you're actually writing. When
`ranking.enabled` is on (default), auto-context re-scores candidates:

```
composite = relevance
          + curationBoost   (a memory you deliberately kept: journals, notes, synced files)
          + storyBoost      (your active story/manuscript — matched via storyTerms)
          − chatterPenalty  (an auto-saved conversation fragment)
```

Chatter is additionally capped at `chatterQuota` results per injection,
regardless of score.

**`storyBoost` does nothing until you set `storyTerms`.** The default is `[]`,
so no result ever classifies as "story". Set it to the distinctive proper nouns
of your active work — the title, character names, a project codename, invented
terminology:

```jsonc
"config": {
  "ranking": {
    "storyTerms": ["lighthouse keeper", "mira", "the shoal chapters"]
  }
}
```

For example: if you're writing a novel called *The Lighthouse Keeper* with a
protagonist named Mira, the config above makes any memory whose **title or
highlight excerpt** contains those terms rank as "story" — it gets
`storyBoost + curationBoost` (+0.35 by default) and is exempt from the chatter
cap. If you sync the manuscript via `syncMemories` with `sectionize: true`,
every section is titled `The Lighthouse Keeper — <section>`, so the title term
alone catches the whole manuscript.

**How matching works:** terms are matched case-insensitively at **word
boundaries** against the result's title and highlight excerpts. `"mira"`
matches "Mira", "Mira's", and "mira-class", but **not** "ad**mira**l" or
"**mira**cle" — a short name can't false-positive inside longer words.
Multi-word phrases (`"lighthouse keeper"`) match the same way. There is no
prefix/stem matching: to catch inflected or partial forms, add each full form
as its own term.

Tips:

- **Use 3–15 distinctive terms.** Every term is checked per result per search;
  more terms means more false-positive surface, not more recall. Never add a
  word that appears in unrelated conversation ("book", "chapter", "draft").
- Terms are normalized on load — trimmed, lowercased, deduplicated — so casing
  and stray whitespace in your config don't matter.
- **Update the list when the active story changes.** A stale term is worse than
  a missing one: it keeps granting the boost to a dead thread's echoes.
- Ranking (including `storyTerms`) applies only to **auto-context** injection.
  The `hyperspell_search` tool and `/getcontext` return raw relevance order —
  don't test `storyTerms` there and conclude it's broken.
- To verify it's working, enable `debug: true` and watch for the per-search
  tally (`auto-context: ranked {...} candidates → selected {...}`) and the
  per-candidate lines (`[story] 0.47→0.82 The Lighthouse Keeper — Chapter 3`),
  which show story matches even when they lose to the threshold.

Full knobs and defaults:

```jsonc
"ranking": {
  "enabled": true,
  "curationBoost": 0.2,     // lift for deliberately-kept memory
  "chatterPenalty": 0.2,    // penalty for auto-saved conversation fragments
  "storyBoost": 0.15,       // extra lift for storyTerms matches (stacks with curationBoost)
  "storyTerms": [],         // REQUIRED for storyBoost to do anything
  "candidateMultiplier": 3, // fetch this × maxResults candidates before re-ranking
  "chatterQuota": 2         // hard cap on chatter results per injection
}
```

### `excludeChannels` is forward-only

Adding a channel to `excludeChannels` stops all future injection/writes/tools for that conversation, but does **not** remove content that was synced before the channel was quarantined.

- **Hot-buffer content** written by plugin versions since 2026-07 is tagged with `openclaw_channel_id` and can be removed with [`openclaw openclaw-hyperspell purge-channel <id>`](#openclaw-openclaw-hyperspell-purge-channel-channelid). Older hot-buffer rows are untagged, but each row's resource id equals its OpenClaw session id, so they are reachable via the purge command's `--session` flag.
- **Auto-trace resources and `/remember` memories** written by current versions carry the same `openclaw_channel_id` tag going forward. Ones written by older versions are not channel-tagged and cannot be automatically purged — identify them manually (e.g. via `hyperspell_search`) and use the purge command's `--resource` escape hatch.
- **Emotional-state registers** are keyed by relationship, not channel, and live behind the `/emotional-state` API rather than the memories store this command scans — they are never matched by `purge-channel`, and deletion of them is per-relationship, all-or-nothing. (Newer plugin versions tag registers with a `channelId` metadata field for analysis, but that does not make them purgeable per channel.)
- **Server-side extractions** derived from traces (`extract: ["procedure", "memory", "mood"]`) are created backend-side; whether deleting the parent trace removes them is an open backend question (see `docs/hyperspell-backend-followups.md`).

The purge command prints these standing limitations on every run.

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
