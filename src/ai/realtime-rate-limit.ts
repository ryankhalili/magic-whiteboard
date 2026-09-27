export type RealtimeRateResource = 'tokens' | 'requests'
export type RealtimeRateLimits = Partial<Record<RealtimeRateResource, {
  remaining: number; resetAtMs: number; limit?: number;
}>>
export type RealtimeRateLimitSnapshot = RealtimeRateLimits
export type RealtimeRateLimitDecision = {
  resource: RealtimeRateResource | 'unknown'; waitMs: number; canRetry: boolean;
  source: 'retry_after' | 'reset' | 'default';
}
const MAX_WAIT_MS = 60_000
const MAX_HINT_MS = 24 * 60 * 60_000
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const boundedHint = (milliseconds: number) => Math.min(MAX_HINT_MS, milliseconds)

/** Keep only well-formed provider counters; this is state, not a retry trigger. */
export function updateRealtimeRateLimits(previous: RealtimeRateLimits, event: unknown, nowMs = Date.now()): RealtimeRateLimits {
  const result: RealtimeRateLimits = {}
  if (!Number.isFinite(nowMs)) return result
  for (const name of ['tokens', 'requests'] as const) {
    const value = previous[name]
    if (value && value.resetAtMs > nowMs && finiteNonnegative(value.remaining) && Number.isFinite(value.resetAtMs)) result[name] = { ...value }
  }
  const update = record(event)
  if (update.type !== 'rate_limits.updated' || !Array.isArray(update.rate_limits)) return result
  for (const value of update.rate_limits.slice(0, 16)) {
    const limit = record(value), name = limit.name
    if (name !== 'tokens' && name !== 'requests') continue
    if (!finiteNonnegative(limit.remaining) || !finiteNonnegative(limit.reset_seconds)) continue
    result[name] = { remaining: limit.remaining, resetAtMs: nowMs + boundedHint(limit.reset_seconds * 1000),
      ...(finiteNonnegative(limit.limit) ? { limit: limit.limit } : {}) }
  }
  return result
}

/** Parse only an explicit retry hint, never the Limit/Used/Requested token counts. */
export function parseRealtimeRetryAfterMs(message: string): number | undefined {
  const source = message.slice(0, 8000)
  const marker = /\b(?:try\s+again\s+(?:in|after)|retry(?:\s+again)?\s+(?:in|after)|retry[-_ ]after\s*[:=]?)\s*/ig
  let result: number | undefined, match: RegExpExecArray | null
  while ((match = marker.exec(source))) {
    let rest = source.slice(marker.lastIndex), total = 0, parts = 0
    for (let index = 0; index < 4; index++) {
      const duration = /^(\d+(?:\.\d+)?|\.\d+)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?=$|\s|[.,;!?]|\d)/i.exec(rest)
      if (!duration) break
      const value = Number(duration[1]), unit = duration[2].toLowerCase()
      const multiplier = unit === 'ms' || unit.startsWith('millisecond') ? 1 : unit === 'm' || unit.startsWith('min') ? 60_000 : unit === 'h' || unit.startsWith('h') ? 3_600_000 : 1000
      total += value * multiplier; parts++
      rest = rest.slice(duration[0].length).replace(/^\s*(?:,\s*)?(?:and\s+)?/i, '')
    }
    // Retry-After header-like text uses seconds when the unit is omitted.
    if (!parts && /retry[-_ ]after/i.test(match[0])) {
      const seconds = /^(\d+(?:\.\d+)?|\.\d+)(?=$|\s|[.,;!?])/.exec(rest)
      if (seconds) { total = Number(seconds[1]) * 1000; parts = 1 }
    }
    if (parts && Number.isFinite(total)) result = Math.max(result ?? 0, boundedHint(total))
  }
  return result
}

/** Decide a single same-session wait. The caller owns cancellation and replay safety. */
export function classifyRealtimeRateLimit(error: unknown, limits: RealtimeRateLimits = {}, nowMs = Date.now()): RealtimeRateLimitDecision | null {
  const outer = record(error), response = record(outer.response), details = record(response.status_details)
  const nested = record(outer.error), nestedResponse = record(details.error)
  const data = Object.keys(nested).length ? nested : Object.keys(nestedResponse).length ? nestedResponse : outer
  const code = typeof data.code === 'string' ? data.code.trim().toLowerCase() : ''
  const type = typeof data.type === 'string' ? data.type.trim().toLowerCase() : ''
  const message = (typeof data.message === 'string' ? data.message : typeof error === 'string' ? error : error instanceof Error ? error.message : '').slice(0, 8000)
  const text = `${code} ${type} ${message}`
  const status = finiteNonnegative(data.status) ? data.status : outer.status
  // A 429 can also mean exhausted credit. Context-size failures mention tokens
  // too, but waiting cannot make either case safe to resend.
  if (status === 401 || status === 403 || /insufficient_quota|billing_hard_limit|billing_not_active|credit|quota|balance|budget|allowance|authentication|unauthorized|permission|invalid.api.key|context[_ -]?(?:length|window)|maximum context|too many (?:input )?tokens|local_rate_limit/i.test(text)) return null
  const exactCode = ['rate_limit_exceeded', 'rate_limit_error', 'rate_limit', 'requests_limit_exceeded', 'tokens_limit_exceeded'].includes(code)
  const namedLimit = /\brate[ _-]limit[ _-](?:exceeded|reached|error)\b|too many requests/i.test(message)
  if (!exactCode && !namedLimit) return null
  let resource: RealtimeRateResource | 'unknown' = 'unknown'
  if (type === 'tokens' || /tokens_limit|tokens? per min|tokens?\s*\/\s*min|\btpm\b/i.test(text)) resource = 'tokens'
  else if (type === 'requests' || /requests_limit|requests? per min|requests?\s*\/\s*min|\brpm\b/i.test(text)) resource = 'requests'
  else if (/\btokens?\b/i.test(message)) resource = 'tokens'
  else if (/\brequests?\b/i.test(message)) resource = 'requests'
  const hints = [data.retryAfterMs, outer.retryAfterMs].filter(finiteNonnegative).map(boundedHint)
  if (finiteNonnegative(data.retry_after)) hints.push(boundedHint(data.retry_after * 1000))
  const inMessage = parseRealtimeRetryAfterMs(message)
  if (inMessage !== undefined) hints.push(inMessage)
  let delay = hints.length ? Math.max(...hints) : undefined
  let source: RealtimeRateLimitDecision['source'] = 'retry_after'
  if (delay === undefined && Number.isFinite(nowMs)) {
    const resets = (resource === 'unknown' ? ['tokens', 'requests'] as const : [resource]).flatMap(name => {
      const value = limits[name]
      return value && (resource !== 'unknown' || value.remaining <= 0) && Number.isFinite(value.resetAtMs) && value.resetAtMs > nowMs ? [value.resetAtMs - nowMs] : []
    })
    if (resets.length) { delay = Math.max(...resets); source = 'reset' }
  }
  if (delay === undefined) { delay = 5000; source = 'default' }
  const cannotFit = /request too large|requested.*exceeds.*(?:rate|token).*limit/i.test(message)
  return { resource, waitMs: Math.min(MAX_WAIT_MS, Math.max(1000, Math.ceil(delay))),
    canRetry: delay <= MAX_WAIT_MS && data.retryable !== false && !cannotFit, source }
}
