import assert from "node:assert/strict"
import { test } from "node:test"
import { EXCLUDE_SESSION_END_FILTER, mergeWithExclude } from "./filters.ts"

test("EXCLUDE_SESSION_END_FILTER — matches the real trace tag (metadata key + value)", () => {
  // sendTrace tags traces as metadata.openclaw_source = "agent_end"; the filter
  // must target that bare key/value, not top-level `source`/`openclaw_agent_end`.
  assert.deepEqual(EXCLUDE_SESSION_END_FILTER, {
    openclaw_source: { $ne: "agent_end" },
  })
})

test("mergeWithExclude — no base returns the exclude filter alone", () => {
  assert.deepEqual(mergeWithExclude(), EXCLUDE_SESSION_END_FILTER)
  assert.deepEqual(mergeWithExclude(undefined), EXCLUDE_SESSION_END_FILTER)
})

test("mergeWithExclude — base is AND-combined with the exclude", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base), {
    $and: [base, EXCLUDE_SESSION_END_FILTER],
  })
})
