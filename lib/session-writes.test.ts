import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearSessionWrites,
  recordSessionWrite,
  sessionWrittenIds,
} from "./session-writes.ts";

test("session-writes — records per session, undefined session is a no-op, clear removes", () => {
  recordSessionWrite("s1", "r1");
  recordSessionWrite("s1", "r2");
  recordSessionWrite("s2", "r3");
  recordSessionWrite(undefined, "r-ignored");
  assert.deepEqual([...(sessionWrittenIds("s1") ?? [])], ["r1", "r2"]);
  assert.deepEqual([...(sessionWrittenIds("s2") ?? [])], ["r3"]);
  assert.equal(sessionWrittenIds(undefined), undefined);
  clearSessionWrites("s1");
  assert.equal(sessionWrittenIds("s1"), undefined);
});
