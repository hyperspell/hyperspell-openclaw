# Idea #6 — Enable and evaluate the Knowledge Graph for who/what recall

Implementation guide for idea #6 from issue #66. The feature already exists in the codebase (`graph/*`), is fully wired into setup, and is OFF by default. The work here is: turn it on for one install, verify the entity files actually feed back into retrieval, and measure whether who/what questions get better answers.

> **Status update (this branch, post-0.19.0 rebase):** both code gaps identified below are now confirmed by code reading and **fixed on this branch**, ahead of the live evaluation:
>
> - **§3.3 self-scan loop** — fixed with two guards: (1) `sync/markdown.ts` now propagates `graph_entity: true` frontmatter into the synced memory's metadata in **both** sync paths (sectionized and legacy whole-file), honoring the contract the extraction prompt states; (2) `graph/ops.ts` `isEntityFileMemory` additionally skips memories whose `metadata.file_path` falls under `memory/(people|projects|organizations|topics)/`, which covers records synced *before* the propagation existed (unchanged sections are content-hash skipped on re-sync, so their old metadata is never refreshed — propagation alone could not close the loop for them). Tests: `graph/ops.test.ts` (entity-derived records skipped, tagged and legacy), `sync/markdown.test.ts` (propagation in both paths).
> - **§3.3 second seam (multi-user CLI bypass)** — the CLI `network scan` now passes `cfg` into `scanMemories`, and `scanMemories`' `cfg` parameter is required (not optional) so no caller can silently bypass the `getAllUserIds` fan-out again. Single-user installs without a `userId` still scan under the key's default identity. Test: `graph/ops.test.ts` (fan-out over mapped users + shared, default-identity fallback).
> - **§3.1 cadence gotcha** — reconciled with `issue-81-knowledge-graph-discoverability` (PR #114) into one approach: the wizard wires one `scanIntervalMinutes` value into both the cron's `--every` and the persisted `knowledgeGraph.scanIntervalMinutes` (implemented on #114's branch). The cron job remains the runtime source of truth; the config field is an honest record of the cron the wizard created.
> - **§4.2 probe script** — `docs/kg-eval.mjs` is implemented on this branch; the question fixture stays owner-created at eval time (real names must come from the install's history).
> - The wizard "main session" copy fix is implemented on #114's branch (whichever lands second no-ops).
>
> What remains is owner-run: the live dry-run + evaluation (see §3.4 for the exact command sequence).

## 1. Summary

"Who is X" / "what's the state of Y" questions currently depend on some past conversation being semantically close to the query — a bad fit for structured facts that are scattered across many low-signal conversation fragments. The Knowledge Graph feature (`cfg.knowledgeGraph`, default `enabled: false` — `config.ts:579-583`) already implements the alternative: a periodic cron job runs an isolated agent session that scans memories (`graph/ops.ts` `scanMemories`), extracts entities into `memory/people/`, `memory/projects/`, `memory/organizations/`, `memory/topics/` markdown files, and syncs them back to Hyperspell. Because the existing `syncMemories` markdown walk includes those directories by default (§3.2), entity files become ordinary searchable memories with real titles — which the composite ranker classifies as `curated` and boosts (`lib/ranking.ts` `classifyResult`). This proposal is: enable it on one install, run a fixed 8-question who/what evaluation before and after, and measure both answer quality and entity-file staleness.

## 2. Problem

Grounding in the actual code:

- **Retrieval is search-only today.** `hooks/auto-context.ts` `buildAutoContextHandler` does a semantic `client.search(prompt, …)` (auto-context.ts:192-195) and injects highlight bullets. It has no awareness of entity files and never reads `memory/people/*.md` directly. A "who is Alice" query only wins if some past conversation fragment both mentions Alice and scores above `relevanceThreshold` (default 0.6, `config.ts:576`). Structured facts (email, role, org, project ownership) are usually spread across many fragments, each individually weak.
- **The structured alternative already exists but is dark.** `graph/cron.ts` `buildExtractionPrompt` generates a full extraction prompt (entity file format with frontmatter: `title`, `type`, `graph_entity: true`, `source_memories`, `relationships`, `last_extracted`). `graph/ops.ts` implements `scanMemories` (batched scan of unprocessed memories, ops.ts:94-137), `writeEntity` (merge-on-write entity files, ops.ts:155-252), and `completeMemories` (ops.ts:254-259). `graph/state.ts` `NetworkStateManager` persists the scan cursor at `memory/.network-state.json`. `graph/tools.ts` `registerNetworkTools` registers `hyperspell_network_scan` / `hyperspell_network_write` / `hyperspell_network_complete` — but only when `cfg.knowledgeGraph.enabled` (`index.ts:225-227`).
- **Enablement is already automated.** `commands/setup.ts:394-497` (the `enableNetwork` confirm flow) does everything: writes `knowledgeGraph: { enabled: true }` into the plugin config (setup.ts:416), writes the extraction prompt to `<workspace>/HYPERSPELL-MEMORY-NETWORK.md` (setup.ts:427-430), creates the cron job via `openclaw cron add --name "Hyperspell Memory Network" --every 1h --session isolated --message "Read the file at <promptPath> …"` (setup.ts:437-443), and optionally triggers an immediate first run via `openclaw cron run <id>` (setup.ts:484-486). The cron job runs in an **isolated agent session** reading the prompt file — it is not a hook. (Note: the setup copy at setup.ts:398 says "in the main session"; the actual flag is `--session isolated`. Cosmetic fix, worth folding into whatever PR touches this next.)

So the problem is not missing machinery — it is that the feature has never been enabled and evaluated, and one link in the chain (entity files → retrieval) has never been verified end-to-end.

## 3. Proposed design

### 3.1 Enablement steps (existing feature, no new code)

Preferred path — the wizard, which automates all of it:

```
openclaw openclaw-hyperspell setup   # answer "yes" at "Enable the Memory Network?"
```

Equivalent manual path (what the wizard does, for installs where the wizard is inconvenient):

1. Set `knowledgeGraph: { enabled: true }` in the plugin config entry and restart the gateway (so `registerNetworkTools` runs, `index.ts:225-227`).
2. Write the extraction prompt file: the content of `buildExtractionPrompt(workspaceDir)` to `<workspace>/HYPERSPELL-MEMORY-NETWORK.md`.
3. Create the cron job (`getCronSetupCommand` in `graph/cron.ts:356` produces the same shape):
   ```
   openclaw cron add \
     --name "Hyperspell Memory Network" \
     --every 1h \
     --session isolated \
     --message "Read the file at <workspace>/HYPERSPELL-MEMORY-NETWORK.md and follow the instructions inside it."
   ```
4. Optionally trigger the first run now: `openclaw cron run <job-id>`. First run on a large corpus loops scan→extract→complete until "No unprocessed memories found" (extraction prompt step 6) — expect it to take a while and burn tokens proportional to corpus size.

**Config gotcha (cadence) — resolved:** `knowledgeGraph.scanIntervalMinutes` (default 60) used to be parsed and schema'd but read by nothing; the cron's `--every 1h` was hardcoded. Reconciled with PR #114's guide into ONE remedy, implemented on #114's branch: the wizard uses a single `scanIntervalMinutes` value for both the cron's `--every ${n}m` and the persisted `knowledgeGraph: { enabled: true, scanIntervalMinutes }`, so config and cron are born in agreement. There is still no runtime rescheduling — the cron job is the source of truth; to change cadence after setup, edit the cron job (and keep the config field in sync so it stays an honest record).

**Prerequisite check:** `syncMemories` must be enabled (it is what feeds entity files back into search, §3.2). Confirm `cfg.syncMemoriesConfig.ignorePaths` has not been customized to exclude the entity directories.

### 3.2 Do entity files feed back into retrieval automatically? — YES (resolved)

This was the key open question. Answer: **no retrieval change is needed** — entity files become searchable through three existing paths, provided `syncMemories` is on:

1. **The sync walk includes them by default.** `sync/markdown.ts` `getMemoryFiles` (markdown.ts:322-353) walks `memory/` recursively, skipping only dot-entries and directories named in `ignorePaths` — whose default is `["dreaming"]` (`DEFAULT_IGNORE_DIRS`, markdown.ts:309; config default at `config.ts:570-572`). `memory/people/`, `memory/projects/`, `memory/organizations/`, `memory/topics/` are **not** excluded, so the startup bulk sync (`syncMemoriesOnStartup`, `hooks/memory-sync.ts:141`, invoked fire-and-forget from `index.ts` service `start`) ingests them.
2. **Live sync on write.** The cron session's agent writes entity files with its `write` tool (extraction prompt, `graph/cron.ts:10`), which fires the `file_changed` hook. `buildFileSyncHandler`'s `isSyncable` (`hooks/memory-sync.ts:56-71`) accepts any `.md` under `memory/` not in an ignored dir — entity files pass, and get debounce-synced within ~2s of being written.
3. **Explicit belt-and-braces.** The extraction prompt's step 7 has the cron agent run `openclaw openclaw-hyperspell network sync` after each full pass (`graph/cron.ts:27-30`), which calls `syncAllFilesSectionized` (the `networkCmd` `sync` action in `commands/setup.ts`), mirroring the runtime's sectionize mode.

**How they land in search:** with `sectionize` on (the default), `parseMarkdownSections` splits the entity file body (frontmatter is stripped by `readMarkdownFile`). The description becomes the preamble section titled by the `# heading`; `## Contact` / `## Relationships` sections shorter than 80 chars merge into it (markdown.ts:187-192), so a typical entity file lands as **one or two memories titled with the entity's real name** (e.g. `Alice Chen` or `Alice Chen — Relationships`). Because they have a real title and a non-UUID `resourceId`, `classifyResult` (`lib/ranking.ts`) tags them `curated`, which earns `curationBoost` in the composite ranker — exactly the ranking treatment a structured fact should get over conversation chatter.

**One deliberate design consequence to note:** the graph's relationship links (`works-at:organizations/hyperspell`) survive only as markdown text/links inside the synced memory — search treats them as content, not as a traversable graph. For this idea that is fine (the hypothesis is only "entity file text answers who/what better"); actual graph traversal is out of scope.

### 3.3 The `graph_entity` re-scan guard was inert — FIXED on this branch

`scanMemories` skips memories whose **metadata** carries `graph_entity`, and the extraction prompt promises that `graph_entity: true` frontmatter "prevents the scan from re-processing entity files that get synced back to Hyperspell" (`graph/cron.ts:353`). But neither sync path propagated frontmatter into memory metadata:

- `syncMarkdownFileSectionized` set metadata `{ openclaw_source: "memory_sync_section", file_path, file_name, section_title, content_hash }`;
- legacy `syncMarkdownFile` set `{ openclaw_source: "memory_sync", file_path }`.

`graph_entity` from the frontmatter was parsed and discarded. So synced entity sections re-entered the next scan as unprocessed memories: the cron agent was handed its own entity files as extraction sources. Severity moderate — `writeEntity` merges idempotently and the agent should just re-derive the same entities and mark the rows `complete` — but it wastes cron tokens every cycle and risks slow self-reinforcement (entity files citing entity files in `source_memories`).

**Fix (this branch):** both remedies proposed here, because each covers a case the other cannot:

1. **Frontmatter propagation** (`sync/markdown.ts`): both sync paths now include `graph_entity: "true"` in the memory's metadata when the file's frontmatter carries it — honoring the contract the extraction prompt states. Covers all future syncs, including hand-seeded entity files.
2. **Entity-directory path guard** (`graph/ops.ts` `isEntityFileMemory`): the scan also skips memories whose `metadata.file_path` falls under `memory/(people|projects|organizations|topics)/`. This covers records synced *before* the propagation existed — unchanged sections are content-hash skipped on re-sync, so their stale metadata would never be refreshed and propagation alone could not close the loop for them.

Tests: `graph/ops.test.ts` proves both a tagged and a legacy (path-only) entity-derived record are skipped while a real source memory is not; `sync/markdown.test.ts` proves the propagation in both sync paths and that ordinary files stay untagged.

**Residual verification for cycle 1:** after the first full extraction pass plus one further scan cycle, run `openclaw openclaw-hyperspell network scan` and confirm no entity titles (e.g. `Alice Chen — Relationships`) appear in the batch.

**Second seam — multi-user CLI bypass — FIXED on this branch:** the CLI `network scan` action (`commands/setup.ts`) called `scanMemories(client, stateManager, batchSize)` **without** passing `cfg`, so the multi-user `getAllUserIds` fan-out inside `scanMemories` was bypassed and the scan ran as the default user only. The CLI now passes `cfg`, and `scanMemories` requires it (single-user installs without a `userId` still scan under the key's default identity), so no caller can silently reintroduce the bypass.

### 3.4 Owner dry-run command sequence (pre-enablement)

The live dry-run is owner-run. The step-by-step procedure (workspace copy, config override, scan → hand-drive extraction → complete, comparison against a hand-maintained archive) is owned by PR #114's [`docs/memory-network-migration.md`](../memory-network-migration.md) — follow its Steps 1–3 rather than a duplicated copy here. The exact sequence, condensed:

```bash
# 1. Read-only preview of the raw material (persists nothing):
openclaw openclaw-hyperspell network scan --batch-size 20

# 2. Full dry-run against a COPY of the workspace:
cp -R ~/.openclaw/workspace /tmp/hs-network-dryrun
cp ~/.openclaw/openclaw.json /tmp/hs-dryrun-config.json
#    edit /tmp/hs-dryrun-config.json:
#      agents.defaults.workspace                        → /tmp/hs-network-dryrun
#      plugins.entries.openclaw-hyperspell.config.knowledgeGraph → { "enabled": true }
export OPENCLAW_CONFIG_PATH=/tmp/hs-dryrun-config.json
openclaw openclaw-hyperspell network scan
#    hand-drive one extraction pass (agent session fed the scan output +
#    <workspace>/HYPERSPELL-MEMORY-NETWORK.md), then:
openclaw openclaw-hyperspell network complete --ids <resource-ids-from-scan>
#    do NOT run `network sync` in the dry-run — it is the one step that
#    writes to Hyperspell rather than local files.

# 3. Baseline retrieval probe BEFORE enabling for real (fixture per §4.1):
node docs/kg-eval.mjs

# 4. Adopt for real (unset the override first):
unset OPENCLAW_CONFIG_PATH
openclaw openclaw-hyperspell setup     # yes at the Memory Network step

# 5. After 2-3 cron cycles, re-probe and diff against the baseline:
node docs/kg-eval.mjs
```

## 4. Test plan

### 4.1 Fixed question set

Pick 8 real questions against the actual corpus, covering the four entity types and both "who" and "state" shapes. Template (substitute real names from the install's history at eval time and freeze them):

1. "Who is `<colleague>`?" (person, identity)
2. "What's `<colleague>`'s email?" (person, structured fact — the sharpest test: emails almost never survive semantic search from fragments)
3. "Who works at `<external org>`?" (org → people)
4. "What is `<project>` and what's its current state?" (project, state)
5. "Who owns / leads `<project>`?" (project → person)
6. "What is `<org>` and how do we know them?" (org, relationship)
7. "What have we said about `<topic>`?" (topic)
8. "Which projects is `<person>` involved in?" (person → projects, multi-hop)

Freeze the exact wording in a fixture file before the baseline run.

### 4.2 Procedure

**Baseline (graph off, current state):** with `debug: true`, ask each question in a fresh session. For each, record: (a) the injected `<hyperspell-context>` block — every result renders as `### <title> (resource_id: …, source: …)` (`hooks/auto-context.ts:62,91`), (b) the debug tally line `auto-context: injecting (ranked) {"curated":n,"chatter":m,…}` (auto-context.ts:210-216), (c) the answer, graded correct / partial / wrong / honest-miss ("said it wasn't there" — which per the plugin's testimony framing is a *good* outcome relative to confabulation).

**Enable + settle:** enable per §3.1, let the first full pass complete, then wait 2–3 cron cycles. Sanity-check between cycles: entity files exist under the four directories, and `memory/.network-state.json` shows `lastScanAt` advancing and `processedIds` growing.

**After:** re-ask the identical 8 questions in fresh sessions. Grade the same way, plus **attribution**: did the winning context come from an entity file? Determine this mechanically — the sync manifest `.hyperspell-sync-hashes.json` at the workspace root maps `memory/people/alice-chen.md` → per-section `resourceId` (`sync/markdown.ts` `SyncManifest`), so cross-reference each injected `resource_id` against the manifest entries whose key starts with `memory/people/`, `memory/projects/`, `memory/organizations/`, or `memory/topics/`. A hit whose resourceId resolves to an entity file counts as "entity-file-served".

**Verification script (implemented on this branch):** following the `docs/hotbuffer-verify.mjs` precedent, `docs/kg-eval.mjs` reads the question fixture (JSON array, default `docs/kg-eval-questions.json` — owner-created with real names, per §4.1), calls the search API directly per question, loads the sync manifest, and prints per-question: top-N titles/resourceIds/scores, which hits resolve to entity files, and the score gap between the best entity-file hit and the best non-entity hit. Running it before and after gives a raw-retrieval comparison independent of the agent's answering behavior (which isolates "search surfaces the entity file" from "the agent uses it well").

**Success criteria:** ≥5/8 questions improve or hold with at least 3 flipping from wrong/partial/honest-miss to correct **and** attributed to an entity file; no question regresses from correct to wrong; and no stale-fact answer (below) is presented as current.

### 4.3 Staleness / drift measurement

Three signals, cheapest first:

1. **Cron liveness:** `openclaw cron list` — job exists, last run recent, no error state. A silently dead cron job is the most likely failure mode; a `lastScanAt` in `.network-state.json` older than ~2× the interval is the alarm condition.
2. **Extraction recency:** every entity file carries `last_extracted` in frontmatter (`graph/ops.ts:209`). `grep -r last_extracted memory/{people,projects,organizations,topics}` and compare against `lastScanAt` — files whose `last_extracted` never advances despite new relevant memories are drifting.
3. **Active drift probe:** introduce a genuinely new fact in a normal conversation ("`<project>` is now led by `<other person>`"), wait one cron cycle plus sync, then (a) check the project's entity file reflects it, and (b) re-ask question 5. **What a stale entity file looks like in practice:** the *old* fact, stated authoritatively — and because entity files get `curationBoost`, the stale curated answer can outrank the fresher chatter row that contradicts it. This inversion (curated-but-stale beating chatter-but-true) is the specific failure to hunt for; if observed, the mitigation is shortening the cron interval and/or surfacing `last_extracted` in the synced content so the agent can see the fact's age.

## 5. Risks / tradeoffs

- **Cron reliability is the load-bearing assumption.** The cron job is created once by setup; nothing in the plugin monitors it. If it dies or is removed (cf. the known `plugins update` runtime-wipe footgun), entity files freeze silently while remaining boosted in ranking — the worst drift shape. Mitigation for the evaluation: check `openclaw cron list` at each measurement point; longer-term, a startup-orientation-style warning when `knowledgeGraph.enabled && lastScanAt` is ancient would be a cheap follow-up.
- **Cost of the isolated agent session.** Every cycle spins a full agent session; each scan pages through `client.listMemories` skipping processed ids and calls `getMemory` per unprocessed row (`graph/ops.ts:103-134`) — O(corpus) listing per scan, plus LLM tokens for extraction. The first pass over a large corpus (thousands of memories) is the expensive one; steady-state cost is proportional to new-memory rate. Hourly is likely overkill after the initial build; consider retuning the cron to 6–12h once the corpus is caught up (remembering §3.1: change the cron job, not `scanIntervalMinutes`).
- **Entity files can become a NEW chatter source — with a boost.** If extraction quality is poor (vague entities, wrong merges, over-extraction from noisy sources), the junk lands as `curated`-classified memories that *outrank* honest chatter. The extraction prompt's "Skip noise / Be selective" guidelines (`graph/cron.ts:348-349`) are the only guard. The evaluation should eyeball every entity file created in the first pass; if >~10% are junk, fix the prompt before continuing the eval rather than measuring retrieval on a polluted graph. Deleting a bad entity file does clean up remotely: the sectionized sync deletes orphaned sections' memories (`sync/markdown.ts:572-594`).
- **Self-scan loop (§3.3)** — fixed on this branch (frontmatter propagation + entity-directory path guard). Residual check in cycle 1: confirm no entity titles appear in a post-extraction `network scan`.
- **Duplicate representation.** Facts now exist twice (fragments + entity file). This is intended — the entity file is a summary view — but it slightly crowds `maxResults`. The chatter quota already bounds fragment flooding; no action unless the eval shows entity + fragment hits jointly displacing other needed context.

## 6. Rollout

The feature is already opt-in (`enabled: false` default, `config.ts:580`), so rollout is inherently safe for the fleet. Sequence:

1. **This install first (the maintainer's own).** Enable per §3.1 on the primary personal install only. Snapshot first: copy `memory/.network-state.json` (if present) and note that all writes are additive files under `memory/` — full rollback is `openclaw cron remove --name "Hyperspell Memory Network"` (`getCronRemoveCommand`, `graph/cron.ts:362`), set `enabled: false`, and delete the four entity directories; the sectionized sync's orphan-deletion then removes the synced memories on the next pass.
2. **Run the §4 evaluation over ~1 week** (first pass + several cycles + the drift probe). The §3.3 fixes are already on this branch; cycle 1 only needs the residual no-entity-titles check.
3. **Decision gate:** only if the success criteria hold *and* steady-state cron cost is acceptable, consider promoting — and even then, the right move is probably not flipping the default (an hourly LLM cron is too costly to impose silently) but making the setup wizard's `enableNetwork` prompt default to `initialValue: true` (`commands/setup.ts:404`) and documenting the evaluation results in the README. Changing `enabled` default for all installs is out of scope for this idea.

## 7. Effort estimate

**S** — the feature and its setup automation already exist end-to-end. The critical-path code (the §3.3 self-scan-loop guards, the multi-user CLI fix, and the `docs/kg-eval.mjs` probe) is implemented on this branch; what remains is owner-run enablement, the eval fixture, and observation.
