# Proposal 04 — Evaluate and tune startup-orientation's unfinished-loops

Idea #4 from the retrieval-relevance brainstorm (issue #66). This is an implementation guide, not an implementation: no functional code changes ship with this PR.

> **Status (2026-07-12): Phase 0 tooling shipped on this branch, reconciled to post-0.19.0 main.** Owner decision: audit-first wins over implement-now; PR #107's dynamic-query design (`docs/plans/issue-73-static-loops-query.md`) is the candidate remedy this audit evaluates (simulated via `--simulate dynamic`), not implemented. Two reconciliations against `main`: (1) #111 extracted `gatherOrientation` from the handler, so the audit script is `scripts/audit-loops.ts` (TypeScript, not the `docs/loops-audit.mjs` sketched in §3.1) — it imports and calls the real `gatherOrientation` plus the hook's exact underlying `client.search` call instead of paraphrasing them, following The Ruler's `scripts/eval-retrieval.ts` + `lib/eval-matchers.ts` split (pure helpers in `lib/loops-audit.ts` run in `npm test`; the live layer never does). (2) Content in output is env-gated (`HYPERSPELL_AUDIT_CONTENT=1`, delete-after-window) per Cutting Room's `HYPERSPELL_SCORE_LOG` precedent. The §3.2 rubric, §4.1 decision gate, and remedy tiers are committed as `docs/loops-audit-rubric.md`. Production behavior is unchanged.

## 1. Summary

The `<hyperspell-unfinished-loops>` block injected at session start is a plain relevance search for a fixed keyword-soup query, with no recency bound, no score threshold, and no feedback loop — so we have no idea whether it surfaces genuinely open threads or stale/resolved items that merely match "open tasks pending questions" semantically. This proposal adds an audit-before-tuning workflow: a standalone read-only script (`docs/loops-audit.mjs`, following the existing `docs/*.mjs` probe pattern) that runs the exact same search the hook runs and prints exactly what would be injected; a three-way judging rubric (still-open / resolved / not-really-a-loop) applied over ~10 captures; and, only if the measured hit rate warrants it, three concrete candidate changes — reworded `loopsQuery` defaults, a recency window on the loops search, and `loopsLimit` adjustment — each with a defined rollout and test plan.

## 2. Problem

The loops block is produced in `hooks/startup-orientation.ts` by `buildStartupOrientationHandler`:

- **The fetch** (`hooks/startup-orientation.ts:271-274`) is a single call: `client.search(so.loopsQuery, { limit: so.loopsLimit, userId })`. That's it — pure lexical/semantic relevance against the whole corpus.
- **The default query** (`config.ts:557-559`) is `"open tasks pending questions unfinished promised need to follow up"` — a bag of loop-flavored keywords. Defaults: `loopsLimit: 3`, and `enabled: false` (opt-in) (`config.ts:552-560`).
- **The formatting** (`formatUnfinishedLoops`, `hooks/startup-orientation.ts:64-73`) silently drops any result with no highlights, then renders `- {title}: {first highlight, newlines flattened}`. So a `loopsLimit: 3` search can inject 0-3 bullets, and dropped results waste slots invisibly.
- **The framing** (`hooks/startup-orientation.ts:328-337`) already hedges: "Low-confidence retrieval; treat as prompts to consider, not facts to act on." That's the right instinct, but it's a caveat papering over unknown precision.

Three structural reasons to suspect the block is noisy:

1. **No recency bound.** Unlike the recent-interactions path (windowed by `recentDays` via `isoDaysAgo`, `hooks/startup-orientation.ts:75-79, 263`), the loops search passes no `after` — even though `client.search()` supports it (`client.ts:95-104`, options `after`/`before`). A loop resolved three months ago matches the query exactly as well as one opened yesterday. Note that `recentDays` does **not** currently affect the loops block at all — a common misreading of the config.
2. **No score threshold.** `client.search()` returns per-result `score`, and the plugin has a `relevanceThreshold` config, but the loops path applies neither. With a corpus that contains any task-ish chatter, the top-3 for a keyword-soup query will always be *something*.
3. **The query describes loops in the third person; transcripts speak in the first person.** Real open threads in stored conversations look like "I'll get back to you on X", "still waiting on the API key", "let's pick this up tomorrow" — not the abstract nouns in the default query.

But all three are hypotheses. Per the idea's framing: **look at the actual block content over several real session starts before changing anything.**

## 3. Proposed design

### 3.1 Capture: a standalone audit script, not live-hook instrumentation

Two options were considered:

- **(rejected as primary) Temporary debug logging in the hook.** `log.debug` at `hooks/startup-orientation.ts:340-342` already logs *counts*; logging the full `loopsBody` would require editing the live plugin, redeploying to a running agent, and later remembering to revert. Higher risk, slower iteration, and it only captures on real session starts (a few per day).
- **(chosen) `docs/loops-audit.mjs`** — a read-only standalone script mirroring the exact search the hook performs, in the established `docs/hotbuffer-verify.mjs` / `docs/filter-dialect-test.mjs` / `docs/issue42-resourceid-probe.mjs` pattern: read the plugin config from `~/.openclaw/openclaw.json` (`plugins.entries["openclaw-hyperspell"].config`), hit the live Hyperspell API with the same auth (including `X-As-User` when `userId` is set, matching `client.requestOptions`).

The script must reproduce the hook's behavior faithfully, in this order:

1. Resolve `query = cfg.startupOrientation?.loopsQuery ?? <the config.ts default string>` and `limit = cfg.startupOrientation?.loopsLimit ?? 3`, honoring the same `sources` default the client applies (`client.ts:107-110`).
2. Call `memories.search` with `{ query, sources, options: { max_results: limit } }` — the same shape `HyperspellClient.search()` builds (`client.ts:121-133`).
3. Apply `formatUnfinishedLoops` semantics: skip results with empty `highlights`, render `- {title || "[" + source + "]"}: {first highlight text, newlines → spaces}`. Print this "as-injected" view **and** a diagnostic view per result: `resourceId`, `score`, `createdAt`, whether it was dropped for having no highlights.
4. Support overrides for A/B work: `--query "..."`, `--limit N`, `--after 2026-06-01` (the last one exercises the candidate windowing change before any code exists). Emit JSON with `-o json` so runs can be appended to a ledger.

The script is read-only (search only, no writes, no deletes) — safe against the live agent per the alinea-is-personal ground rules.

**Fidelity caveat to document in the script header:** the script cannot see `injectedSessions` gating, multi-speaker skips, or multi-user `userId` resolution (`personalUserId`, `hooks/startup-orientation.ts:87-95`). For a single-user install (the primary deployment) the search it runs is byte-identical to the hook's. If we ever need to confirm end-to-end injection (tags intact, sanitizer stripping, once-per-session), do **one** supervised live session start with `debug: true` and a temporary `log.debug("loops body:", loopsBody)` — but that's a spot-check, not the audit loop.

### 3.2 Judging rubric

For each rendered bullet, open the underlying resource (the script prints `resourceId`; `hyperspell` CLI or a `listMemories`/get call shows the full text) and, if needed, search the corpus for later mentions of the same thread. Classify:

| Verdict | Definition | Practical test |
|---|---|---|
| **still-open** | A concrete commitment, question, or in-progress task with no evidence of later resolution | You can name (a) who owes what, and (b) you searched for a follow-up and found none, or found one that explicitly defers ("still blocked on…") |
| **resolved** | Was a real loop, but a later session/message closes it | A later memory answers the question, ships the task, or explicitly cancels it ("decided not to", "done", a PR merged) |
| **not-really-a-loop** | Matches the query semantically but contains no pending obligation | The snippet is *descriptive*, not *deontic*: talking **about** tasks/questions ("we reviewed the open tasks list"), meta-discussion of this very feature, injected-context echoes, or generic planning chatter with no owner or deliverable |

Edge rules, decided up front so the ledger stays consistent:

- A loop that is still technically open but **superseded** (the project pivoted; the promise no longer matters) counts as **resolved** — surfacing it wouldn't help.
- If the snippet is too truncated to judge, judge the underlying resource, not the snippet — but also tick a `snippet-insufficient` flag; a high rate of that is itself a finding (the highlight, not the retrieval, is the problem).
- Results dropped by the no-highlights filter count as **wasted slots** in a separate tally (they consumed one of `loopsLimit` results but injected nothing).

Metrics per capture batch: `hit rate = still-open / rendered bullets`, plus the resolved / not-a-loop / wasted-slot breakdown, plus age distribution of still-open vs. resolved items (this directly informs the windowing candidate).

### 3.3 Candidate changes (only after the baseline audit)

**Candidate A — reword the default `loopsQuery` to first-person commitment language.** Two variants to A/B via `--query`:

- A1 (first-person phrasal): `"I'll get back to you, still need to, waiting on, didn't finish, let's pick this up later, promised to follow up"`
- A2 (hybrid — keeps the abstract nouns, adds commitment verbs): `"unresolved follow-up: promised, waiting on an answer, blocked, next step, revisit, unfinished task, open question"`

Rationale: embeddings of the query should live near how loops are actually *phrased in transcripts*. Cheap to test — zero code change, just `--query` runs judged with the same rubric on the same day as a baseline run.

**Candidate B — bound the loops search by recency.** Pass `after: isoDaysAgo(so.loopsDays)` in the `client.search` call at `hooks/startup-orientation.ts:271-274` (the client already plumbs `after` through, `client.ts:125-127`). Deliberately a **new key `loopsDays`** rather than reusing `recentDays`: 7 days is right for "what did we just talk about" but likely too tight for loops (a promise from 3 weeks ago is exactly what this block exists to resurrect). Suggested default to test: 30. Tradeoff, explicitly: a window drops **older-but-still-open** loops (the long-tail promises that are the block's whole point) in exchange for excluding the resolved/stale bulk. The audit's age distribution decides this: if resolved items cluster old and still-open items cluster recent, windowing wins; if still-open items have a long age tail, prefer Candidate A alone or a wide window (60-90d).

**Candidate C — tune `loopsLimit` (and consider a score floor).** Direction depends on measured precision: if hit rate is high (≥ ~70%) and loops are being crowded out, raise `loopsLimit` 3 → 5; if the block is mostly noise, drop to 2 — three bad bullets at every session start actively trains the agent to ignore the block (and its hedging preamble already invites that). If the diagnostic view shows a clean score cliff between good and bad results, a follow-up (out of scope here) is applying the existing `relevanceThreshold` to the loops path.

All three are independent; the expected end state is A (possibly) + B (probably) with C as a knob, but **the audit data decides** — that is the point of this idea.

## 4. Test plan

### 4.1 Baseline audit (no code changes)

1. Land `docs/loops-audit.mjs` (can ride along in this proposal's follow-up PR; it's a docs script, not shipped plugin code).
2. Run it once per day for ~10 days against the live install (alinea's corpus is the realistic testbed; the script is read-only so no confirmation ceremony is needed). Daily cadence approximates distinct session starts while letting the corpus evolve between captures; the search is otherwise deterministic for a static corpus, so back-to-back runs would be pseudo-replicates.
3. Append each run's JSON to a ledger (`docs/loops-audit-ledger.md` or a scratch CSV): date, resourceId, title, snippet, score, verdict, evidence pointer (the later memory that resolves it, if any).
4. Compute: hit rate, verdict breakdown, wasted-slot count, age distribution by verdict.
5. Decision gate: hit rate ≥ ~70% → close the idea, no change (document the number in #66). Below that, proceed to 4.2 targeting whichever failure mode dominates (not-a-loop → Candidate A; resolved → Candidate B; wasted slots / crowding → Candidate C).

### 4.2 A/B of candidates (still no plugin changes)

Same-day paired runs: baseline query vs. A1 vs. A2 (`--query`), and baseline vs. `--after` at 30/60 days. Judge every variant with the same rubric, blind if practical (strip which query produced which result set before judging). A variant must beat baseline hit rate on ≥ 2 of 3 paired days to graduate to a code change.

### 4.3 Unit tests for any graduated code change (`hooks/startup-orientation.test.ts`)

The existing suite (mock `makeClient`/`makeCfg`, `node --test --experimental-strip-types hooks/startup-orientation.test.ts`) sets an explicit fixture query `"open tasks pending questions"` (`hooks/startup-orientation.test.ts:71-72`), so a **default** reword does not break existing hook tests. New/updated cases:

- **Default reword (Candidate A):** `config.test.ts` today only asserts the default is non-empty (`config.test.ts:210`) — tighten it to assert the exact new default string so future rewords are deliberate; the existing pass-through case (`loopsQuery: "custom loops"` in, same string out, `config.test.ts:221-228`) already covers customized installs and must keep passing.
- **Windowing (Candidate B):** new hook test asserting `client.search` is called with `after` derived from `loopsDays` (mock client records call args — the suite already does this for `source: "trace"` and `userId` at `hooks/startup-orientation.test.ts:227, 426`); a test that `loopsDays` unset ⇒ no `after` passed (backward-compat default, see Rollout); a `config.test.ts` case for the new key's default and bounds; and an `openclaw.plugin.json` `configSchema` entry alongside the existing `loopsQuery`/`loopsLimit` entries (`openclaw.plugin.json:157-160`).
- **Limit change (Candidate C):** config default assertion only; the hook already respects `loopsLimit` via the search `limit`.

## 5. Risks / tradeoffs

- **Judging is subjective and the corpus is one person's.** Mitigate with the written edge rules (3.2) and by recording evidence pointers so verdicts are re-checkable. Accept that this tunes for the primary deployment first; the rollout section keeps other installs unaffected until they opt in or upgrade.
- **Overfitting the query to one corpus/week.** The reword candidates are generic commitment language, not corpus-specific terms; the 10-day window and the ≥2-of-3 A/B gate guard against a lucky day.
- **Windowing loses the long-tail loop** — the single most valuable thing this block could surface. That's why `loopsDays` starts generous (30+), ships opt-in (unset = today's unbounded behavior), and is only defaulted after the age-distribution data supports it.
- **Fidelity gap between script and hook** (multi-user resolution, multi-speaker skip). Documented in the script; acceptable because the tuning targets *what the search returns*, which is identical, and the one supervised debug-log session covers end-to-end doubts.
- **Behavior shift for defaults-users on upgrade** if the default query changes — see Rollout.
- **Cost/perf: none.** Same single search call at session start; the audit script is read-only and out-of-band.

## 6. Rollout

1. **Phase 0 (this PR + follow-up):** guide merged; `docs/loops-audit.mjs` lands as a docs script; baseline audit runs. No plugin behavior changes, no version bump needed beyond the docs.
2. **Phase 1 (`loopsDays`, if graduated):** ships as a new **optional** config key, default `undefined` = no window = exactly today's behavior. Pure opt-in; zero impact on any existing install. `configSchema`/`uiHints` updated. Minor version bump.
3. **Phase 2 (default `loopsQuery` reword, if graduated):** changing the fallback string at `config.ts:557-559` only affects installs that never set `loopsQuery` — `parseConfig` prefers the user's value unconditionally, so **customized installs are fully backward compatible with no action**. For defaults-users it's a silent behavior change: ship in a minor release with a changelog entry that states the old string verbatim so anyone can pin the previous behavior by setting `loopsQuery` explicitly. Do not add a legacy toggle; the config override *is* the escape hatch.
4. **Phase 3 (optional):** revisit defaulting `loopsDays` to 30 after a post-change audit round with the same script — the tooling from Phase 0 is reusable for regression checks, which is half its value.

## 7. Effort estimate

**S** — the deliverables are a ~100-line read-only probe script in an established pattern plus a manual review protocol; the largest graduated code change (Candidate B) is ~5 lines of hook/config/schema plus 3-4 mock-client tests in an existing suite. (The calendar time for the 10-day audit is elapsed, not effort.)
