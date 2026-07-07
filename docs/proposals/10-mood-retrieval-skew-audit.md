# Idea #10 — Audit whether emotional-state's mood skew bleeds into retrieval

Status: proposal / implementation guide (idea #10 from #66). **Audit-only** — this doc designs an investigation, not a fix. Do not build any mitigation off the back of this doc alone.

## Summary

Emotional-state has a flagged (never investigated) risk of over-indexing on grief- and memory-review-heavy sessions. If those same sessions also produce disproportionately more stored resources — or resources that score higher in semantic search — then the skew would not stay confined to the mood report: it would tilt what regular retrieval surfaces later, quietly making heavy periods over-represented in recalled context. This guide designs a standalone, read-only audit script (following the `docs/*.mjs` precedent) that (a) builds a mood timeline from the stored emotional-state snapshots, (b) censuses the live corpus by `openclaw_source` and week, (c) probes retrieval with a fixed panel of neutral queries and measures which weeks' resources dominate the results — all normalized against raw conversation volume so "we just talked more that week" doesn't masquerade as skew. Only if the audit produces a clear signal does a mitigation idea get filed.

## Problem

This is a **hypothesis to test, not a confirmed bug.** The concern chains three observations about the write paths:

1. **Mood snapshots are written per real conversation, debounced.** `buildEmotionalStateStoreHandler` (`hooks/emotional-state.ts:267`) fires on `agent_end`, skips cron/heartbeat/memory triggers (`NON_CONVERSATIONAL_TRIGGERS`, line 26), and debounces to at most one snapshot per `STORE_DEBOUNCE_MS = 3 * 60 * 1000` (line 33), keyed by `cfg.relationshipId ?? ""` (line 314). It writes via `client.storeEmotionalState(transcript, { relationshipId, metadata: { source: "openclaw_agent_end" } })` (lines 324–327), which POSTs to `/emotional-state` (`client.ts:569`) and gets back a `resource_id` — i.e. snapshots are themselves stored resources.
2. **Every conversation also feeds the general corpus.** Hot-buffer writes raw per-message text on `agent_end`, tagged `{ openclaw_source: "hot_buffer", openclaw_session_id, openclaw_channel_id? }` (`hooks/hot-buffer.ts:282–292`). Auto-trace writes distilled transcripts via `client.sendTrace` (`hooks/auto-trace.ts:200`), which calls `sessions.add` with `metadata: { openclaw_source: "agent_end", ... }` (`client.ts:458–465`).
3. **The flagged watch item.** Memory-review-heavy and grief-heavy sessions may be structurally different: longer, more repetitive of past material, more emotionally saturated text. If they produce more resources per unit of conversation (e.g. longer transcripts → more hot-buffer rows, more sessions crossing auto-trace thresholds), or resources whose text embeds "hotter" for typical queries (emotionally dense prose tends to be semantically rich), then later searches — via `HyperspellClient.search()` (`client.ts:95`) and the ranking in `lib/ranking.ts` (`baseScore:58`, `classifyResult:75`, `scoreResult:91`) — would surface heavy-period material more than its real-life share warrants.

None of that is established. The whole point of this idea is to check whether heavy periods are actually over-represented in stored volume and retrieval prominence **before** anyone designs a fix.

Relevant query-surface facts for the design below:

- `client.ts:95 search()` supports a `filter` (metadata, line 129) and `after`/`before` date bounds (lines 127–128), and returns `score` plus `createdAt` (read from `doc.metadata.created_at`, line 145; can be null).
- `client.ts:341 listMemories()` paginates the whole corpus and returns each item's full `metadata` — but supports **no** metadata filter or date range server-side. Bucketing must happen client-side.
- Filter dialect: `$ne` on `openclaw_source` is verified live (`docs/filter-dialect-test.mjs`, note at `hooks/hot-buffer.ts:273–277`); `$exists` support is unverified (`docs/hotbuffer-verify.mjs` `filterProbe`). The audit script should not depend on anything beyond `$ne`/equality.

## Proposed design

One new standalone script, `docs/mood-skew-audit.mjs`, in the same shape as `docs/hotbuffer-verify.mjs` / `docs/issue42-resourceid-probe.mjs`: plain Node, reads credentials from `~/.openclaw/openclaw.json` → `.plugins.entries["openclaw-hyperspell"].config` (`apiKey`, `userId` → `X-As-User`), imports the `hyperspell` SDK, prints a human-readable report. **Strictly read-only** — unlike the verify scripts it writes no canaries and deletes nothing.

Three phases, each runnable independently via a flag (`--mood`, `--census`, `--probe`; default runs all and prints the combined verdict table):

### Phase 1 — mood timeline (`--mood`)

Goal: label each ISO week in the audit window as **mood-heavy**, **mood-light**, or **mixed/unknown**, independently of the corpus census.

1. Fetch emotional-state snapshots. Preferred path: `GET /emotional-state/recent?limit=200` (the plugin's `getRecentEmotionalStates`, `client.ts:653`, caps at what the backend allows — probe how deep it actually goes; it may 404 on older deployments, in which case only `GET /emotional-state` (latest) exists and Phase 1 falls back to step 2).
2. Fallback / cross-check: enumerate the corpus (Phase 2's `memories.list` pass) and look for resources whose metadata carries `source: "openclaw_agent_end"` — the marker `storeEmotionalState` stamps (`hooks/emotional-state.ts:326`). Whether snapshot resources are enumerable through `memories.list` at all is an open question the script should answer empirically and report (print "snapshot resources visible via memories.list: yes/no").
3. For each snapshot, bucket by ISO week of `extracted_at` and classify the `summary` text as heavy vs light. Two-tier classification:
   - **Automatic first pass:** a small keyword lexicon over the summary (heavy: grief, loss, mourning, ache, heaviness, sadness, tired, strained, fragile, tender-in-a-wounded-sense; light: warm, playful, easy, curious, energized, light, steady). Score = (heavy hits − light hits) per summary.
   - **Manual confirmation:** print every summary with its auto-label and week, and require the operator to eyeball them before trusting the labels. The corpus is small (debounce means at most a handful of snapshots per active day; expect well under ~100 total), so manual review is cheap and avoids over-engineering a classifier.
4. Week label: heavy if a majority of that week's snapshots are heavy, light if a majority light, else mixed. Weeks with zero snapshots are **unknown** and excluded from comparisons.

Output: a table `week | snapshots | heavy | light | label`.

### Phase 2 — corpus census by source × week (`--census`)

Goal: raw stored volume per bucket.

1. Iterate `client.memories.list` (the SDK's paginator, as `listMemories()` wraps at `client.ts:364`) across the whole corpus with `X-As-User` set from config. ~2k resources at page size 100 is ~20 requests — fine.
2. For each resource, read `metadata.openclaw_source` and bucket into: `hot_buffer`, `agent_end` (auto-trace), `command` (explicit `/remember`-style writes, `client.ts:291`), emotional-state (if visible per Phase 1 step 2), and `untagged/other`.
3. Bucket by ISO week using `metadata.created_at`. If `created_at` is absent from the list payload, note it; do **not** fall back to per-resource `memories.get` for the whole corpus by default (2k serial GETs) — instead sample (e.g. 50 resources) to establish whether the field exists, and report coverage ("createdAt available for N% of resources"). If coverage is poor, the census can still bucket hot-buffer rows by parsing the week from `openclaw_session_id` where the session id embeds a date, and otherwise mark the week unknown.
4. Also record total characters where the list payload exposes anything size-like (optional; skip if not present).

Output: a matrix `week × source → count`, plus per-week totals.

### Phase 3 — retrieval probe (`--probe`)

Goal: measure retrieval **prominence**, not just stored volume — volume could be flat while heavy material still outscores.

1. Fixed panel of ~12 neutral probe queries, hardcoded in the script. Deliberately mundane and NOT emotion-themed (e.g. "what did we decide about the plugin config", "plans for the weekend", "cooking dinner", "book recommendation", "how the project is going", "morning routine", "travel plans", "something funny that happened", "what David is working on", "health and sleep", "music we talked about", "errands and chores"). The panel must be committed with the script so reruns are comparable.
2. For each query, call `client.memories.search` with a generous `max_results` (e.g. 25) and **no** date bounds — we want the ranker's natural preference. Record for every returned document: `resource_id`, `score`, `openclaw_source` (from metadata if echoed; otherwise join against the Phase-2 census by `resource_id`), and week (from `created_at` / census join).
3. Aggregate across the panel: for each week, compute (a) **result share** = fraction of all returned result slots occupied by that week's resources, and (b) **mean score** of that week's returned resources. Then compare each week's result share against its **corpus share** from Phase 2 — the ratio `resultShare / corpusShare` is the week's retrieval lift.

### Combined verdict output

The script ends with one table joining all three phases:

```
week        label   msgs(hot_buffer)  traces  traces/100msgs  corpusShare  resultShare  lift   meanScore
2026-05-25  light   412               9       2.2             6.1%         4.8%         0.79   0.41
2026-06-08  heavy   540               21      3.9             8.9%         19.7%        2.21   0.57
...
```

plus the two headline comparisons (heavy-vs-light aggregate): normalized production rate (`traces per 100 hot-buffer messages`) and mean retrieval lift.

## Test plan

The audit procedure **is** the test plan.

1. Run against the live corpus (Alinea's app; `X-As-User` from her live config — coordinate with David before running, read-only though it is):
   ```
   node docs/mood-skew-audit.mjs            # all three phases + verdict
   node docs/mood-skew-audit.mjs --mood     # just the mood timeline (review labels first)
   ```
2. Manually confirm the Phase-1 labels before reading the verdict. If fewer than 3 heavy-labeled weeks AND 3 light-labeled weeks exist, stop: **insufficient data**, rerun in a month — do not squint at two weeks and call it a signal.
3. Read the verdict against these pre-registered thresholds (decide them now, before seeing data, so the outcome can't be argued into existence):
   - **Confirmed skew** requires BOTH of:
     - *Volume, normalized:* mean resources-per-100-hot-buffer-messages (auto-trace + emotional-state resources) in heavy weeks ≥ **1.5×** light weeks, consistent in direction across heavy weeks (not driven by a single outlier week — drop the max heavy week and the ratio must still be ≥ 1.3×), **or** *Retrieval lift:* mean lift for heavy weeks ≥ **1.5×** while light weeks sit ≤ 1.0×, again surviving removal of the single strongest week.
     - The effect visible in the neutral probe panel specifically — i.e. heavy-week material intruding into queries that are not about emotion. Heavy weeks winning emotion-adjacent queries would be *correct* retrieval, not skew.
   - **No real skew:** normalized volume ratios and lifts within roughly ±20% between heavy and light weeks, or any apparent gap fully explained by hot-buffer message counts (raw conversation volume).
   - **Ambiguous:** anything between — record the numbers in the issue, rerun after 4–6 more weeks of data accumulate.
4. Paste the full script output into issue #66 (or a dedicated follow-up issue) regardless of outcome, so the next person doesn't rerun from scratch.

## Risks / tradeoffs

- **The volume confound (the big one).** A hard period plausibly means *more conversation overall* — more messages, more sessions — which mechanically means more hot-buffer rows and more auto-trace resources without any skew existing. That's why the headline volume metric is **resources per 100 hot-buffer messages**, not raw counts: hot-buffer writes one row per message (`hooks/hot-buffer.ts`), so its per-week count is a serviceable proxy for conversation volume, and normalizing by it isolates "heavy sessions produce more *derived* resources per unit of talk" from "we just talked more." Same for retrieval: lift is result share **divided by corpus share**, so a week that is 20% of the corpus and 20% of results has lift 1.0 — no skew, however hard the week was.
- **Circularity in mood labeling.** The mood labels come from emotional-state summaries — the very pipeline suspected of over-indexing. If the extractor exaggerates heaviness, weeks get labeled heavy that weren't. Mitigations: manual review of every summary (Phase 1 step 3), and a cheap external cross-check — ask David which weeks in the window actually were heavy and note agreement/disagreement in the writeup. Disagreement is itself a finding (it feeds the original watch item).
- **`created_at` coverage.** `search()` reads it from `doc.metadata.created_at` (`client.ts:145`) and it can be null; the list payload's coverage is unknown. The script must report coverage explicitly, and if a large fraction of resources can't be dated, the weekly bucketing is unreliable — say so in the output rather than silently dropping undated rows into whichever bucket.
- **Emotional-state snapshots may not be enumerable.** They live behind `/emotional-state`, and whether they also appear in `memories.list`/search is unverified. The script probes and reports this. If they're invisible to search, the *snapshot resources themselves* can't bleed into retrieval — which would narrow the hypothesis to hot-buffer/auto-trace text from heavy sessions (still worth the probe phase).
- **Probe-panel bias.** Twelve hand-picked queries are a small, opinionated sample. Keeping them mundane, fixed, and committed with the script limits cherry-picking, but a null result on this panel is "no skew *found*", not "no skew possible."
- **Debounce coarsens the mood signal.** One snapshot per ≥3 minutes, keyed per relationship, means a week's label rests on few data points; the `MIN_MESSAGES`/`MIN_CONVERSATION_LENGTH` gates (`hooks/emotional-state.ts:15–16`) additionally drop short exchanges, which are disproportionately light. Weekly (not daily) buckets and the ≥3-weeks-per-class rule are the countermeasures.
- **Live-corpus etiquette.** Read-only, but it enumerates the whole corpus and runs a dozen searches against Alinea's live app — cheap, yet the operator should still confirm with David before running (per the alinea-is-personal norm) and avoid running it concurrently with heavy consolidation windows.

## Rollout

N/A — the audit ships as a docs script only; no plugin code changes, no config changes, nothing to enable or roll back.

What happens next depends on the outcome:

- **Confirmed skew** → open a new issue (linked to #66) carrying the full audit output, and only *then* design a mitigation as its own idea. The natural plug-in point is `lib/ranking.ts` (`scoreResult:91` — e.g. per-source or per-time-period normalization), but choosing a mechanism is explicitly out of scope here.
- **No real skew** → comment on #66 with the output, mark idea #10 resolved-no-action, and downgrade the emotional-state watch item to "mood reporting only" (retrieval exonerated).
- **Ambiguous / insufficient data** → post the numbers, set a calendar note to rerun the same script (same panel, same thresholds) after 4–6 more weeks of corpus accumulate.

## Effort estimate

**S** — one standalone read-only `.mjs` script following an established repo pattern plus an afternoon of running it and hand-reviewing mood labels; no plugin source is touched.
