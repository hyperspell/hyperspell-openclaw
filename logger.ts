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
