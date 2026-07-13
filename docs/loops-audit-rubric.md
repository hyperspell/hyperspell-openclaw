# Loose Threads — unfinished-loops audit rubric and owner workflow

Companion to `docs/proposals/04-startup-orientation-loops-tuning.md` (PR #87)
and the tooling in `scripts/audit-loops.ts` / `lib/loops-audit.ts`. Owner
decision (2026-07-12): **audit first**. PR #107's dynamic-query design
(`docs/plans/issue-73-static-loops-query.md`) is the *candidate remedy* this
audit exists to evaluate — it is simulated by the tool (`--simulate dynamic`)
but deliberately not implemented. Production behavior (`gatherOrientation`,
the handler, the static default `loopsQuery`) is untouched by this branch.

## What one audit run produces

`scripts/audit-loops.ts` runs the real injection path — `gatherOrientation`
with the live install's parsed config — so the as-injected block is
byte-identical to a session start, then repeats the hook's exact underlying
`client.search(so.loopsQuery, { limit: so.loopsLimit, userId })` call for
per-result diagnostics. Each `-o json` invocation emits one deterministic
JSONL line per variant: timestamp, variant name, query used, `after` window
(simulations only), and per result its `resourceId`, title, score,
`createdAt`, highlight count, and whether `formatUnfinishedLoops` would have
rendered it or silently dropped it (a **wasted slot**).

Variants (`--simulate a1,a2,dynamic,after30,after60`), all read-only:

| Variant | What it probes | Source |
|---|---|---|
| `baseline` | today's static default query, unwindowed | production config |
| `a1`, `a2` | reworded static queries (first-person / hybrid) | proposal 04 §3.3 Candidate A |
| `after30`, `after60` | baseline query + recency window | proposal 04 §3.3 Candidate B |
| `dynamic` | static base + recent conversation titles | PR #107's `buildLoopsQuery` shape, simulated |

## Privacy (read before saving anything)

- Memory content (highlight snippets and the as-injected block) appears in
  output **only** when `HYPERSPELL_AUDIT_CONTENT=1` is set — setting the env
  var is the opt-in, same contract as `HYPERSPELL_SCORE_LOG` in
  `hooks/auto-context.ts`.
- Titles are always included (labeling needs them), so any saved ledger is
  personal content either way. Keep it in `docs/loops-audit/` (gitignored),
  never commit it, and **delete the directory when the window closes**.

## Labeling

For each **rendered** bullet, open the underlying resource (`hyperspell` CLI
or a memories get by the printed `resourceId`) and, if needed, search the
corpus for later mentions of the same thread. Append one line per judgment to
`docs/loops-audit/labels.jsonl`:

```jsonl
{"ts":"<run ts from the ledger line>","variant":"baseline","resourceId":"...","verdict":"still-open","evidence":"no follow-up found; owner=David, deliverable=API key"}
{"ts":"...","variant":"a1","resourceId":"...","verdict":"resolved","evidence":"closed by <resourceId of the later memory>"}
{"ts":"...","variant":"a1","resourceId":"...","verdict":"not-a-loop","snippetInsufficient":true}
```

| Verdict | Definition | Practical test |
|---|---|---|
| **still-open** | A concrete commitment, question, or in-progress task with no evidence of later resolution | You can name (a) who owes what, and (b) you searched for a follow-up and found none, or found one that explicitly defers ("still blocked on…") |
| **resolved** | Was a real loop, but a later session/message closes it | A later memory answers the question, ships the task, or explicitly cancels it ("decided not to", "done", a PR merged) |
| **not-a-loop** | Matches the query semantically but contains no pending obligation | The snippet is *descriptive*, not *deontic*: talking **about** tasks/questions, meta-discussion of this very feature, injected-context echoes, or generic planning chatter with no owner or deliverable |

Edge rules, fixed up front so the ledger stays consistent:

- Still technically open but **superseded** (project pivoted; the promise no
  longer matters) counts as **resolved** — surfacing it wouldn't help.
- Snippet too truncated to judge → judge the underlying resource, and set
  `"snippetInsufficient": true`; a high rate of that is itself a finding (the
  highlight, not the retrieval, is the problem).
- Results dropped for having no highlights are counted automatically as
  **wasted slots** — don't label them.
- Judge blind where practical: label a day's bullets before looking at which
  variant produced them.

## Metrics (computed by `--summary`)

Per variant: **hit rate** = still-open / labeled rendered bullets; verdict
breakdown; wasted-slot count; **age distribution** of labeled items by verdict
(run ts − `createdAt`); **repeat rate** = fraction of distinct surfaced
resourceIds appearing in more than half the runs (the "stuck set" signature
from issue #73); and for each candidate, **paired-day wins** vs baseline
(days where both were labeled and the candidate's hit rate was higher).

## Decision rule

1. **Baseline hit rate ≥ ~70%** over the window (aim for ≥ 10 labeled
   baseline bullets): the static query is not causing harm. Record the number
   in issue #66, close idea #4, change nothing.
2. **Below ~70%**, the dominant signal picks the remedy tier — a candidate
   graduates only by beating baseline hit rate on **≥ 2 of 3 paired labeled
   days** (proposal 04 §4.2):
   - **Tier 1 — tune the static string** (Candidate A): `not-a-loop`
     dominates the failures and repeat rate is low. Graduate `a1`/`a2` per
     proposal 04 §4.3's test plan.
   - **Tier 2 — window and/or #107's dynamic query**: `resolved` dominates
     with resolved items clustering old while still-open items cluster recent
     (→ Candidate B; `after30`/`after60` decide the width), **or** baseline
     repeat rate is high — the same resources surfacing run after run
     regardless of corpus growth is exactly the stuck-set failure #107
     targets, and the `dynamic` simulation must itself pass the paired-day
     gate before #107 is implemented.
   - **Tier 3 — explicit open-loop tagging** (#107's Option 2): no simulated
     variant passes the gate, or labels show open and closed threads are
     lexically inseparable (same phrasing, only later context distinguishes
     them). That's a new design with lifecycle semantics — file a follow-up
     issue; don't force Tier 1/2 changes that the data doesn't support.
3. Wasted slots crowding the block (many no-highlight results) is orthogonal:
   handle via `loopsLimit` / score-floor follow-up (Candidate C) at any tier.

## Owner workflow — two-week audit window

The live layer is owner-run, never CI (`npm test` covers only the pure
helpers in `lib/loops-audit.test.ts`).

```sh
# day 0 — sanity check (human view, prints nothing to disk)
node --experimental-strip-types scripts/audit-loops.ts

# days 1–14 — one capture per day, all variants, appended to the ledger
mkdir -p docs/loops-audit
HYPERSPELL_AUDIT_CONTENT=1 node --experimental-strip-types scripts/audit-loops.ts \
  --simulate a1,a2,dynamic,after30,after60 -o json >> docs/loops-audit/ledger.jsonl

# label rendered bullets as you go (resumable; schema above)
$EDITOR docs/loops-audit/labels.jsonl

# end of window — metrics + decision-rule inputs (offline, no network)
node --experimental-strip-types scripts/audit-loops.ts \
  --summary docs/loops-audit/ledger.jsonl docs/loops-audit/labels.jsonl

# record the numbers in issue #66, then delete the window's artifacts
# (they contain conversation titles and, with the env var set, content)
rm -rf docs/loops-audit
```

Daily cadence approximates distinct session starts while letting the corpus
evolve between captures; back-to-back runs against a static corpus would be
pseudo-replicates. If a ledger line shows `"blockConsistent": false`, the
corpus moved between the two baseline calls — rerun that day rather than
labeling it.
