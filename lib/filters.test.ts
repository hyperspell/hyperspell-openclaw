import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EXCLUDE_SESSION_END_FILTER,
  excludeFilterFor,
  mergeWithExclude,
} from "./filters.ts"

const ON = { autoTrace: { enabled: true } }
const OFF = { autoTrace: { enabled: false } }

test("EXCLUDE_SESSION_END_FILTER — plain $ne agent_end (the only shape the backend honors)", () => {
  // sendTrace tags traces as metadata.openclaw_source = "agent_end". A $exists/$or
  // "tolerant" form was tried to also admit untagged hot-buffer rows, but the live
  // backend returns 0 rows for $or/$exists (see docs/filter-dialect-test.mjs), so
  // we keep the plain $ne and rely on excludeFilterFor's gate to keep hot rows.
  assert.deepEqual(EXCLUDE_SESSION_END_FILTER, {
    openclaw_source: { $ne: "agent_end" },
  })
})

test("excludeFilterFor — applies the exclude only when auto-trace is on (Option 4)", () => {
  // agent_end rows are written ONLY by the auto-trace hook; with it disabled there
  // are none to hide, so we skip the filter entirely. That's also the ONLY way to
  // keep untagged hot-buffer rows visible — no filter and no write-tag can.
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
