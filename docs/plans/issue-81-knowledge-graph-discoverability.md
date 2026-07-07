# Implementation guide — #81: Surface the dormant Memory Network (knowledge-graph) feature

## What the code actually shows

The feature is complete and shipped, but invisible unless you already know the config key:

- **Gate**: `registerNetworkTools(api, client, cfg)` runs only when `cfg.knowledgeGraph.enabled` is true. Default is `false`, so the three tools (`hyperspell_network_scan`, `hyperspell_network_write`, `hyperspell_network_complete`, `graph/tools.ts`) never register on a default install.
- **Config**: fully wired. `KnowledgeGraphConfig` type (`enabled`, `scanIntervalMinutes`, `batchSize`), parsed with defaults, present in `openclaw.plugin.json` `configSchema` and `uiHints` (label "Memory Network"). So this is *not* an unwired schema problem — it's purely a signal/docs problem.
- **Setup wizard**: `commands/setup.ts` has an opt-in step (`initialValue: false`); on yes it writes `knowledgeGraph: { enabled: true }` into `openclaw.json`, writes the extraction prompt to `<workspace>/HYPERSPELL-MEMORY-NETWORK.md`, and creates an hourly isolated-session cron. Anyone who configured the plugin before this step existed, answered no, or hand-edited config has the feature silently off with zero later signal.
- **CLI**: `openclaw openclaw-hyperspell network scan|complete|sync` exist *unconditionally* — they work even with `knowledgeGraph.enabled: false`, which is exactly what makes a safe dry-run possible (see Part 3).
- **Extraction contract**: the cron prompt (`graph/cron.ts:buildExtractionPrompt`) drives scan → write entity markdown into `memory/{people,projects,organizations,topics}/` → `network complete` → `network sync`. `writeEntity` (`graph/ops.ts`) merges into existing files by slug (union of `source_memories` and `relationships`, preserves `hyperspell_id`). Processed-ID state lives in `<workspace>/memory/.network-state.json` (`graph/state.ts`), written only by `completeMemories` — **`network scan` itself never persists state**, which matters for the dry-run story.
- **README**: the "Knowledge Graph" section is ten lines and its enable instruction is **wrong**: "Enable the graph tools by using `hyperspell_network_scan`…" — the tools don't exist until `knowledgeGraph.enabled` is set. `knowledgeGraph` is also absent from the Configuration Options table and the `network` CLI commands are absent from the CLI Commands section.

Two small correctness wrinkles worth fixing while we're here (both one-liners):

1. The wizard copy says the cron "runs as a periodic cron job **in the main session**", but the cron is created with `--session isolated`. Copy bug.
2. `knowledgeGraph.scanIntervalMinutes` is parsed and schema'd but **never read by any runtime code** — the wizard hardcodes `--every 1h` and `getCronSetupCommand`'s `interval` param is never called with the config value. The docs below must not pretend this knob works; see Part 4 for the recommended handling.

**On the #72 pattern**: issue #72 (moodWeatherChance silently 0) has a companion implementation-guide PR — both should read as siblings: the two existing precedents both live in `index.ts` `register()`: the `allowConversationAccess` startup warn (`api.logger.warn`, one message, names the exact config key and the consequence of not acting) and the startup-orientation inert-source warn. Match those.

---

## Part 1 — Discoverability: one startup info log (code change)

**File**: `index.ts`. Place immediately after the `allowConversationAccess` warn block, so the two "config you probably want to know about" notes sit together.

**Trigger condition**: `knowledgeGraph` key entirely absent from raw config, AND at least one memory-*accumulating* feature is on (`hotBuffer.enabled || autoTrace.enabled || emotionalContext`) — those are the signals that a corpus is growing that the network could be extracting from. Keying off the **raw** config (not `cfg`) is essential: an operator who wrote `knowledgeGraph: { enabled: false }` has made a decision and must not be nagged. `rawConfig` already exists in scope.

**Level**: `api.logger.info` (this is a nudge, not a misconfiguration like the two existing warns).

```ts
// Discoverability: the Memory Network ships fully built but default-off.
// If memories are accumulating (hot buffer / auto-trace / emotional state)
// and the operator never made a knowledgeGraph decision, say so once at
// startup — otherwise the feature is undetectable without reading source.
// An explicit `knowledgeGraph` key (even { enabled: false }) suppresses this.
const memoryAccumulating =
	cfg.hotBuffer.enabled || cfg.autoTrace.enabled || cfg.emotionalContext;
if (rawConfig?.knowledgeGraph === undefined && memoryAccumulating) {
	api.logger.info(
		"hyperspell: memories are accumulating but the Memory Network (knowledgeGraph) is not configured — " +
			"no entity extraction into memory/people|projects|organizations|topics will run. " +
			"Enable it via 'openclaw openclaw-hyperspell setup' (Memory Network step) or set " +
			"knowledgeGraph.enabled: true, or silence this note with knowledgeGraph: { enabled: false }. " +
			"See README § Memory Network.",
	);
}
```

Notes:
- Exact wording is adjustable, but keep the three load-bearing parts: what is inert, what the consequence is, and both remedies (enable *or* explicitly disable to silence).
- Do **not** gate on `syncMemories` — file sync alone doesn't imply a conversation corpus worth extracting from.
- No new config surface, no behavior change, no helper file. One conditional, one log call.

**Wizard copy fix (same PR, one line)**: change "This runs as a periodic cron job in the main session." → "This runs as a periodic cron job in an isolated session." (matches `--session isolated`).

---

## Part 2 — README: real "Memory Network" section

Three edits to `README.md`:

**(a) Configuration Options table** — add:

```markdown
| `knowledgeGraph.enabled` | boolean | `false` | Memory Network: extract entities (people, projects, organizations, topics) from memories into `memory/` markdown files. See [Memory Network](#memory-network). |
| `knowledgeGraph.batchSize` | number | `20` | Memories per extraction scan batch |
```

(Deliberately omit `scanIntervalMinutes` from the table until Part 4 resolves it — documenting a dead knob is worse than not documenting it.)

**(b) CLI Commands section** — add:

```markdown
### `openclaw openclaw-hyperspell network scan|complete|sync`

Memory Network primitives, used by the extraction cron's isolated session (and handy for
manual dry-runs — `scan` is read-only). `scan` lists unprocessed memories with content
summaries, `complete --ids <ids>` marks them processed, `sync` pushes `memory/` entity
files back to Hyperspell.
```

**(c) Replace the "Knowledge Graph" section wholesale** — the current enable instruction is false. Suggested replacement (rename the heading to match the product name used everywhere else in the plugin):

~~~markdown
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
prompt to `<workspace>/HYPERSPELL-MEMORY-NETWORK.md`, and creates the hourly cron:

```bash
openclaw openclaw-hyperspell setup   # answer "yes" at the Memory Network step
```

Or manually: set the plugin config and create the cron yourself:

```json
"knowledgeGraph": { "enabled": true }
```

```bash
openclaw cron add --name "Hyperspell Memory Network" --every 1h --session isolated \
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
The `graph_entity: true` frontmatter prevents synced entity files from being re-scanned
as source memories.
~~~

---

## Part 3 — Migration guide: new file `docs/memory-network-migration.md`

For operators who already keep a hand-maintained `people.md` / `projects.md`-style archive. Structure:

~~~markdown
# Migrating a hand-maintained people/projects file to the Memory Network

If you keep a manually curated archive (e.g. a single `people.md` with everyone you know,
or per-project notes), the Memory Network automates most of it: it extracts the same
entities from your actual memory corpus, with source citations, and keeps them fresh on a
cron. This guide shows how to dry-run it and compare against your hand file **before**
letting it run unattended.

## Why this is low-risk to try

- `network scan` is **read-only** — it lists unprocessed memories but persists nothing
  (`memory/.network-state.json` is only written by `network complete`).
- Entity writes go to new per-entity files under `memory/people/` etc. — your existing
  hand-maintained file is never touched.
- `enabled: false` (the default) means nothing runs until you create the cron; the tools
  and CLI can be exercised manually first.

## Step 1 — Preview what would be extracted (zero side effects)

The `network` CLI works even with `knowledgeGraph.enabled: false`:

```bash
openclaw openclaw-hyperspell network scan --batch-size 20
```

This prints unprocessed memories with participant/content summaries — the raw material the
extractor would work from. If this output looks like noise (bot messages, empty summaries),
fix your sources before going further.

## Step 2 — Full dry-run against a copy of the workspace

Run one complete extraction pass against a **copy** of your workspace so nothing lands in
the real `memory/` tree:

```bash
cp -R ~/.openclaw/workspace /tmp/hs-network-dryrun
cp ~/.openclaw/openclaw.json /tmp/hs-dryrun-config.json
# edit /tmp/hs-dryrun-config.json:
#   - agents.defaults.workspace → /tmp/hs-network-dryrun
#   - plugins.entries.openclaw-hyperspell.config.knowledgeGraph → { "enabled": true }
```

Then drive one extraction session by hand with the dry-run config active:

```bash
export OPENCLAW_CONFIG_PATH=/tmp/hs-dryrun-config.json
openclaw openclaw-hyperspell network scan
# feed the scan output + the extraction instructions in
# <workspace>/HYPERSPELL-MEMORY-NETWORK.md to an agent session, or write the entity
# files yourself following that format, then:
openclaw openclaw-hyperspell network complete --ids <resource-ids-from-scan>
```

Do NOT run `network sync` during the dry-run — that is the one step that writes to
Hyperspell rather than local files.

## Step 3 — Compare against your hand-maintained file

For each person/project in your hand file, check the corresponding
`/tmp/hs-network-dryrun/memory/people/<slug>.md`:

- **Coverage**: who did the extractor find that you track by hand? Who did it miss?
  (People who never appear in synced sources can't be extracted — they stay hand-maintained.)
- **Accuracy**: emails, org affiliations, relationships. The extractor cites
  `source_memories` — spot-check a few citations.
- **Noise**: entities you'd never bother tracking. The extraction prompt already tells the
  model to skip bot/noise content, but judge the real output.

## Step 4 — Adopt

1. Enable for real: `openclaw openclaw-hyperspell setup` → yes at the Memory Network step
   (creates the hourly cron), or set `knowledgeGraph.enabled: true` and create the cron
   manually. Unset OPENCLAW_CONFIG_PATH first.
2. **Seed from your hand file (optional but recommended)**: for entries the extractor
   missed or got thinner than your hand notes, pre-create
   `memory/people/<slug>.md` files in the entity format with `graph_entity: true`
   frontmatter. Future extraction runs merge into existing files by slug — your seeded
   facts are preserved, and new `source_memories`/`relationships` are unioned in.
3. Keep or retire the hand file. If you keep it (e.g. for people outside your synced
   sources), consider moving it out of `memory/` scan paths or accept that `syncMemories`
   ingests both — they coexist fine, but search will surface both versions of a person.
4. First run processes the whole backlog (potentially hundreds of memories over several
   cron cycles). Watch `memory/.network-state.json` grow; `network scan` reports
   processed count and last-scan time.

## Rollback

Remove the cron (`openclaw cron remove --name "Hyperspell Memory Network"`), set
`knowledgeGraph.enabled: false` (or delete the key), and delete the generated entity
directories. Deleting `memory/.network-state.json` resets processed-tracking to zero.
~~~

Link this doc from the README section.

---

## Part 4 — `scanIntervalMinutes`: don't document a dead knob

Recommended: **wire it in the wizard**, since it's a 3-line change at the only place a cron is created. The wizard has just written `knowledgeGraph: { enabled: true }`; instead pass the interval through:

```ts
const scanIntervalMinutes = 60; // wizard default; config knob follows the cron it creates
// "--every", "1h",  →  "--every", `${scanIntervalMinutes}m`,
```

…and persist `knowledgeGraph: { enabled: true, scanIntervalMinutes }` so the config reflects the cron that actually exists. That keeps the field honest without building any runtime rescheduling. If the maintainer would rather not touch the wizard in this PR, the fallback is to leave the field undocumented (as Part 2 does) and open a small follow-up issue — either is fine; **do not** add the field to the README table while nothing reads it.

---

## Tests

This is honestly a **one-log-line + docs PR** — there is no extraction-behavior code change, so no extraction tests are being invented. What's worth adding:

1. **`config.test.ts`** — `knowledgeGraph` parsing currently has zero coverage. Add two cheap tests in the existing style:
   - `parseConfig — knowledgeGraph defaults to disabled with sensible values` → `enabled: false`, `scanIntervalMinutes: 60`, `batchSize: 20` when the key is absent.
   - `parseConfig — knowledgeGraph accepts overrides` → `{ enabled: true, batchSize: 50 }` round-trips.
2. **The log line itself**: `register()` has no test harness (no `index.test.ts` exists yet — though #69's companion guide proposes adding one; if that lands first, add this assertion there instead of a separate harness). Verify manually: restart the gateway with `hotBuffer.enabled: true` and no `knowledgeGraph` key → line appears once at startup; add `knowledgeGraph: { enabled: false }` → line gone; enable it → line gone and tools register.
3. **The issue's acceptance scenario** (enable against a real corpus with an existing hand-maintained file, run the cron once, diff entity files vs. the hand file) is exactly Steps 2–3 of the migration doc — run it once as PR evidence and paste a redacted before/after into the PR body, rather than encoding it as an automated test (it requires a live Hyperspell corpus).

Run `npm test` before pushing.

---

## Files touched

- `index.ts` — add the startup info log (one conditional + `api.logger.info`, after the `allowConversationAccess` warn block)
- `commands/setup.ts` — wizard copy fix "main session" → "isolated session"; optionally wire `scanIntervalMinutes` into the cron creation
- `config.test.ts` — two new `parseConfig` tests for `knowledgeGraph` defaults/overrides
- `README.md` — replace the "Knowledge Graph" section with the full "Memory Network" section; add `knowledgeGraph` rows to the Configuration Options table; add `network scan|complete|sync` to CLI Commands
- `docs/memory-network-migration.md` — **new**: dry-run + comparison + adoption guide for hand-maintained archive migration

No changes to `graph/*`, `openclaw.plugin.json`, or any runtime extraction behavior.
