import assert from "node:assert/strict"
import { test } from "node:test"
import { excludeFilterFor, mergeWithExclude } from "./filters.ts"

const BOTH_OFF = { autoTrace: { enabled: false }, emotionalContext: false, moodWeatherChance: 0 }
const TRACE_ON = { autoTrace: { enabled: true }, emotionalContext: false, moodWeatherChance: 0 }
const MOOD_ON = { autoTrace: { enabled: false }, emotionalContext: true, moodWeatherChance: 0.1 }
const BOTH_ON = { autoTrace: { enabled: true }, emotionalContext: true, moodWeatherChance: 0.1 }

test("excludeFilterFor — both features off applies no filter (no rows to hide, skip the ~1s predicate)", () => {
  assert.equal(excludeFilterFor(BOTH_OFF), undefined)
})

test("excludeFilterFor — auto-trace only keeps the shipped single-$ne shape byte-identical", () => {
  // agent_end rows are written ONLY by the auto-trace hook. The plain $ne is
  // the proven shape (see docs/filter-dialect-test.mjs); existing auto-trace
  // users must see zero change from the list-driven rewrite.
  assert.deepEqual(excludeFilterFor(TRACE_ON), {
    openclaw_source: { $ne: "agent_end" },
  })
})

test("excludeFilterFor — mood weather only excludes mood_weather with the same single-$ne shape", () => {
  assert.deepEqual(excludeFilterFor(MOOD_ON), {
    openclaw_source: { $ne: "mood_weather" },
  })
})

test("excludeFilterFor — both features on uses $nin over both tags", () => {
  // ⚠️ $nin awaits live post-#1921 verification — see excludeFilterFor's
  // docblock and the probe rows in docs/filter-dialect-test.mjs.
  assert.deepEqual(excludeFilterFor(BOTH_ON), {
    openclaw_source: { $nin: ["agent_end", "mood_weather"] },
  })
})

test("excludeFilterFor — mood gate requires BOTH emotionalContext and a live chance", () => {
  // Rolls are recorded only when the emotional-context handler is registered
  // AND moodWeatherChance > 0 — either alone writes no rows, so no filter.
  assert.equal(excludeFilterFor({ ...MOOD_ON, emotionalContext: false }), undefined)
  assert.equal(excludeFilterFor({ ...MOOD_ON, moodWeatherChance: 0 }), undefined)
})

test("mergeWithExclude — exclude ON, no base returns the exclude filter alone", () => {
  assert.deepEqual(mergeWithExclude(undefined, TRACE_ON), {
    openclaw_source: { $ne: "agent_end" },
  })
})

test("mergeWithExclude — exclude ON, base is AND-combined with the exclude", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base, BOTH_ON), {
    $and: [base, { openclaw_source: { $nin: ["agent_end", "mood_weather"] } }],
  })
})

test("mergeWithExclude — everything off passes the base through untouched", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base, BOTH_OFF), base)
  assert.equal(mergeWithExclude(undefined, BOTH_OFF), undefined)
})
