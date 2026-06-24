import assert from "node:assert/strict"
import { test } from "node:test"
import type { SearchResult } from "../client.ts"
import { dropCurrentSession } from "./auto-context.ts"

function result(resourceId: string): SearchResult {
  return {
    resourceId,
    title: null,
    source: "vault",
    score: 0.9,
    url: null,
    createdAt: null,
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
