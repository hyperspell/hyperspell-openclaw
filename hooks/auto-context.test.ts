import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { HyperspellClient, SearchResult } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { COVERAGE_LOG_NAME } from "../lib/coverage-log.ts"
import { DEFAULT_RANKING, type RankedResult } from "../lib/ranking.ts"
import { initLogger } from "../logger.ts"
import {
  buildAutoContextCompactionHandler,
  buildAutoContextHandler,
  buildAutoContextSessionCleanupHandler,
  dropCurrentSession,
  formatSelected,
} from "./auto-context.ts"
import { recordSessionWrite } from "../lib/session-writes.ts"

function result(resourceId: string): SearchResult {
  return {
    resourceId,
    title: null,
    source: "vault",
    score: 0.9,
    url: null,
    createdAt: null,
    metaSource: null,
    metaSpeakerRole: null,
    metaFilePath: null,
    metaWriter: null,
    highlights: [],
  }
}

test("dropCurrentSession — removes only rows whose resourceId is the current session", () => {
  const rows = [result("sess-A"), result("other-1"), result("sess-A"), result("other-2")]
  const kept = dropCurrentSession(rows, "sess-A")
  assert.deepEqual(
    kept.map((r) => r.resourceId),
    ["other-1", "other-2"],
  )
})

test("dropCurrentSession — undefined id is identity (degrade-safe: never excludes)", () => {
  const rows = [result("sess-A"), result("other-1")]
  assert.equal(dropCurrentSession(rows, undefined), rows)
})

test("dropCurrentSession — id with no match leaves the list intact", () => {
  const rows = [result("other-1"), result("other-2")]
  const kept = dropCurrentSession(rows, "sess-A")
  assert.deepEqual(
    kept.map((r) => r.resourceId),
    ["other-1", "other-2"],
  )
})

test("dropCurrentSession — empty input stays empty", () => {
  assert.deepEqual(dropCurrentSession([], "sess-A"), [])
})

// ---------------------------------------------------------------------------
// Score-log instrumentation (proposal 02): the handler's selection must be
// byte-identical with and without HYPERSPELL_SCORE_LOG, the JSONL must carry
// one line per candidate with a consistent cut attribution, and a failing
// write must never break retrieval.
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Partial<HyperspellConfig>): HyperspellConfig {
  return {
    apiKey: "k",
    autoContext: true,
    autoTrace: { enabled: false, extract: [] },
    hotBuffer: { enabled: false, source: "vault", writeUser: true, writeAssistant: true },
    emotionalContext: false,
    moodWeatherChance: 0,
    excludeChannels: [],
    quarantineResources: [],
    startupOrientation: {
      enabled: false,
      recentDays: 7,
      recentLimit: 5,
      loopsLimit: 3,
      loopsQuery: "open tasks",
    },
    syncMemories: false,
    syncMemoriesConfig: {
      enabled: false,
      sectionize: true,
      watchPaths: [],
      debounceMs: 2000,
      maxAgeDays: 30,
      ignorePaths: ["dreaming"],
    },
    sources: [],
    maxResults: 10,
    relevanceThreshold: 0.6,
    ranking: DEFAULT_RANKING,
    coverageLog: false,
    debug: false,
    knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
    ...overrides,
  } as HyperspellConfig
}

const CHATTER_UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

function searchResult(over: Partial<SearchResult>): SearchResult {
  return {
    resourceId: "r1",
    title: null,
    source: "vault",
    score: null,
    url: null,
    createdAt: null,
    metaSource: null,
    metaSpeakerRole: null,
    metaFilePath: null,
    metaWriter: null,
    highlights: [],
    ...over,
  }
}

// A pool with a known outcome at defaults (threshold 0.6, quota 2, max 10):
// curated 0.7→0.9 and chatter 0.9→0.7 / 0.85→0.65 selected; the third chatter
// 0.8→0.6 clears the threshold but hits the quota; the low note 0.3→0.5 falls
// to the threshold. 5 candidates → 3 selected, 2 cut.
function fixturePool(): SearchResult[] {
  return [
    searchResult({
      resourceId: "mem-notes",
      title: "Writing Notes",
      score: 0.7,
      highlights: [{ id: "h1", text: "Heath, Junii, Tevre; the Omuerta", score: 0.7 }],
    }),
    searchResult({
      resourceId: CHATTER_UUID(1),
      score: 0.9,
      highlights: [
        {
          id: "h2",
          text: `echo one\nwith embedded\nnewlines ${"and a very long tail ".repeat(10)}`,
          score: 0.9,
        },
      ],
    }),
    searchResult({
      resourceId: CHATTER_UUID(2),
      title: "Unnamed Conversation",
      score: 0.85,
      highlights: [{ id: "h3", text: "echo two", score: 0.85 }],
    }),
    searchResult({
      resourceId: CHATTER_UUID(3),
      score: 0.8,
      highlights: [{ id: "h4", text: "echo three", score: 0.8 }],
    }),
    searchResult({
      resourceId: "mem-low",
      title: "Low Note",
      score: 0.3,
      highlights: [{ id: "h5", text: "quiet low-relevance note", score: 0.3 }],
    }),
  ]
}

function makeHandler(cfg = makeCfg()) {
  const client = {
    search: async () => fixturePool(),
  } as unknown as HyperspellClient
  return buildAutoContextHandler(client, cfg)
}

// Longer than 80 chars so the shape test exercises the prompt truncation.
const PROMPT =
  "tell me about the omuerta and what heath decided about the manuscript ending after junii left for the coast"

async function runHandler(cfg = makeCfg()) {
  return (await makeHandler(cfg)({ prompt: PROMPT })) as
    | { prependContext: string }
    | undefined
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-scorelog-"))
}

async function withScoreLog<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HYPERSPELL_SCORE_LOG
  if (value === undefined) delete process.env.HYPERSPELL_SCORE_LOG
  else process.env.HYPERSPELL_SCORE_LOG = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.HYPERSPELL_SCORE_LOG
    else process.env.HYPERSPELL_SCORE_LOG = prev
  }
}

test("auto-context — score log off by default: no file, and injection identical to the logging run", async () => {
  const dir = tmpDir()
  const logPath = path.join(dir, "scores.jsonl")

  const offResult = await withScoreLog(undefined, () => runHandler())
  assert.ok(offResult?.prependContext, "injects with the log disabled")
  assert.equal(fs.readdirSync(dir).length, 0, "nothing written without the env var")

  const onResult = await withScoreLog(logPath, () => runHandler())
  assert.equal(
    onResult?.prependContext,
    offResult?.prependContext,
    "logging is pure instrumentation — selection and injection are unchanged",
  )
  assert.ok(fs.existsSync(logPath), "log written when the env var is set")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("auto-context — score log shape: one JSON line per candidate, cut attribution consistent with injection", async () => {
  const dir = tmpDir()
  const logPath = path.join(dir, "scores.jsonl")
  const result = await withScoreLog(logPath, () => runHandler())
  assert.ok(result?.prependContext)

  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, fixturePool().length, "one line per candidate, selected AND cut")
  const rows = lines.map((l) => JSON.parse(l))

  const byId = new Map(rows.map((r) => [r.resourceId, r]))
  assert.deepEqual(
    rows.filter((r) => r.selected).map((r) => r.resourceId),
    ["mem-notes", CHATTER_UUID(1), CHATTER_UUID(2)],
    "selected set matches the known fixture outcome, ranked order",
  )
  assert.equal(byId.get(CHATTER_UUID(3))?.cut, "chatter-quota", "quota-bound echo attributed to the quota")
  assert.equal(byId.get("mem-low")?.cut, "threshold")

  for (const r of rows) {
    assert.equal(r.scope, "single")
    assert.equal(r.threshold, 0.6)
    assert.ok(r.prompt.length <= 80, "prompt truncated to 80 chars")
    assert.equal(r.prompt, PROMPT.slice(0, 80))
    assert.ok(!Number.isNaN(Date.parse(r.ts)))
    assert.equal(typeof r.base, "number")
    assert.equal(typeof r.composite, "number")
    assert.equal(r.selected, r.cut === null, "selected iff no cut reason")
    assert.ok(!r.snippet.includes("\n"), "snippet is newline-free")
    assert.ok(r.snippet.length <= 120, "snippet capped at 120 chars")
  }
  // Every selected row's snippet must appear in the injected block (same memory).
  assert.ok(result.prependContext.includes("Writing Notes"))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("auto-context — score log failure is isolated: unwritable path still injects normally", async () => {
  const dir = tmpDir()
  // A directory is not appendable — appendFileSync throws EISDIR; the handler
  // must swallow it (instrumentation never breaks retrieval).
  const result = await withScoreLog(dir, () => runHandler())
  const plain = await withScoreLog(undefined, () => runHandler())
  assert.equal(result?.prependContext, plain?.prependContext, "injection unaffected by the failed write")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("auto-context — debug lines carry cut reasons and the injected composite range", async () => {
  // Summary lines (ranked/cut/injecting) must arrive on the INFO channel: the
  // host drops plugin debug output from gateway.log (issue #118), so log.diag
  // routes them via info when debug: true. Per-candidate lines stay debug.
  const seenInfo: string[] = []
  const seenDebug: string[] = []
  const capture = {
    info: (msg: string) => seenInfo.push(msg),
    warn: () => {},
    error: () => {},
    debug: (msg: string) => seenDebug.push(msg),
  }
  initLogger(capture, true)
  try {
    const result = await runHandler(makeCfg({ debug: true }))
    assert.ok(result?.prependContext)
  } finally {
    initLogger(console, false)
  }

  const rankedLine = seenInfo.find((m) => m.includes("auto-context: ranked"))
  assert.ok(rankedLine, "unconditional candidates → selected tally logged")
  assert.ok(
    rankedLine.includes(`ranked {"curated":2,"chatter":3} candidates → selected {"curated":1,"chatter":2}`),
    `candidate-pool tally shows kinds that lost, not just survivors: ${rankedLine}`,
  )
  const perResultLines = seenDebug.filter((m) => /^ {2}\[(story|curated|chatter|other)\] /.test(m.replace(/^hyperspell: /, "")))
  assert.equal(perResultLines.length, 5, "one per-candidate line for each of the 5 ranked results (verbose — stays debug)")
  assert.ok(
    perResultLines[0].includes("[curated]"),
    `top candidate line carries kind + base→composite: ${perResultLines[0]}`,
  )

  const cutLine = seenInfo.find((m) => m.includes("auto-context: cut"))
  assert.ok(cutLine, "cut-reason line logged via the info-emitting path (issue #118)")
  assert.ok(
    cutLine.includes(`cut 2 of 5 candidates {"chatter-quota":1,"threshold":1}`),
    `cut tally names each binding reason: ${cutLine}`,
  )
  assert.ok(
    cutLine.includes("top quota-dropped composite 0.60"),
    "quota-bound drops report the top dropped composite (proposal 03)",
  )

  const injectLine = seenInfo.find((m) => m.includes("injecting (ranked)"))
  assert.ok(injectLine, "tally line logged via the info-emitting path (issue #118)")
  assert.ok(
    injectLine.includes(`{"curated":1,"chatter":2} from 5 candidates (chatter cap 2, composite 0.65–0.90)`),
    `tally line extended with the injected composite range: ${injectLine}`,
  )
})

// ---------------------------------------------------------------------------
// Zero-result coverage log (proposal 15): a SUCCESSFUL search that injects
// nothing appends one local JSONL event distinguishing "never captured"
// (empty) from "captured but ranked out" (below_threshold). OFF by default —
// events carry prompt text, so nothing reaches disk without explicit opt-in —
// and failed searches never produce events (#39: unavailable is not empty).
// ---------------------------------------------------------------------------

function mkStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hs-coverage-"))
}

function makeSearchClient(results: SearchResult[] | Error): HyperspellClient {
  return {
    async search() {
      if (results instanceof Error) throw results
      return results
    },
  } as unknown as HyperspellClient
}

function readCoverage(stateRoot: string) {
  return fs
    .readFileSync(path.join(stateRoot, COVERAGE_LOG_NAME), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
}

const COVERAGE_PROMPT = "what did we decide about the staging DB migration?"

test("auto-context coverage — zero-result search writes an 'empty' event", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(
    makeSearchClient([]),
    makeCfg({ coverageLog: true }),
    { stateRoot },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, {})) as
    | { prependContext: string }
    | undefined
  assert.equal(
    out?.prependContext,
    "<hyperspell-context>\nrecall: 0 candidates · best none · threshold 0.60 · nothing shown\n</hyperspell-context>",
  )

  const entries = readCoverage(stateRoot)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.v, 2)
  assert.equal(entry.outcome, "empty")
  assert.equal(entry.fetched, 0)
  assert.equal(entry.candidates, 0)
  assert.equal(entry.droppedCurrentSession, 0)
  assert.equal(entry.topScore, null)
  assert.equal(entry.threshold, 0.6)
  assert.equal(entry.ranking, true)
  assert.match(entry.prompt, /staging DB migration/)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — candidates below threshold write a 'below_threshold' event", async () => {
  const stateRoot = mkStateRoot()
  const low = searchResult({
    resourceId: "mem-low",
    title: "Low Note",
    score: 0.2,
    highlights: [{ id: "h1", text: "quiet note", score: 0.2 }],
  })
  const handler = buildAutoContextHandler(
    makeSearchClient([low]),
    makeCfg({ coverageLog: true }),
    { stateRoot },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, {})) as
    | { prependContext: string }
    | undefined
  assert.ok(
    out?.prependContext.includes(
      "recall: 1 candidates · best 0.40 · threshold 0.60 · nothing shown",
    ),
  )

  const [entry] = readCoverage(stateRoot)
  assert.equal(entry.outcome, "below_threshold")
  assert.equal(entry.fetched, 1)
  assert.equal(entry.candidates, 1)
  assert.equal(entry.topScore, 0.4)
  assert.equal(entry.rawTopScore, 0.2)
  assert.equal(entry.threshold, 0.6)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — FOK uses the gated composite, not the raw server score", async () => {
  const stateRoot = mkStateRoot()
  const oldChatter = searchResult({
    resourceId: CHATTER_UUID(9),
    score: 0.841,
    createdAt: "2000-01-01T00:00:00Z",
    highlights: [{ id: "h1", text: "old conversation echo", score: 0.841 }],
  })
  const handler = buildAutoContextHandler(
    makeSearchClient([oldChatter]),
    makeCfg({ coverageLog: true }),
    { stateRoot },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, {})) as
    | { prependContext: string }
    | undefined

  assert.ok(out?.prependContext.includes("best 0.54 · threshold 0.60 · nothing shown"))
  const [entry] = readCoverage(stateRoot)
  assert.equal(entry.outcome, "below_threshold")
  assert.equal(entry.rawTopScore, 0.841)
  assert.ok(Math.abs(entry.topScore - 0.541) < 0.001)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — a non-threshold cut is labeled 'filtered'", async () => {
  const stateRoot = mkStateRoot()
  const chatter = searchResult({
    resourceId: CHATTER_UUID(8),
    score: 0.9,
    highlights: [{ id: "h1", text: "quota-cut echo", score: 0.9 }],
  })
  const handler = buildAutoContextHandler(
    makeSearchClient([chatter]),
    makeCfg({
      coverageLog: true,
      ranking: { ...DEFAULT_RANKING, chatterQuota: 0 },
    }),
    { stateRoot },
  )
  await handler({ prompt: COVERAGE_PROMPT }, {})

  const [entry] = readCoverage(stateRoot)
  assert.equal(entry.outcome, "filtered")
  assert.ok(entry.topScore >= entry.threshold)
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — OFF by default: no file even on a zero-result turn", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(makeSearchClient([]), makeCfg(), {
    stateRoot,
  })
  await handler({ prompt: COVERAGE_PROMPT }, {})
  assert.ok(
    !fs.existsSync(path.join(stateRoot, COVERAGE_LOG_NAME)),
    "coverageLog defaults false — prompts never reach disk without opt-in",
  )
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — an injecting turn writes hit telemetry", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(
    makeSearchClient(fixturePool()),
    makeCfg({ coverageLog: true }),
    { stateRoot },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, {})) as
    | { prependContext: string }
    | undefined
  assert.ok(out?.prependContext, "fixture pool injects")
  assert.ok(
    out.prependContext.includes(
      "recall: 5 candidates · best 0.90 · threshold 0.60 · 3 shown",
    ),
  )
  const [entry] = readCoverage(stateRoot)
  assert.equal(entry.outcome, "injected")
  assert.equal(entry.shown, 3)
  assert.ok(entry.shownChars > 0)
  assert.deepEqual(
    entry.selected.map((r: { resourceId: string }) => r.resourceId),
    ["mem-notes", CHATTER_UUID(1), CHATTER_UUID(2)],
  )
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — a FAILED search writes no event (availability is not coverage)", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(
    makeSearchClient(new Error("boom")),
    makeCfg({ coverageLog: true }),
    { stateRoot },
  )
  const out = await handler({ prompt: COVERAGE_PROMPT }, {})
  assert.equal(out, undefined, "existing behavior: silent on failure")
  assert.ok(!fs.existsSync(path.join(stateRoot, COVERAGE_LOG_NAME)))
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — unwritable stateRoot degrades safely (turn still resolves)", async () => {
  const stateRoot = mkStateRoot()
  const notADir = path.join(stateRoot, "not-a-dir")
  fs.writeFileSync(notADir, "plain file")
  const handler = buildAutoContextHandler(
    makeSearchClient([]),
    makeCfg({ coverageLog: true }),
    { stateRoot: notADir },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, {})) as
    | { prependContext: string }
    | undefined
  assert.ok(
    out?.prependContext.includes("recall: 0 candidates"),
    "coverage write failure never suppresses the runtime signal",
  )
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

// --- multi-user parity -------------------------------------------------------

const MULTI_USER = {
  senderMap: { dave: { userId: "u-dave", name: "Dave" } },
  sharedUserId: "shared",
  includeSharedInSearch: true,
} as HyperspellConfig["multiUser"]

function makeLaneClient(
  personal: SearchResult[] | Error,
  shared: SearchResult[] | Error,
): HyperspellClient {
  return {
    async search(_prompt: string, options?: { userId?: string }) {
      const outcome = options?.userId === "shared" ? shared : personal
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  } as unknown as HyperspellClient
}

test("auto-context coverage — multi-user: failed lane recorded as error, not as empty", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(
    makeLaneClient(new Error("personal down"), []),
    makeCfg({ coverageLog: true, multiUser: MULTI_USER }),
    { stateRoot },
  )
  const out = (await handler({ prompt: COVERAGE_PROMPT }, { senderId: "dave" })) as
    | { prependContext: string }
    | undefined
  assert.ok(
    out?.prependContext.includes("You are speaking with Dave"),
    "identity preamble still injected (identity, not memory)",
  )

  const entries = readCoverage(stateRoot)
  assert.equal(entries.length, 1, "one event per turn, not per lane")
  const entry = entries[0]
  assert.equal(entry.outcome, "empty")
  assert.equal(entry.userId, "u-dave")
  assert.deepEqual(entry.lanes, [
    { lane: "personal", status: "error" },
    {
      lane: "shared",
      status: "ok",
      candidates: 0,
      topScore: null,
      rawTopScore: null,
    },
  ])
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — multi-user: every lane failing writes no event", async () => {
  const stateRoot = mkStateRoot()
  const handler = buildAutoContextHandler(
    makeLaneClient(new Error("down"), new Error("down")),
    makeCfg({ coverageLog: true, multiUser: MULTI_USER }),
    { stateRoot },
  )
  await handler({ prompt: COVERAGE_PROMPT }, { senderId: "dave" })
  assert.ok(
    !fs.existsSync(path.join(stateRoot, COVERAGE_LOG_NAME)),
    "all-lanes-failed is an availability event (#39), never coverage",
  )
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

test("auto-context coverage — multi-user: below_threshold when a fulfilled lane had candidates", async () => {
  const stateRoot = mkStateRoot()
  const low = searchResult({
    resourceId: "mem-low",
    title: "Low Note",
    score: 0.2,
    highlights: [{ id: "h1", text: "quiet note", score: 0.2 }],
  })
  const handler = buildAutoContextHandler(
    makeLaneClient([low], []),
    makeCfg({ coverageLog: true, multiUser: MULTI_USER }),
    { stateRoot },
  )
  const out = (await handler(
    { prompt: COVERAGE_PROMPT },
    { senderId: "dave" },
  )) as { prependContext: string } | undefined
  assert.ok(
    out?.prependContext.includes(
      "recall: 1 candidates · best 0.40 · threshold 0.60 · nothing shown",
    ),
  )

  const [entry] = readCoverage(stateRoot)
  assert.equal(entry.outcome, "below_threshold")
  assert.equal(entry.fetched, 1)
  assert.equal(entry.candidates, 1)
  assert.equal(entry.topScore, 0.4)
  assert.equal(entry.rawTopScore, 0.2)
  assert.deepEqual(entry.lanes, [
    {
      lane: "personal",
      status: "ok",
      candidates: 1,
      topScore: 0.4,
      rawTopScore: 0.2,
    },
    {
      lane: "shared",
      status: "ok",
      candidates: 0,
      topScore: null,
      rawTopScore: null,
    },
  ])
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

// ---- adaptive highlight budget (proposal 12) ----

function selectedResult(id: string, base: number, scores: number[]): RankedResult {
  return {
    ...result(id),
    title: `Note ${id}`,
    highlights: scores.map((score, i) => ({ id: `h${i}`, score, text: `highlight at ${score}` })),
    _kind: "curated",
    _base: base,
    _composite: base + DEFAULT_RANKING.curationBoost,
  }
}

test("formatSelected — gap cutoff: the marginal second highlight is dropped", () => {
  // Pre-change characterization: _base 0.4 lowers hiFloor to 0.4, so the .4
  // highlight passed the floor and rendered — the exact fluff the gap removes.
  const out = formatSelected([selectedResult("a", 0.4, [0.95, 0.4])], 0.6)
  assert.ok(out?.includes("[95%]"))
  assert.ok(!out?.includes("[40%]"), "0.55 gap > 0.15 — the weak second is dilution")
  assert.equal(out?.split("\n").filter((l) => l.startsWith("- ")).length, 1)
})

test("formatSelected — close pair keeps both highlights", () => {
  const out = formatSelected([selectedResult("a", 0.85, [0.95, 0.85])], 0.6)
  assert.ok(out?.includes("[95%]"))
  assert.ok(out?.includes("[85%]"), "gap 0.10 <= 0.15")
})

test("formatSelected — boundary is inclusive: gap of exactly 0.15 keeps the second", () => {
  const out = formatSelected([selectedResult("a", 0.8, [0.95, 0.8])], 0.6)
  assert.ok(out?.includes("[95%]"))
  assert.ok(out?.includes("[80%]"))
})

test("formatSelected — top highlight always survives: never formats a selected result to nothing", () => {
  const single = formatSelected([selectedResult("a", 0.95, [0.95])], 0.6)
  assert.ok(single?.includes("[95%]"))
  const withWeakSecond = formatSelected([selectedResult("b", 0.4, [0.95, 0.4])], 0.6)
  assert.ok(withWeakSecond !== null && withWeakSecond.includes("### Note b"), "section still renders")
})

test("formatSelected — hiFloor composes before the gap: a second failing the floor never reaches it", () => {
  // threshold 0.92 and _base 0.92 → hiFloor 0.92; the .9 highlight fails the
  // floor (not the gap) and only one bullet renders. No crash on the missing
  // second.
  const out = formatSelected([selectedResult("a", 0.92, [0.95, 0.9])], 0.92)
  assert.ok(out?.includes("[95%]"))
  assert.ok(!out?.includes("[90%]"))
})

test("formatSelected — all highlights below floor still degrade to a skipped section", () => {
  const out = formatSelected([selectedResult("a", 0.9, [0.3, 0.2])], 0.6)
  assert.equal(out, null)
})

test("repeat suppression — a memory injected once is not re-injected later in the same session; compaction clears; other sessions unaffected", async () => {
  const pool = [
    searchResult({
      resourceId: "mem-repeat",
      title: "Durable Note",
      score: 0.9,
      highlights: [{ id: "h1", text: "the important durable note", score: 0.9 }],
    }),
  ]
  const client = { search: async () => pool } as unknown as HyperspellClient
  const handler = buildAutoContextHandler(client, makeCfg())
  const ctx = { sessionKey: "agent:main:discord:channel:rs-1", sessionId: "rs-session-1" }

  const first = (await handler({ prompt: PROMPT }, ctx)) as { prependContext: string } | undefined
  assert.ok(first?.prependContext.includes("mem-repeat"), "first turn injects")

  const second = await handler({ prompt: PROMPT }, ctx)
  assert.ok(
    second?.prependContext?.includes("nothing shown"),
    "same memory is not re-injected, but the retrieval shape remains visible",
  )
  assert.ok(!second?.prependContext?.includes("mem-repeat"))

  // A DIFFERENT session is unaffected by session 1's suppression.
  const other = (await handler(
    { prompt: PROMPT },
    { sessionKey: "agent:main:discord:channel:rs-2", sessionId: "rs-session-2" },
  )) as { prependContext: string } | undefined
  assert.ok(other?.prependContext.includes("mem-repeat"))

  // Compaction clears: the earlier injection may be gone from history.
  buildAutoContextCompactionHandler()({}, ctx)
  const third = (await handler({ prompt: PROMPT }, ctx)) as { prependContext: string } | undefined
  assert.ok(third?.prependContext.includes("mem-repeat"), "after compaction, re-injection is allowed")

  buildAutoContextSessionCleanupHandler()({}, ctx)
  buildAutoContextSessionCleanupHandler()({}, { sessionId: "rs-session-2" })
})

test("repeat suppression — a remember write from THIS session is excluded from retrieval (C3), other sessions still see it", async () => {
  const pool = [
    searchResult({
      resourceId: "mem-just-written",
      title: "Note I just saved",
      score: 0.95,
      highlights: [{ id: "h1", text: "the note the agent just wrote", score: 0.95 }],
    }),
  ]
  const client = { search: async () => pool } as unknown as HyperspellClient
  const handler = buildAutoContextHandler(client, makeCfg())
  recordSessionWrite("rw-session-1", "mem-just-written")

  const same = await handler({ prompt: PROMPT }, { sessionId: "rw-session-1" })
  assert.ok(
    same?.prependContext?.includes("nothing shown"),
    "own just-written note does not echo, but the retrieval shape remains visible",
  )
  assert.ok(!same?.prependContext?.includes("mem-just-written"))

  const other = (await handler({ prompt: PROMPT }, { sessionId: "rw-session-2" })) as
    | { prependContext: string }
    | undefined
  assert.ok(other?.prependContext.includes("mem-just-written"), "later/other sessions recall it normally")

  buildAutoContextSessionCleanupHandler()({}, { sessionId: "rw-session-1" })
  buildAutoContextSessionCleanupHandler()({}, { sessionId: "rw-session-2" })
})

test("multi-user ranking parity — chatter is penalized and capped per lane, exactly like single-user", async () => {
	const personal = [
		searchResult({
			resourceId: "note-1",
			title: "Journal — durable note",
			score: 0.75,
			highlights: [{ id: "h", text: "quiet true memory", score: 0.75 }],
		}),
		// Three high-similarity conversation echoes (speaker-role tagged) — the
		// old path injected all of them, quota never consulted.
		...[1, 2, 3].map((i) =>
			searchResult({
				resourceId: `${CHATTER_UUID(i)}`,
				title: `[Dave]: echo ${i}`,
				metaSpeakerRole: "user",
				score: 0.95,
				highlights: [{ id: `h${i}`, text: `echo body ${i}`, score: 0.95 }],
			}),
		),
	]
	const handler = buildAutoContextHandler(
		makeLaneClient(personal, []),
		makeCfg({
			multiUser: MULTI_USER,
			ranking: { ...makeCfg().ranking, enabled: true, chatterQuota: 1, chatterPenalty: 0 },
		}),
	)
	const out = (await handler(
		{ prompt: PROMPT },
		{ senderId: "dave", sessionId: "mu-rank-1" },
	)) as { prependContext: string } | undefined
	assert.ok(out, "injects")
	const echoes = (out.prependContext.match(/echo body/g) ?? []).length
	assert.equal(echoes, 1, "chatter quota (1) enforced in the personal lane")
	assert.match(out.prependContext, /quiet true memory/)
	buildAutoContextSessionCleanupHandler()({}, { sessionId: "mu-rank-1" })
})

test("multi-user ranking parity — C6: a null-doc-score row with strong highlights now surfaces", async () => {
	const personal = [
		searchResult({
			resourceId: "consolidated-1",
			title: "Consolidated session note",
			score: null as never,
			highlights: [{ id: "h", text: "the highlight carries the relevance", score: 0.9 }],
		}),
	]
	const handler = buildAutoContextHandler(
		makeLaneClient(personal, []),
		makeCfg({ multiUser: MULTI_USER, ranking: { ...makeCfg().ranking, enabled: true } }),
	)
	const out = (await handler(
		{ prompt: PROMPT },
		{ senderId: "dave", sessionId: "mu-c6-1" },
	)) as { prependContext: string } | undefined
	assert.ok(
		out?.prependContext.includes("the highlight carries the relevance"),
		"formatHighlightBullets' doc-score gate skipped this row; ranked _base admits it",
	)
	buildAutoContextSessionCleanupHandler()({}, { sessionId: "mu-c6-1" })
})

test("multi-user ranking parity — repeat suppression works across turns in multiUser sessions", async () => {
	const personal = [
		searchResult({
			resourceId: "mu-repeat-note",
			title: "Durable Note",
			score: 0.9,
			highlights: [{ id: "h", text: "important note body", score: 0.9 }],
		}),
	]
	const handler = buildAutoContextHandler(
		makeLaneClient(personal, []),
		makeCfg({ multiUser: MULTI_USER, ranking: { ...makeCfg().ranking, enabled: true } }),
	)
	const ctx = { senderId: "dave", sessionId: "mu-repeat-1" }
	const first = (await handler({ prompt: PROMPT }, ctx)) as { prependContext: string } | undefined
	assert.ok(first?.prependContext.includes("important note body"))
	const second = (await handler({ prompt: PROMPT }, ctx)) as { prependContext: string } | undefined
	// Identity preamble may still inject; the MEMORY must not repeat.
	assert.ok(!second?.prependContext?.includes("important note body"), "no re-injection in-session")
	buildAutoContextSessionCleanupHandler()({}, ctx)
})
