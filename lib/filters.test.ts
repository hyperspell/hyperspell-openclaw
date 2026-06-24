import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EXCLUDE_SESSION_END_FILTER,
  excludeFilterFor,
  mergeWithExclude,
} from "./filters.ts"

const ON = { autoTrace: { enabled: true } }
const OFF = { autoTrace: { enabled: false } }

test("EXCLUDE_SESSION_END_FILTER — hides agent_end traces but tolerates untagged rows (issue #40)", () => {
  // sendTrace tags traces as metadata.openclaw_source = "agent_end". The filter
  // must exclude those, while still admitting rows with NO openclaw_source
  // (e.g. hot-buffer /messages rows) — which a bare { $ne } would silently drop
  // under the backend's SQL NULL semantics.
  assert.deepEqual(EXCLUDE_SESSION_END_FILTER, {
    $or: [
      { openclaw_source: { $exists: false } },
      { openclaw_source: { $ne: "agent_end" } },
    ],
  })
})

test("excludeFilterFor — applies the exclude only when auto-trace is on (Option 4)", () => {
  // agent_end rows are written ONLY by the auto-trace hook; with it disabled
  // there are none to hide, so we skip the filter entirely — which also keeps
  // untagged hot-buffer rows visible regardless of backend $exists support.
  assert.deepEqual(excludeFilterFor(ON), EXCLUDE_SESSION_END_FILTER)
  assert.equal(excludeFilterFor(OFF), undefined)
})

test("mergeWithExclude — auto-trace ON, no base returns the exclude filter alone", () => {
  assert.deepEqual(mergeWithExclude(undefined, ON), EXCLUDE_SESSION_END_FILTER)
})

test("mergeWithExclude — auto-trace ON, base is AND-combined with the exclude", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base, ON), {
    $and: [base, EXCLUDE_SESSION_END_FILTER],
  })
})

test("mergeWithExclude — auto-trace OFF passes the base through untouched", () => {
  const base = { openclaw_scope: { $in: ["family"] } }
  assert.deepEqual(mergeWithExclude(base, OFF), base)
  assert.equal(mergeWithExclude(undefined, OFF), undefined)
})
