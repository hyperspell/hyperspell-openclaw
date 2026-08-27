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

### `openclaw openclaw-hyperspell network scan|complete|sync`

Memory Network primitives, used by the extraction cron's isolated session (and handy for
manual dry-runs — `scan` is read-only). `scan` lists unprocessed memories with content
summaries, `complete --ids <ids>` marks them processed, `sync` pushes `memory/` entity
files back to Hyperspell.

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
| `ranking.processPaths` | string[] | `[]` | Case-insensitive path substrings marking synced files as the **agent's own process output** (thought logs, caches, heartbeat notes). Matches classify as `process` and score neutral — no curation boost, full-speed recency decay — instead of being promoted as curated user truth. |
| `ranking.perFileCap` | number | `2` | Max injected results per synced source file. Distinct sections of one document pass near-duplicate dedup individually and would otherwise monopolize the pool at near-identical scores. `0` disables. |
| `excludeChannels` | string[] | `[]` | Conversation/channel ids fully quarantined from memory: no context injection, no memory writes, no memory tools. Threads inherit. **Forward-only** — see [below](#excludechannels-is-forward-only). |
| `quarantineResources` | string[] | `[]` | Vault resource ids excluded from every retrieval-pool read while the records stay in the vault. For kept-but-poison records — see [Retrieval quarantine](#quarantineresources--retrieval-quarantine-for-kept-records). |
| `knowledgeGraph.enabled` | boolean | `false` | Memory Network: extract entities (people, projects, organizations, topics) from memories into `memory/` markdown files. See [Memory Network](#memory-network). |
| `knowledgeGraph.scanIntervalMinutes` | number | `60` | Extraction cadence the setup wizard bakes into the cron job it creates. The cron job is the runtime source of truth — to change cadence after setup, edit the cron job (and keep this field in sync). |
| `knowledgeGraph.batchSize` | number | `20` | Memories per extraction scan batch |
| `coverageLog` | boolean | `false` | **Opt-in.** Append local-only retrieval telemetry after every successful auto-context search, including raw/gated scores and injected-result descriptors. Events include prompt text — see [Coverage log](#coverage-log). |
| `recallSignal` | boolean | `false` | **Opt-in.** Inject a one-line retrieval-shape signal (candidate count, best gated score, threshold, shown count) into context on every auto-context turn, including empty ones — see [Coverage log](#coverage-log). Shape only; never the near-miss content. |
| `debug` | boolean | `false` | Enable diagnostic logging. One-line diagnostics (auto-context ranked/cut/injection summaries, orientation and emotional-context injection counts) are emitted at **info** level, so they appear in `gateway.log` at default host log levels — no host `logging.level` change needed. Verbose output (per-request/response dumps, per-candidate score lines) stays at debug level. |
| `dreaming.enabled` | boolean | `false` | Allow `memory-core` to sidecar-load so Dreaming can consolidate local session transcripts into `workspace/MEMORY.md`. See [Running alongside Dreaming](#running-alongside-dreaming). |

Stored emotional-state registers (`emotionalContext`) are fetchable by external processes (e.g. a nightly consolidator reconciling its own day-read) — the verified fetch contract lives in [docs/emotional-state-external-reconciliation.md](docs/emotional-state-external-reconciliation.md).

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

**Provenance:** every synced memory carries an `openclaw_sync_source` metadata key recording where the content came from: `"memory"` for files under `memory/`, and the watchPath's `source` label (or a slug derived from its path, e.g. `notes/brainstem` → `notes_brainstem`) for watchPath files. This lets retrieval distinguish curated memory files from machine-generated content. The key is additive — `openclaw_source` (which pipeline wrote the row) is unchanged. Already-synced content is **not retroactively retagged**: uploads are gated by per-section content hash, so previously synced sections keep their old metadata until their content next changes.

**Tuning sync (object form):**

```jsonc
"syncMemories": {
  "enabled": true,
  "sectionize": true,     // split files on ## headings into separate memories
  "watchPaths": [          // extra files/dirs to sync beyond memory/
    "notes",                                                  // plain path — tagged with slug "notes"
    { "path": "notes/brainstem", "source": "brainstem_daily" } // labeled — tagged openclaw_sync_source: "brainstem_daily"
  ],
  "debounceMs": 2000,      // wait for writes to settle before syncing
  "maxAgeDays": 30          // startup skips already-synced files older than this
}
```

`watchPaths` is how you make **externally generated notes** searchable: tools that write dated markdown reports under the workspace (nightly consolidators, journal generators — e.g. a Brainstem consolidator writing `notes/brainstem/YYYY-MM-DD.md`) are invisible to sync until their file or directory is listed here. Watched paths are picked up by the startup bulk sync. Use the labeled object form so machine-generated content is distinguishable from curated memories at retrieval time. Sectionized mode (the default) is **recommended for external directories**: legacy whole-file mode (`sectionize: false`) writes a `hyperspell_id` frontmatter line back into the source file — i.e. the plugin edits another tool's files — while sectionized mode tracks state in the sync manifest and leaves watched files untouched.

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
- **hyperspell_vault_triage** - Read-only audit search that does NOT apply the retrieval quarantine: quarantined hits come back flagged with content suppressed, plus the current quarantine roster. For hunting bad/stale/misattributed records proactively (quarantine is otherwise discovered only by being injected) and for verifying a quarantine took effect — not for normal recall
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

Classification is **origin-aware where origin is known**: results carrying the
plugin's own write-pipeline metadata are classified by that tag first (a
hot-buffer session the backend consolidator happened to *title* is still a
conversation echo, not curated memory), and synced files matching
`ranking.processPaths` classify as `process` — the agent's own operational
output, scored neutral rather than promoted. Without that knob, a "titled,
non-UUID" heuristic hands agent thought-logs and caches the same curation
boost as deliberately kept user notes, and at volume the agent's process noise
out-competes the user's quiet, durable memory. The title/id-shape heuristic
remains the fallback for records with no origin metadata.

One more diversity guard: `ranking.perFileCap` (default `2`) bounds how many
sections of a single synced file can be injected at once. Sectionized sync
turns a big file into many sibling candidates at near-identical scores; they
pass near-duplicate dedup individually (different text, same document) and
would otherwise fill the pool.

Provenance is a signal too: an optional `sourceWeights` map multiplies a
result's **base relevance** (before the kind boosts/penalties are added) by a
per-source factor, so "a journaled Notion page is more intentional memory than
a titled Slack aside on the same topic" is expressible. Any source not listed
— including sources that don't exist yet — is neutral (`1.0`); the shipped
default is `{}`, a strict no-op. It weights sources already in the result set;
to *exclude* a source, use the `sources` filter instead (weights of 0 are
rejected at load with exactly that pointer). Suggested starting points, priors
to seed your own tuning rather than measured truth: authored systems slightly
up (`notion` 1.15, drive/box/dropbox 1.1), conversational exhaust slightly
down (`slack`/`microsoft_teams` 0.85, `trace` 0.8) — magnitudes small enough
to break ties, never to override a real relevance gap. Typos in weight keys
are not schema errors (new backend sources must not fail validation); with
`debug: true` unknown keys are flagged once at startup in `gateway.log`.

Selected results are also checked against each other for **near-duplicates**:
when the same memory exists in several forms (a re-synced doc section, a
`remember` note quoting it, a curated copy of a hot-buffer row), every copy
clears the threshold, none is chatter, and pre-dedup they filled multiple
injection slots with one piece of information. Each candidate's lead text is
compared against already-selected results by token overlap; above
`dedupThreshold` (0.8) the copy is skipped and its slot passes to the
next-ranked *different* memory. Skipped copies never consume the chatter
quota. Set `dedupThreshold: 0` to disable. Paraphrased duplicates (same fact,
different words) are beyond a string measure and out of scope.

Within each selected memory, the second excerpt earns its place: a result
renders up to two highlight bullets, and the runner-up rides along only when
its score is within 0.15 of the top one's — a .95/.40 pair renders one bullet
(the distant second is usually a weaker paraphrase), a .95/.85 pair renders
both. The top highlight is always kept, so a selected memory never disappears
from the injection because of this rule.

An optional **elbow cutoff** (`ranking.elbow`, **off by default**) stops
injecting at a natural score cliff instead of always filling `maxResults`: a
narrow query backed by 3 genuinely relevant memories no longer pads the
context with a plateau of marginal ones that happen to clear the threshold.
It is strictly conservative — it only ever cuts *earlier*, never later, never
below `minResults` (default 3), and when no clear cliff exists (gradual
decline, flat plateau) selection is identical to today. A cliff means the
drop from the last accepted result is both large against the decline seen so
far (`gapRatio` × mean gap, default 2.5×) *and* material in absolute terms
(`minGap`, default 0.05). Before enabling, run
`node --experimental-strip-types docs/elbow-scan.mjs` against your real data
to check firing rate and cut depth (with `debug: true` the live verdict shows
in `gateway.log` as `auto-context: elbow stopped at k (ceiling N)`).

Age matters too, gently: results accrue a small **recency penalty** that grows
with age (exponential decay, 90-day half-life by default) and is hard-capped at
`recencyMaxPenalty` (0.1) so it can break near-ties toward current information
but never bury a strong old match. Deliberately-kept memory (curated/story)
ages at half rate (`recencyCuratedFactor`) — an old truth you chose to keep
still beats a fresh shallow echo. Results without a timestamp are never
penalized. Set `recencyHalfLifeDays: 0` to disable.

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
- To verify it's working, enable `debug: true` and watch `gateway.log` for the
  per-search tally (`auto-context: ranked {...} candidates → selected {...}`) and the cut tally (threshold / max-results / elbow / near-duplicate / chatter-quota) —
  it appears at default host log levels. The per-candidate lines
  (`[story] 0.47→0.82 The Lighthouse Keeper — Chapter 3`), which show story
  matches even when they lose to the threshold, are debug-level and also need
  host debug logging.

Full knobs and defaults:

```jsonc
"ranking": {
  "enabled": true,
  "curationBoost": 0.2,     // lift for deliberately-kept memory
  "chatterPenalty": 0.2,    // penalty for auto-saved conversation fragments
  "storyBoost": 0.15,       // extra lift for storyTerms matches (stacks with curationBoost)
  "storyTerms": [],         // REQUIRED for storyBoost to do anything
  "candidateMultiplier": 3, // fetch this × maxResults candidates before re-ranking
  "chatterQuota": 2,        // hard cap on chatter results per injection
  "recencyHalfLifeDays": 90,  // age at which half the recency penalty has accrued (0 = off)
  "recencyMaxPenalty": 0.1,   // ceiling on the recency penalty — a tiebreaker, never a burial
  "recencyCuratedFactor": 0.5, // kept memory (curated/story) ages at this fraction of the rate
  "sourceWeights": {},        // per-source multiplier on base relevance; unlisted = 1.0
  "dedupThreshold": 0.8,      // token-overlap ratio that skips a near-duplicate (0 = off)
  "elbow": {                  // stop early at a natural score cliff (opt-in)
    "enabled": false,
    "minResults": 3,          // never cut below this many accepted results
    "gapRatio": 2.5,          // cliff = drop >= this multiple of the mean gap so far...
    "minGap": 0.05            // ...AND at least this big on the raw composite scale
  }
}
```

### Coverage log

No ranking tweak can surface a memory that was never captured — and by default nothing distinguishes "ranking failed" from "it was never stored." With `coverageLog: true`, every successful auto-context search appends one line to `<workspaceDir>/.hyperspell-coverage.jsonl`:

- `outcome: "empty"` — the search succeeded but returned zero candidates (a capture question: was this ever stored?)
- `outcome: "below_threshold"` — candidates existed but the best gated score did not clear `relevanceThreshold`
- `outcome: "filtered"` — a candidate cleared the score gate but another selector (quota, dedup, file cap, elbow, or result cap) showed nothing
- `outcome: "injected"` — memories were shown; `shown`, `shownChars`, and the content-free `selected` descriptors (`resourceId`, `kind`, `writer`, `injectedChars`) record what occupied the context budget

Schema v2 separates `rawTopScore` (the server/cross-encoder score) from `topScore` (the client composite actually compared with `threshold`). Never compare `rawTopScore` with the threshold: client boosts, penalties, source weights, and recency adjustment change the gated value.

The authorship ratio the hit telemetry exists for should be computed from per-item sums — `sum(injectedChars where writer = agent) / sum(injectedChars)` — which are exact. In single-user events `sum(selected[].injectedChars)` equals `shownChars` minus the join separators (`2·(shown−1)`); in multi-user events `shownChars` additionally counts lane wrappers and the identity preamble, so only the per-item sums are additive there.

Failed searches never produce events — backend-unavailable is not "no memories." In multi-user mode there is one event per turn with per-lane detail, and a lane whose search failed is recorded as `status: "error"`, never as zero candidates.

**Local-only guarantee:** the log is written only to the workspace directory and is never sent to Hyperspell or anywhere remote. Because each event carries the triggering prompt (truncated to 500 chars), the feature is **off by default** — prompt text reaches disk only if you explicitly opt in. The file is capped at 5 MB with one `.old` rotation generation (~10 MB total), so content ages out instead of accumulating.

Review with `jq`, e.g.: `jq -r '[.ts, .outcome, .rawTopScore, .topScore, .shown, .prompt] | @tsv' ~/.openclaw/workspace/.hyperspell-coverage.jsonl` — after a week or two of labeling (capture gap / ranking near-miss / correct absence), the tallies say whether the next investment belongs in capture or ranking. Delete the file when done.

With `recallSignal: true` (independent of `coverageLog`, also off by default), the same retrieval shape is injected into the agent's context on every successful auto-context search, including searches that surface no memory:

```text
recall: 24 candidates · best 0.49 · threshold 0.60 · nothing shown
```

The displayed `best` is the gated composite score, not the raw server score. This is metadata, not evidence that a matching memory exists. It gives the agent a feeling-of-knowing signal for deciding whether to run a deliberate search instead of treating an empty passive result as proof of absence. Failed searches do not emit the signal because their retrieval shape is unknown. Off by default: an every-turn injection changes what every session sees, so it lands on an install only by explicit opt-in (and, where the agent is a party to her own configuration, with her sign-off).

### `excludeChannels` is forward-only

Adding a channel to `excludeChannels` stops all future injection/writes/tools for that conversation, but does **not** remove content that was synced before the channel was quarantined.

- **Hot-buffer content** written by plugin versions since 2026-07 is tagged with `openclaw_channel_id` and can be removed with [`openclaw openclaw-hyperspell purge-channel <id>`](#openclaw-openclaw-hyperspell-purge-channel-channelid). Older hot-buffer rows are untagged, but each row's resource id equals its OpenClaw session id, so they are reachable via the purge command's `--session` flag.
- **Auto-trace resources and `/remember` memories** written by current versions carry the same `openclaw_channel_id` tag going forward. Ones written by older versions are not channel-tagged and cannot be automatically purged — identify them manually (e.g. via `hyperspell_search`) and use the purge command's `--resource` escape hatch.
- **Emotional-state registers** are keyed by relationship, not channel, and live behind the `/emotional-state` API rather than the memories store this command scans — they are never matched by `purge-channel`, and deletion of them is per-relationship, all-or-nothing. (Newer plugin versions tag registers with a `channelId` metadata field for analysis, but that does not make them purgeable per channel.)
- **Server-side extractions** derived from traces (`extract: ["procedure", "memory", "mood"]`) are created backend-side; whether deleting the parent trace removes them is an open backend question (see `docs/hyperspell-backend-followups.md`).

The purge command prints these standing limitations on every run.

### `quarantineResources` — retrieval quarantine for kept records

Some records should be **kept but never surfaced as live context**: correctly attributed, deliberately preserved (an audit trail, a documented failure), yet false or poisonous as testimony about the present. Deleting them destroys evidence; leaving them in the retrieval pool re-injects them as if current.

`quarantineResources` lists vault resource ids that every retrieval-pool read skips — auto-context (both single- and multi-user lanes), the `hyperspell_search` tool, startup orientation, and `/getcontext`. The drop happens client-side after fetch (no added search latency, no write to the record needed), and the fetch limit is widened to compensate so quarantined hits don't eat result slots.

What quarantine does **not** do:

- It does not delete or modify anything — the records stay in the vault untouched.
- It does not block addressed reads: fetching a quarantined record directly by id still works. The point is to stop ambient injection, not to make the record unreadable.
- It does not hide records from management enumeration — `purge-channel` and similar tooling still see them.

The ids to use are exactly the `resource_id` values shown in injected context blocks and search results. Design rationale (including why this is not a backend metadata filter): [docs/quarantine-retrieval.md](docs/quarantine-retrieval.md).

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

## Memory Network

The Memory Network (config key: `knowledgeGraph`) automatically builds a local knowledge
graph from your memories. A periodic cron job runs in an isolated session and:

1. **Scans** unprocessed memories (`hyperspell_network_scan` / `network scan`)
2. **Extracts** people, projects, organizations, and topics with relationships
3. **Writes** one markdown file per entity into `memory/people/`, `memory/projects/`,
   `memory/organizations/`, `memory/topics/` (`hyperspell_network_write`)
4. **Marks** the batch processed so it is never re-scanned (`hyperspell_network_complete`;
   state lives in `memory/.network-state.json`)
5. **Syncs** the entity files back to Hyperspell so they are searchable (`network sync`)

If you also maintain a hand-written people/projects reference file, this feature
automates most of that by hand-off — see
[Migrating from a hand-maintained archive](docs/memory-network-migration.md) for a safe
dry-run and comparison procedure before adopting it.

### Enabling it

The easiest path is the setup wizard, which flips the config, writes the extraction
prompt to `<workspace>/HYPERSPELL-MEMORY-NETWORK.md`, and creates the extraction cron
(interval from `knowledgeGraph.scanIntervalMinutes`, default 60 minutes):

```bash
openclaw openclaw-hyperspell setup   # answer "yes" at the Memory Network step
```

Or manually: set the plugin config and create the cron yourself:

```json
"knowledgeGraph": { "enabled": true }
```

```bash
openclaw cron add --name "Hyperspell Memory Network" --every 60m --session isolated \
  --message "Read the file at <workspace>/HYPERSPELL-MEMORY-NETWORK.md and follow the instructions inside it."
```

The `hyperspell_network_*` tools only register when `knowledgeGraph.enabled` is true.

### What an extracted entity file looks like

`memory/people/alice-chen.md`:

```markdown
---
title: Alice Chen
type: person
graph_entity: true
email: alice@hyperspell.com
source_memories: {"slack":["C073WR69EPM"],"google_mail":["19bbe68026553623"]}
relationships: ["works-at:organizations/hyperspell","leads:projects/memory-network"]
last_extracted: 2026-07-07T12:00:00Z
---
# Alice Chen

Engineering Manager at Hyperspell. Leads the Memory Network project.

## Contact

- Email: alice@hyperspell.com

## Relationships

- works-at: [hyperspell](../organizations/hyperspell.md)
- leads: [memory network](../projects/memory-network.md)
```

Re-extraction **merges**: existing `source_memories`, `relationships`, and
`hyperspell_id` are preserved and unioned, so files are safe to hand-edit between runs.

Re-extraction is idempotent by design (the cron agent re-derives the same entities and
marks rows complete). A previously known gap meant entity files synced back to Hyperspell
re-entered future scans as unprocessed source memories; the fix lands alongside
[`proposal/06-knowledge-graph-enablement`](docs/proposals/06-knowledge-graph-enablement.md)
(PR #99), which propagates the `graph_entity` frontmatter into sync metadata and makes
the scanner skip memories synced from the entity directories.

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
- Enable `debug: true` — the ranked/cut/injection summary lines land in
  `gateway.log` at default host log levels
- Check that you have memories matching your conversation topics
- **After a gateway update**, grep `gateway.log` for `unknown typed hook` — a
  host release that renames/removes a hook silently disables the feature
  behind it (writes can keep working while all injection is dead). The plugin
  logs its registered hooks at startup (`typed hooks registered: …`) and runs
  a cross-hook liveness watchdog: if turn traffic proves one of the
  injection/write hook pair alive while its sibling never fires, it logs an
  **error** naming the dead hook instead of staying silent.

### Enabling `memory-core` disabled Hyperspell
- This means `memory-core` was placed in `plugins.slots.memory`. The slot should stay on `openclaw-hyperspell`; `memory-core` rides alongside as a sidecar.
- Restore: set `plugins.slots.memory = "openclaw-hyperspell"`, set both plugins `enabled: true`, and add `dreaming: { enabled: true }` to the Hyperspell config. See [Running alongside Dreaming](#running-alongside-dreaming).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT
