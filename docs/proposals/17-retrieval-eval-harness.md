# Proposal 17: A small persistent retrieval eval harness

> Implementation guide for idea #17 from issue [#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66).
> This is the **meta-idea**: the reusable test infrastructure that the other retrieval-relevance
> ideas (#1, #2, #7, #9, #12, #13, and most of the rest) lean on in their own test plans.
> Implemented in this PR: the hermetic eval core (`eval/`, in `npm test`), the
> shared matcher module (`lib/eval-matchers.ts`), and the live runner
> (`scripts/eval-retrieval.ts` + `docs/eval/retrieval-fixtures.jsonl`).

## 1. Summary

Keep a small, growing fixture file of real `(query → expected memory)` pairs, plus a
manually-run script that pushes each query through the plugin's **actual** retrieval
pipeline — `HyperspellClient.search` + `rerank` + `selectRanked`, with the live install's
real config — and checks whether the expected memory made the selected set. The output is
a per-fixture pass/fail list and a single score ("9/12 passed"), persisted per run so any
ranking change can be checked with a diff instead of an evening of eyeballing debug logs.
It hits the live Hyperspell API with real credentials, so it is explicitly **not** part of
`npm test` or CI — it is a diagnostic tool in the lineage of `docs/probe.mjs` and
`docs/hotbuffer-verify.mjs`, but persistent and cumulative instead of one-off.

## 2. Problem

Nearly every test plan among the other 16 ideas in #66 reduces to "run with `debug:true`
and eyeball the logs for a while":

- Idea #1/#2-style changes ("tweak the composite weights", "reclassify X as chatter") get
  verified by watching a few sessions and judging whether injection *feels* better.
- Idea #7/#9-style changes ("construct a fixture and confirm the curated note wins over
  the conversation echo") each build a bespoke one-off check that is thrown away after.
- Idea #12/#13-style changes ("compare before/after") have no *before* to compare against,
  because the previous idea's verification evaporated when the session ended.

That doesn't compose. There is no way to check whether idea #1 helped without redoing the
manual review from scratch for idea #7, and — worse — no way to catch a regression when
two ideas interact (e.g. a chatter-penalty tweak that fixes one query silently knocks a
curated journal entry out of the selected set for another). Every change to
`lib/ranking.ts` or the ranking config is currently verified by vibe.

The existing precedent for live verification is the ad hoc script family
(`docs/probe.mjs`, `docs/hotbuffer-verify.mjs`, `docs/filter-dialect-test.mjs`,
`docs/issue42-resourceid-probe.mjs`, `scripts/probe-writeread.mjs`): small standalone Node
scripts hitting the real API with real credentials. They work, but each one encodes one
investigation and is never run again. This harness is the natural evolution of that
pattern: the same live-API shape, but with a **fixture file that accumulates** and a
runner that stays useful across every future ranking change.

## 3. Proposed design

Three pieces: a fixture file, a runner script, and a results log for regression diffs.

### 3.1 Fixture file: `docs/eval/retrieval-fixtures.jsonl`

JSONL — one JSON object per line — because the whole growth model is "append a line when
a real retrieval moment happens", and JSONL appends never conflict with or reformat
existing lines (friendlier to git diffs than a JSON array, and a half-written trailing
line can't corrupt earlier fixtures).

Each line:

```jsonc
{
  "query": "what did we decide about the hot buffer metadata trap",
  // Matchers — at least one required; if both present, EITHER passes (see below).
  "expectedResourceId": "pHAe7atPhSmMdw",          // precise but brittle
  "expectedTitleContains": "hot buffer",            // loose but survives re-syncs
  // Optional metadata:
  "note": "came up in the 2026-06-23 hotbuffer verification session",
  "addedAt": "2026-07-07",
  "skip": false                                     // park a fixture without deleting it
}
```

**Matcher semantics — pragmatic default:** a fixture **passes** if any result in the
*selected* set (post-`selectRanked`, i.e. what would actually be injected) satisfies
*any* provided matcher:

- `expectedResourceId` — exact match on `SearchResult.resourceId`. Most precise, but
  brittle: memory-sync re-uploads a re-edited section under a **new** resource id (the
  sync manifest tracks section → resourceId, and ids churn on content change — this is
  exactly what `docs/issue42-resourceid-probe.mjs` was chasing). A fixture pinned only to
  a resourceId can go stale through no fault of the ranking.
- `expectedTitleContains` — case-insensitive substring match against
  `result.title ?? ""` **and** each `highlight.text`. Survives re-syncs; can
  false-positive if the substring is too generic, so pick distinctive phrases.

**Recommended practice:** write **both** when you know the resourceId, and rely on
OR-semantics. When the id churns, the title matcher keeps the fixture green; the runner
additionally warns (`WARN: matched by title but not by resourceId — id may have churned`)
so the id can be refreshed at leisure. Fixtures added quickly from real usage can carry
only `expectedTitleContains` — that's the low-friction default.

The directory also holds the results log (3.4). Ship the file with 2-3 seed fixtures so
the runner is demonstrably wired up from day one.

### 3.2 Runner script: `scripts/eval-retrieval.ts`

TypeScript, run via the repo's existing convention
(`node --experimental-strip-types scripts/eval-retrieval.ts`) so it can import the
**real** pipeline modules directly — `HyperspellClient` from `client.ts`, `rerank` /
`selectRanked` from `lib/ranking.ts`, `parseConfig` from `config.ts`, `excludeFilterFor`
from `lib/filters.ts` — instead of reimplementing them the way the `docs/*.mjs` probes
reimplemented raw SDK calls. If the harness reimplemented ranking, it would silently
drift from the code under test, which defeats the point.

Crucially, the runner mirrors the **single-user auto-context path** in
`hooks/auto-context.ts` step for step, so a fixture passing means "this memory would have
been injected", not "the backend returned it somewhere in the top 30":

```ts
// scripts/eval-retrieval.ts — run: node --experimental-strip-types scripts/eval-retrieval.ts
import fs from "node:fs"
import path from "node:path"
import { HyperspellClient, type SearchResult } from "../client.ts"
import { parseConfig, type HyperspellConfig } from "../config.ts"
import { rerank, selectRanked, type RankedResult } from "../lib/ranking.ts"
import { excludeFilterFor } from "../lib/filters.ts"

type Fixture = {
  query: string
  expectedResourceId?: string
  expectedTitleContains?: string
  note?: string
  addedAt?: string
  skip?: boolean
}

const FIXTURES = path.join(import.meta.dirname, "../docs/eval/retrieval-fixtures.jsonl")
const RESULTS = path.join(import.meta.dirname, "../docs/eval/retrieval-results.jsonl")

// -- config: live install by default, env overrides for portability ----------
function loadConfig(): HyperspellConfig {
  let raw: Record<string, unknown> = {}
  const live = path.join(process.env.HOME ?? "", ".openclaw/openclaw.json")
  if (fs.existsSync(live)) {
    raw = JSON.parse(fs.readFileSync(live, "utf8"))
      .plugins?.entries?.["openclaw-hyperspell"]?.config ?? {}
  }
  if (process.env.HYPERSPELL_API_KEY) raw.apiKey = process.env.HYPERSPELL_API_KEY
  if (process.env.HYPERSPELL_USER_ID) raw.userId = process.env.HYPERSPELL_USER_ID
  return parseConfig(raw) // same defaults the plugin itself would get
}

function loadFixtures(): Fixture[] {
  return fs.readFileSync(FIXTURES, "utf8")
    .split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("//"))
    .map((l) => JSON.parse(l) as Fixture)
}

// -- matcher (OR semantics; see proposal §3.1) --------------------------------
function matches(r: SearchResult, f: Fixture): "id" | "title" | null {
  if (f.expectedResourceId && r.resourceId === f.expectedResourceId) return "id"
  if (f.expectedTitleContains) {
    const needle = f.expectedTitleContains.toLowerCase()
    const hay = [r.title ?? "", ...r.highlights.map((h) => h.text)].join(" ").toLowerCase()
    if (hay.includes(needle)) return "title"
  }
  return null
}

async function main() {
  const cfg = loadConfig()
  const client = new HyperspellClient(cfg)
  const fixtures = loadFixtures()
  const run: Array<{ query: string; pass: boolean; via?: string; rank?: number }> = []

  for (const f of fixtures) {
    if (f.skip) { console.log(`SKIP  ${f.query}`); continue }
    // Mirror hooks/auto-context.ts single-user path exactly:
    const limit = cfg.ranking.enabled
      ? cfg.maxResults * cfg.ranking.candidateMultiplier
      : cfg.maxResults
    const results = await client.search(f.query, { limit, filter: excludeFilterFor(cfg) })
    const selected: RankedResult[] = cfg.ranking.enabled
      ? selectRanked(rerank(results, cfg.ranking), cfg.maxResults,
          cfg.relevanceThreshold, cfg.ranking.chatterQuota)
      : (rerank(results, { ...cfg.ranking, enabled: false })
          .filter((r) => (r.score ?? 0) >= cfg.relevanceThreshold)
          .slice(0, cfg.maxResults))

    let hit: { via: string; rank: number } | null = null
    selected.forEach((r, i) => {
      const via = matches(r, f)
      if (via && !hit) hit = { via, rank: i + 1 }
    })
    if (hit) {
      console.log(`PASS  ${f.query}  (rank ${hit.rank}, via ${hit.via})`)
      if (f.expectedResourceId && hit.via === "title")
        console.log(`  WARN: matched by title but not resourceId — id may have churned`)
    } else {
      console.log(`FAIL  ${f.query}`)
      // Diagnosis: was it in the CANDIDATE pool but cut by ranking/threshold/quota?
      const inPool = results.find((r) => matches(r, f))
      console.log(inPool
        ? `  (in candidate pool as "${inPool.title}" score=${inPool.score} — cut by rerank/threshold/quota)`
        : `  (not in top ${limit} from backend at all — a search problem, not a ranking problem)`)
    }
    run.push({ query: f.query, pass: !!hit, via: hit?.via, rank: hit?.rank })
  }

  const passed = run.filter((r) => r.pass).length
  console.log(`\n${passed}/${run.length} passed`)

  // -- regression diff vs previous run + append this run ----------------------
  const prev = fs.existsSync(RESULTS)
    ? fs.readFileSync(RESULTS, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1)
    : null
  if (prev) {
    for (const r of run) {
      const p = prev.fixtures.find((x: { query: string }) => x.query === r.query)
      if (p && p.pass && !r.pass) console.log(`REGRESSION: "${r.query}" flipped pass -> fail`)
      if (p && !p.pass && r.pass) console.log(`fixed: "${r.query}" flipped fail -> pass`)
    }
  }
  fs.appendFileSync(RESULTS, JSON.stringify({
    at: new Date().toISOString(),
    label: process.env.EVAL_LABEL ?? null, // e.g. "before-idea-7" / "after-idea-7"
    score: `${passed}/${run.length}`,
    config: { relevanceThreshold: cfg.relevanceThreshold, ranking: cfg.ranking,
              maxResults: cfg.maxResults },
    fixtures: run,
  }) + "\n")
  process.exitCode = passed === run.length ? 0 : 1
}

main().catch((e) => { console.error(e); process.exit(2) })
```

Design points worth calling out for the implementer:

- **Full pipeline, not raw search.** The candidate-pool widening
  (`maxResults * candidateMultiplier`), the exclude filter, `rerank`, and `selectRanked`
  (threshold + chatter quota) are all applied, exactly as `hooks/auto-context.ts` does.
  A fixture pass means "would have been injected".
- **Pool diagnosis on failure.** The single most useful debugging fact is whether the
  expected memory was *retrieved but ranked out* (a `lib/ranking.ts` / config problem —
  most of the #66 ideas) versus *never returned by the backend* (a search/indexing
  problem — out of this plugin's hands). The runner prints which, per failure.
- **Config snapshot in the results log.** Each run records the ranking weights and
  threshold it ran with, so a diff between runs is attributable ("chatterPenalty went
  0.2 → 0.35 and these two fixtures flipped").
- **`dropCurrentSession` is deliberately omitted** — the harness has no current session.
  This is the one intentional divergence from the hook path, and should be noted in a
  comment.
- Not implemented in this sketch but easy follow-ons: `--only "<substring>"` to run one
  fixture, `--json` for machine consumption, small delay between queries to be polite.

### 3.3 How fixtures get added (the growth process)

Deliberately lightweight — the fixture file only earns its keep if adding to it costs
less than a minute:

1. **Trigger:** any real "the right memory should have surfaced here" moment in normal
   use — Alinea answers without a memory that plainly exists, or a debug-log review shows
   the right resource losing to chatter. These moments already happen; today they
   evaporate.
2. **Action:** append one line to `docs/eval/retrieval-fixtures.jsonl` with the *actual
   prompt* (or a close paraphrase) as `query`, an `expectedTitleContains` phrase (plus
   the `expectedResourceId` if it's handy from debug logs), and a one-line `note` on
   where it came from. Commit with the rest of whatever you're doing.
3. **Also capture successes worth protecting:** when a ranking change makes some query
   *start* working, add it as a fixture immediately — that's the regression tripwire for
   the next idea's change.
4. **No review gate.** A bad fixture costs one FAIL line and gets `"skip": true` or
   deleted. Optimize for accumulation.

Target from #66: once ~10-15 pairs accumulate, before/after runs produce a meaningful
number.

### 3.4 Regression comparison between runs

Every run appends one line to `docs/eval/retrieval-results.jsonl` (timestamp, optional
`EVAL_LABEL`, score, config snapshot, per-fixture pass/fail). The workflow around any
ranking change — a `lib/ranking.ts` edit, a weight change in config, or two ideas from
#66 landing near each other — is:

```
EVAL_LABEL=before-idea-7 node --experimental-strip-types scripts/eval-retrieval.ts
# ...make the change...
EVAL_LABEL=after-idea-7  node --experimental-strip-types scripts/eval-retrieval.ts
```

The runner itself diffs the new run against the immediately previous line and prints
`REGRESSION: "<query>" flipped pass -> fail` / `fixed: ...` — so the comparison is
automatic in the common back-to-back case, and the JSONL log supports manual `jq` diffs
between any two labeled runs. **A regression is defined per-fixture, not by aggregate
score:** 10/12 → 10/12 where one fixture flipped each way is *two findings*, not a wash —
the flip-to-fail must be explained (data churn? intended tradeoff? real regression)
before the change ships. Whether the results log is committed to git or kept local is the
implementer's call; committing it gives history for free but adds noise to diffs —
starting **local-only (gitignored), fixtures committed** is the recommended default.

## 4. Test plan

Recursive but necessary: before this harness is trusted to judge ideas #1-#16, its own
pass/fail logic has to be validated. All of this is manual, against the live API, on the
maintainer's real install (reads only — the harness never writes memories):

1. **Known-good fixture (must PASS).** Add a fixture for a memory that demonstrably
   surfaces today — e.g. a query taken verbatim from a debug log where the right curated
   note was injected. Run the harness; it must report PASS with a sane rank.
2. **Deliberately-wrong fixture (must FAIL, "not in pool").** Add
   `{ "query": "the right memory should surface", "expectedTitleContains": "zzz-no-such-memory-zzz" }`.
   Must FAIL with the "not in top N from backend" diagnosis. This proves the harness
   can't be fooled into passing everything.
3. **Ranked-out fixture (must FAIL, "cut by rerank").** Temporarily set
   `relevanceThreshold` to 0.99 (env-override or a scratch config) and re-run the
   known-good fixture: it must now FAIL with the "in candidate pool — cut by
   rerank/threshold/quota" diagnosis. This validates the pool-vs-selection distinction,
   which is the harness's main diagnostic value.
4. **Matcher OR-semantics.** One fixture with a correct `expectedTitleContains` and a
   deliberately wrong `expectedResourceId`: must PASS via title *and* print the
   id-churn WARN. Then the inverse (correct id, wrong title substring): must PASS via id.
5. **Regression diff.** Run twice with no changes (expect no flips), then run with
   threshold at 0.99 (expect `REGRESSION:` lines for every previously-passing fixture),
   then restore and run again (expect `fixed:` lines). Confirms the results-log
   append/compare logic.
6. **Exit codes.** 0 on all-pass, 1 on any fail, 2 on crash — so the harness is
   scriptable later without parsing stdout.

Only the matcher and fixture-parsing functions are pure enough to be worth hermetic unit
tests; if extracted (e.g. `lib/eval-matchers.ts`), they can join `npm test` — but the
runner itself must not (see §6).

## 5. Risks / tradeoffs

- **Fixture staleness is real and irreducible.** The corpus is alive: memory-sync
  re-uploads change resourceIds, old conversations get purged, a journal gets rewritten.
  A fixture that flips to FAIL may be telling the truth about the *data*, not the
  *ranking*. The harness cannot distinguish these automatically — a flip is a **prompt
  for a human judgment call**, not a verdict. Mitigations, not cures: the title-matcher
  fallback absorbs pure id-churn; the "in pool vs. not in pool" diagnosis separates
  "backend no longer returns it" (likely data) from "still retrieved, now ranked out"
  (likely ranking); `skip: true` parks a fixture pending investigation without losing it.
  Expect to retire or rewrite a couple of fixtures per quarter and treat that as normal
  maintenance, not harness failure.
- **Small n makes the aggregate score noisy.** With 10-15 fixtures, one flip is ~7-10
  percentage points — "score went from 75% to 67%" means almost nothing as a number.
  This is why §3.4 defines regressions per-fixture: the unit of signal is *which* fixture
  flipped and *why*, never the percentage. The score is a headline, not a metric; resist
  the urge to optimize it.
- **Live-API dependency means non-reproducibility.** Two runs a week apart differ in
  corpus content, and possibly in backend ranking behavior. Back-to-back before/after
  runs (minutes apart) are the trustworthy comparison; cross-week comparisons are
  directional at best. The config snapshot per run at least makes "what changed on our
  side" auditable.
- **Fixtures encode one person's judgment of "the right memory".** Fine at this scale
  (single-maintainer, Alinea's corpus), worth revisiting if the fixture file ever serves
  multiple installs — a fixture is meaningful only against the corpus it was written for,
  which is another reason the results log should stay local.
- **Single-user path only (v1).** The multi-user path in `hooks/auto-context.ts` has its
  own merge logic (`mergeWithExclude`, per-scope searches); mirroring it is out of scope
  for v1 and should be a follow-up if scoped-memory ranking ideas need eval coverage.

## 6. Rollout

- **Files:**
  - `docs/eval/retrieval-fixtures.jsonl` — committed, grows over time, seeded with 2-3
    fixtures at merge.
  - `docs/eval/retrieval-results.jsonl` — local run log, **gitignored**.
  - `scripts/eval-retrieval.ts` — the runner (in `scripts/`, alongside
    `probe-writeread.mjs`, since it's tooling rather than investigation notes; the
    `docs/*.mjs` scripts are historical artifacts of specific issues and stay put).
- **npm script — yes, add one** for discoverability, since "how do I check ranking
  changes" should have a one-line answer in `package.json`:
  ```json
  "eval:retrieval": "node --experimental-strip-types scripts/eval-retrieval.ts"
  ```
- **Explicit non-goal: CI.** This is different in kind from the unit suite
  (`node --test --experimental-strip-types *.test.ts`, mocked and hermetic). The harness
  requires real credentials, reads live user data, and is non-deterministic as the corpus
  evolves — wiring it into `npm test` or any CI gate would make CI flaky, leak a
  credential requirement into every contributor's environment, and turn honest data
  churn into red builds. It is run **manually, by a maintainer, around ranking changes**.
  The `test` script must not reference it; the README/docs note for the other #66 ideas
  should point their test plans here instead of at debug-log eyeballing.
- **Handshake with the other proposals:** as ideas #1, #2, #7, #9, #12, #13 (etc.) get
  implemented, each should (a) run `EVAL_LABEL=before-... / after-...` around its change
  and paste the diff into its PR, and (b) contribute at least one fixture representing
  the case it fixes. That's how the fixture file gets from 3 seeds to the 10-15 target
  without a dedicated fixture-writing effort.

## 7. Effort estimate

**S** — the runner is ~150 lines reusing the existing pipeline modules verbatim, the
fixture format is a JSONL append convention, and there is no CI, mocking, or backend work;
the only genuinely new logic is the matcher, the pool-vs-selection diagnosis, and the
run-log diff.
