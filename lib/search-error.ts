/**
 * Shared classification of read-path (search/retrieval) failures, used by every
 * retrieval path (the `hyperspell_search` tool + the auto-context hook) so both
 * surface a transient backend throttle the same way — mirroring how
 * `lib/filters.ts` keeps filtering consistent across them.
 *
 * Why this exists (issue #39): under load the Hyperspell backend sheds requests
 * with a `Retry-After` header advertising a multi-second cooldown (~55s observed)
 * — surfaced as a 429 and, when shedding hard, attached to 5xx responses too.
 * The `hyperspell` SDK already retries 429/5xx with bounded exponential backoff
 * (maxRetries=2), but no in-turn backoff can ride out a ~55s cooldown, so the
 * call still throws. The bug is what happens NEXT: the read path collapsed the
 * error to "Search failed" / injected nothing, so a session reads it as "no
 * memories" and confabulates around an empty result.
 *
 * The fix is to DISTINGUISH a throttle (429 / `Retry-After`) from a generic
 * transient 5xx and a permanent 4xx, surface it EXPLICITLY to the agent, and log
 * it at `warn` with the cooldown so the throttle is observable. We deliberately
 * do NOT add our own retry — the SDK already does, and a longer in-turn sleep
 * would just hang the turn.
 */

export type SearchErrorKind =
  /** 429, or any status carrying a `Retry-After` — backend cooldown window. */
  | "throttled"
  /** 5xx without `Retry-After` — a transient server error (SDK already retried). */
  | "transient"
  /** 4xx — a real, permanent error (e.g. 422 missing X-As-User). Don't retry. */
  | "client"
  /** No HTTP status (network/abort) or anything unclassifiable. */
  | "unknown"

export interface SearchErrorInfo {
  kind: SearchErrorKind
  /** HTTP status, when the error carried one. */
  status?: number
  /** Parsed `Retry-After` in seconds, when present and parseable. */
  retryAfterSeconds?: number
  /** Raw error message — for logs and for surfacing client/unknown failures. */
  detail: string
}

/** Pull a numeric HTTP status off an unknown thrown value (SDK `APIError.status`). */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === "number" ? s : undefined
}

/**
 * Read the `Retry-After` header (in seconds) off a thrown SDK `APIError`.
 * `APIError.headers` is a `Headers` instance; we also tolerate a plain object so
 * this stays robust to SDK shape changes and is trivial to unit-test. Per RFC,
 * `Retry-After` is either delta-seconds or an HTTP-date — handle both.
 */
function retryAfterSecondsOf(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers
  let raw: string | null | undefined
  if (headers && typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after")
  } else if (headers && typeof headers === "object") {
    const obj = headers as Record<string, string>
    raw = obj["retry-after"] ?? obj["Retry-After"]
  }
  if (!raw) return undefined

  const asSeconds = Number(raw)
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds))

  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, Math.round((asDate - Date.now()) / 1000))
  }
  return undefined
}

export function classifySearchError(err: unknown): SearchErrorInfo {
  const status = statusOf(err)
  const retryAfterSeconds = retryAfterSecondsOf(err)
  const detail = err instanceof Error ? err.message : String(err)

  // A 429, or any status carrying Retry-After (the backend attaches it to the
  // 5xx it sheds under load too), means an active cooldown window — flag it as
  // a throttle regardless of the exact status code.
  if (status === 429 || retryAfterSeconds !== undefined) {
    return { kind: "throttled", status, retryAfterSeconds, detail }
  }
  if (status !== undefined && status >= 500) {
    return { kind: "transient", status, detail }
  }
  if (status !== undefined && status >= 400) {
    return { kind: "client", status, detail }
  }
  return { kind: "unknown", detail }
}

/**
 * Agent-facing text for a failed `hyperspell_search` tool call. For a throttle or
 * transient error the wording is deliberate: it tells the agent this is a backend
 * condition and NOT an empty memory, so it doesn't conclude "nothing was found"
 * (issue #39's core symptom).
 */
export function searchErrorToolText(info: SearchErrorInfo): string {
  switch (info.kind) {
    case "throttled": {
      const when =
        info.retryAfterSeconds !== undefined
          ? ` (retry in ~${info.retryAfterSeconds}s)`
          : ""
      return `Memory search is temporarily rate-limited by the backend${when}. This is a transient throttle, NOT an empty memory — do not conclude nothing was found; try again shortly.`
    }
    case "transient":
      return `Memory search hit a transient backend error (HTTP ${info.status}) and automatic retries were exhausted. This is NOT an empty memory — do not conclude nothing was found; try again shortly.`
    default:
      return `Search failed: ${info.detail}`
  }
}

/** One-line summary for logs. */
function summarize(info: SearchErrorInfo): string {
  const parts = [`kind=${info.kind}`]
  if (info.status !== undefined) parts.push(`status=${info.status}`)
  if (info.retryAfterSeconds !== undefined)
    parts.push(`retry-after≈${info.retryAfterSeconds}s`)
  return parts.join(" ")
}

/**
 * Log a read-path failure consistently across both retrieval paths. Throttles and
 * transient 5xx are expected-under-load and log at `warn` (with the cooldown, so
 * blips are observable); genuine errors log at `error` with the raw cause.
 */
export function logSearchError(
  log: {
    warn: (msg: string, ...args: unknown[]) => void
    error: (msg: string, ...args: unknown[]) => void
  },
  where: string,
  info: SearchErrorInfo,
  err: unknown,
): void {
  if (info.kind === "throttled" || info.kind === "transient") {
    log.warn(`${where}: backend unavailable — ${summarize(info)}`)
  } else {
    log.error(`${where} failed (${summarize(info)})`, err)
  }
}
