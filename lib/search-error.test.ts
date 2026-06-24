import assert from "node:assert/strict"
import { test } from "node:test"
import {
  classifySearchError,
  logSearchError,
  searchErrorToolText,
} from "./search-error.ts"

/** Minimal stand-in for the SDK's APIError (status + Headers). */
function apiError(status: number, headers?: Record<string, string>) {
  const err = new Error(`${status} error`) as Error & {
    status: number
    headers?: Headers
  }
  err.status = status
  if (headers) err.headers = new Headers(headers)
  return err
}

test("classify — 429 with Retry-After is throttled, seconds parsed", () => {
  const info = classifySearchError(apiError(429, { "retry-after": "55" }))
  assert.equal(info.kind, "throttled")
  assert.equal(info.status, 429)
  assert.equal(info.retryAfterSeconds, 55)
})

test("classify — 429 with no Retry-After is still throttled", () => {
  const info = classifySearchError(apiError(429))
  assert.equal(info.kind, "throttled")
  assert.equal(info.retryAfterSeconds, undefined)
})

test("classify — 5xx carrying Retry-After is throttled (backend sheds load via 5xx)", () => {
  // Issue #39: the backend attaches Retry-After to the 5xx it sheds under load.
  const info = classifySearchError(apiError(503, { "retry-after": "30" }))
  assert.equal(info.kind, "throttled")
  assert.equal(info.status, 503)
  assert.equal(info.retryAfterSeconds, 30)
})

test("classify — 5xx without Retry-After is transient", () => {
  const info = classifySearchError(apiError(500))
  assert.equal(info.kind, "transient")
  assert.equal(info.status, 500)
})

test("classify — 4xx is a permanent client error (no retry)", () => {
  const info = classifySearchError(apiError(422))
  assert.equal(info.kind, "client")
  assert.equal(info.status, 422)
})

test("classify — network/abort error (no status) is unknown", () => {
  const info = classifySearchError(new Error("socket hang up"))
  assert.equal(info.kind, "unknown")
  assert.equal(info.status, undefined)
  assert.equal(info.detail, "socket hang up")
})

test("classify — Retry-After as HTTP-date is converted to seconds", () => {
  const future = new Date(Date.now() + 40_000).toUTCString()
  const info = classifySearchError(apiError(429, { "retry-after": future }))
  assert.equal(info.kind, "throttled")
  // ~40s, allow scheduling jitter.
  assert.ok(
    info.retryAfterSeconds !== undefined &&
      info.retryAfterSeconds >= 35 &&
      info.retryAfterSeconds <= 41,
    `expected ~40s, got ${info.retryAfterSeconds}`,
  )
})

test("classify — tolerates a plain headers object (not a Headers instance)", () => {
  const err = { status: 429, headers: { "retry-after": "12" } }
  const info = classifySearchError(err)
  assert.equal(info.kind, "throttled")
  assert.equal(info.retryAfterSeconds, 12)
})

test("toolText — throttle tells the agent it is NOT an empty memory", () => {
  const text = searchErrorToolText({
    kind: "throttled",
    status: 429,
    retryAfterSeconds: 55,
    detail: "x",
  })
  assert.match(text, /rate-limited/)
  assert.match(text, /~55s/)
  assert.match(text, /NOT an empty memory/)
})

test("toolText — transient tells the agent it is NOT an empty memory", () => {
  const text = searchErrorToolText({ kind: "transient", status: 500, detail: "x" })
  assert.match(text, /NOT an empty memory/)
  assert.match(text, /500/)
})

test("toolText — client/unknown surface the raw detail", () => {
  assert.match(
    searchErrorToolText({ kind: "client", status: 422, detail: "missing X-As-User" }),
    /Search failed: missing X-As-User/,
  )
  assert.match(
    searchErrorToolText({ kind: "unknown", detail: "socket hang up" }),
    /Search failed: socket hang up/,
  )
})

test("logSearchError — throttle/transient log at warn, real errors at error", () => {
  const warns: string[] = []
  const errors: string[] = []
  const fakeLog = {
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  }

  logSearchError(fakeLog, "ctx", { kind: "throttled", status: 429, retryAfterSeconds: 55, detail: "x" }, {})
  logSearchError(fakeLog, "ctx", { kind: "transient", status: 500, detail: "x" }, {})
  logSearchError(fakeLog, "ctx", { kind: "client", status: 422, detail: "x" }, {})

  assert.equal(warns.length, 2)
  assert.equal(errors.length, 1)
  assert.match(warns[0], /retry-after≈55s/)
})
