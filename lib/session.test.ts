import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveCurrentSessionId } from "./session.ts"

const UUID = "740cf48a-8ce8-4228-a42a-3476d83d6f10"

test("resolve — explicit event.sessionId wins (what the hot buffer keys rows by)", () => {
  assert.equal(resolveCurrentSessionId({ sessionId: UUID }, {}), UUID)
})

test("resolve — explicit ctx.sessionId is used when event lacks one", () => {
  assert.equal(resolveCurrentSessionId({}, { sessionId: UUID }), UUID)
})

test("resolve — recovers bare id from composite sessionKey :run: suffix", () => {
  const ctx = {
    sessionKey: `agent:main:cron:e75b7ad6-0a02-46ef-b849-53bcd2cd0e1a:run:${UUID}`,
  }
  assert.equal(resolveCurrentSessionId({}, ctx), UUID)
})

test("resolve — bare-UUID sessionKey is accepted", () => {
  assert.equal(resolveCurrentSessionId({}, { sessionKey: UUID }), UUID)
})

test("resolve — non-UUID handle sessionKey yields undefined (won't match any resource_id)", () => {
  // A phone/handle key can't equal a resource_id; returning it would be a
  // value that silently never matches, so we bail to undefined instead.
  assert.equal(resolveCurrentSessionId({}, { sessionKey: "+15551234567" }), undefined)
})

test("resolve — no event/ctx yields undefined (caller must not exclude)", () => {
  assert.equal(resolveCurrentSessionId(undefined, undefined), undefined)
  assert.equal(resolveCurrentSessionId({}, {}), undefined)
})

test("resolve — explicit sessionId preferred over a sessionKey :run: suffix", () => {
  const other = "11111111-2222-3333-4444-555555555555"
  const ctx = { sessionId: UUID, sessionKey: `agent:main:run:${other}` }
  assert.equal(resolveCurrentSessionId({}, ctx), UUID)
})

test("resolve — non-string sessionId/sessionKey is ignored", () => {
  assert.equal(resolveCurrentSessionId({ sessionId: 123 }, { sessionKey: null }), undefined)
})
