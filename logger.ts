type Logger = {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

let _logger: Logger = console
let _debug = false

export function initLogger(logger: Logger, debug: boolean): void {
  _logger = logger
  _debug = debug
}

export const log = {
  info: (message: string, ...args: unknown[]) => {
    _logger.info(`hyperspell: ${message}`, ...args)
  },
  warn: (message: string, ...args: unknown[]) => {
    _logger.warn(`hyperspell: ${message}`, ...args)
  },
  error: (message: string, ...args: unknown[]) => {
    _logger.error(`hyperspell: ${message}`, ...args)
  },
  debug: (message: string, ...args: unknown[]) => {
    if (_debug) {
      _logger.debug(`hyperspell: ${message}`, ...args)
    }
  },
  /**
   * Operator-meaningful diagnostics (one line per event: injection summaries,
   * cut attribution, ranked tallies). Emits via the host's INFO channel when the
   * plugin's own `debug: true` is set, and stays silent otherwise.
   *
   * Why not `debug`: the host drops plugin debug-channel output from gateway.log
   * even at `logging.level: "debug"` (issue #118 — 2,026 info lines vs zero debug
   * lines, live). The plugin's `debug` flag is explicit operator intent, so these
   * diagnostics must not depend on host debug-channel plumbing. Truly-verbose
   * output (per-request dumps, per-candidate lines) stays on `debug`.
   */
  diag: (message: string, ...args: unknown[]) => {
    if (_debug) {
      _logger.info(`hyperspell: ${message}`, ...args)
    }
  },
  debugRequest: (method: string, params: unknown) => {
    if (_debug) {
      _logger.debug(`hyperspell: [${method}] request`, params)
    }
  },
  debugResponse: (method: string, result: unknown) => {
    if (_debug) {
      _logger.debug(`hyperspell: [${method}] response`, result)
    }
  },
}
