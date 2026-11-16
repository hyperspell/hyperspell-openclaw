type Logger = {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

let _logger: Logger = console
let _debug = false

/** Bound on the folded detail: a 422 body can echo the whole rejected input. */
const MAX_DETAIL_CHARS = 500

function detailText(arg: unknown): string {
  if (arg instanceof Error) return arg.message
  if (typeof arg === "string") return arg
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}

/**
 * The host's plugin logger takes the message string only (openclaw
 * `PluginLogger`: `(message: string) => void`) and discards further arguments,
 * so a caught error passed after the message never reaches gateway.log and the
 * line says only that something failed. Fold the details into the line itself.
 */
function withDetails(message: string, args: unknown[]): string {
  if (args.length === 0) return `hyperspell: ${message}`
  const detail = args.map(detailText).join(" ")
  const bounded =
    detail.length > MAX_DETAIL_CHARS
      ? `${detail.slice(0, MAX_DETAIL_CHARS)}… (${detail.length} chars)`
      : detail
  return `hyperspell: ${message}: ${bounded}`
}

export function initLogger(logger: Logger, debug: boolean): void {
  _logger = logger
  _debug = debug
}

export const log = {
  info: (message: string, ...args: unknown[]) => {
    _logger.info(withDetails(message, args))
  },
  warn: (message: string, ...args: unknown[]) => {
    _logger.warn(withDetails(message, args))
  },
  error: (message: string, ...args: unknown[]) => {
    _logger.error(withDetails(message, args))
  },
  debug: (message: string, ...args: unknown[]) => {
    if (_debug) {
      _logger.debug(withDetails(message, args))
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
      _logger.info(withDetails(message, args))
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
