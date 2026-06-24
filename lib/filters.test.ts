import assert from "node:assert/strict"
import { test } from "node:test"
import { EXCLUDE_SESSION_END_FILTER, mergeWithExclude } from "./filters.ts"

test("EXCLUDE_SESSION_END_FILTER — plain $ne agent_end (backend #1921 honors absent-field semantics)", () => {
  // sendTrace tags traces as metadata.openclaw_source = "agent_end". With #1921
  // deployed, $ne follows MongoDB semantics and KEEPS rows whose openclaw_source
  // is absent (untagged hot rows) while dropping only agent_end — verified live.
  assert.deepEqual(EXCLUDE_SESSION_END_FILTER, {
    openclaw_source: { $ne: "agent_end" },
  })
})

test("mergeWithExclude — no base returns the exclude filter alone (applied unconditionally)", () => {
  assert.deepEqual(mergeWithExclude(), EXCLUDE_SESSION_END_FILTER)
  assert.deepEqual(mergeWithExclude(undefined), EXCLUDE_SESSION_END_FILTER)
})

test("mergeWithExclude — base is AND-combined with the exclude", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base), {
    $and: [base, EXCLUDE_SESSION_END_FILTER],
  })
})
