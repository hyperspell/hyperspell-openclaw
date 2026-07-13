import assert from "node:assert/strict"
import { test } from "node:test"
import { initLogger, log } from "./logger.ts"

type Captured = { info: string[]; debug: string[] }

function capture(): { logger: Parameters<typeof initLogger>[0]; seen: Captured } {
  const seen: Captured = { info: [], debug: [] }
  return {
    logger: {
      info: (msg: string) => seen.info.push(msg),
      warn: () => {},
      error: () => {},
      debug: (msg: string) => seen.debug.push(msg),
    },
    seen,
  }
}

// log.diag exists so operator-meaningful one-line diagnostics survive the host
// dropping the plugin debug channel from gateway.log (issue #118): with the
// plugin's own debug flag on, they must go out via INFO — never debug.
test("log.diag — emits via the info channel when debug is enabled", () => {
  const { logger, seen } = capture()
  initLogger(logger, true)
  try {
    log.diag("auto-context: cut 2 of 5 candidates")
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(seen.info, ["hyperspell: auto-context: cut 2 of 5 candidates"])
  assert.deepEqual(seen.debug, [], "diag never touches the debug channel")
})

test("log.diag — fully silent when debug is disabled", () => {
  const { logger, seen } = capture()
  initLogger(logger, false)
  try {
    log.diag("auto-context: cut 2 of 5 candidates")
  } finally {
    initLogger(console, false)
  }
  assert.deepEqual(seen.info, [])
  assert.deepEqual(seen.debug, [])
})
