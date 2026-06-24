import assert from "node:assert/strict"
import { test } from "node:test"
import { EXCLUDE_SESSION_END_FILTER, mergeWithExclude } from "./filters.ts"

test("EXCLUDE_SESSION_END_FILTER — plain $ne agent_end (MongoDB absent-field semantics via #1921)", () => {
  // sendTrace tags traces as metadata.openclaw_source = "agent_end". With the
  // backend following MongoDB semantics ($ne matches absent fields), this plain
  // filter keeps untagged + hot-buffer rows and drops only agent_end traces.
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
