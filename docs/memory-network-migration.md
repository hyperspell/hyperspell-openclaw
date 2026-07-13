# Migrating a hand-maintained people/projects file to the Memory Network

If you keep a manually curated archive (e.g. a single `people.md` with everyone you know,
or per-project notes), the Memory Network automates most of it: it extracts the same
entities from your actual memory corpus, with source citations, and keeps them fresh on a
cron. This guide shows how to dry-run it and compare against your hand file **before**
letting it run unattended.

This doc owns the dry-run procedure; the enablement evaluation in
[`proposal/06-knowledge-graph-enablement`](proposals/06-knowledge-graph-enablement.md)
references these steps rather than duplicating them.

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
   (creates the extraction cron from `knowledgeGraph.scanIntervalMinutes`, default 60
   minutes), or set `knowledgeGraph.enabled: true` and create the cron manually. Unset
   `OPENCLAW_CONFIG_PATH` first. To change cadence later, edit the cron job — it is the
   runtime source of truth; keep `scanIntervalMinutes` in sync so the config stays an
   honest record.
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
