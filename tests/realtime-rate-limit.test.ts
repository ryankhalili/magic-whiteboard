import { describe, expect, it } from 'vitest'
import { classifyRealtimeRateLimit, parseRealtimeRetryAfterMs, updateRealtimeRateLimits, type RealtimeRateLimitSnapshot } from '../src/ai/realtime-rate-limit'

const now = 10_000
describe('Realtime rate-limit decisions without requests or timers', () => {
  it('separates token-per-minute limits from API credit and parses only the explicit delay', () => {
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', type: 'tokens', message: 'Rate limit reached for gpt-realtime-mini on tokens per min (TPM): Limit 10000, Used 9972, Requested 4381. Please try again in 25.992s.' })).toEqual({ resource: 'tokens', waitMs: 25_992, canRetry: true, source: 'retry_after' })
  })
  it.each([
    ['Please try again in 250ms.', 250], ['Please retry after 2.5 seconds.', 2500],
    ['Try again in .75s', 750], ['Retry-After: 12', 12_000], ['retry_after=0.5', 500],
    ['Try again in 1 minute and 30 seconds.', 90_000], ['Try again in 1m30s.', 90_000],
    ['Please try again in 2 hours.', 7_200_000], ['Retry after 3s; try again in 4 seconds.', 4000],
    ['Try again in 999999999 seconds.', 86_400_000],
  ])('parses an explicit delay from %s', (message, expected) => {
    expect(parseRealtimeRetryAfterMs(message as string)).toBe(expected)
  })
  it.each(['Limit 10000, used 9999, requested 100', 'Try again in -3s', 'Try again in NaN seconds', 'Try again in Infinity seconds', 'Wait for the next turn', 'Context token limit is 32000'])('does not infer delays from %s', message => {
    expect(parseRealtimeRetryAfterMs(message)).toBeUndefined()
  })
  it.each([
    { status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota.' },
    { status: 429, code: 'billing_hard_limit_reached', message: 'Rate limit reached. Add API credit.' },
    { status: 429, code: 'context_length_exceeded', message: 'Maximum context length is 32000 tokens.' },
    { code: 'rate_limit_exceeded', message: 'The maximum context window contains too many tokens.' },
    { status: 401, code: 'invalid_api_key', message: 'Authentication failed.' },
    { status: 403, code: 'rate_limit_exceeded', message: 'Rate limit reached.' },
    { status: 429, code: 'local_rate_limit', message: 'Please wait before opening another voice session.' },
    { status: 429, message: 'Unknown provider rejection.' },
    { message: 'There are 2000 tokens in this request.' },
    { code: 'server_error', message: 'The rate limit information is unavailable.' },
  ])('does not classify quota, context, authentication, or ambiguous errors as refillable limits: %j', error => {
    expect(classifyRealtimeRateLimit(error)).toBeNull()
  })
  it('defaults a genuine rate-limit rejection to five seconds when no hint is available', () => {
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded' })).toEqual({ resource: 'unknown', waitMs: 5000, canRetry: true, source: 'default' })
    expect(classifyRealtimeRateLimit({ status: 429, message: 'Too many requests' })).toMatchObject({ resource: 'requests', waitMs: 5000 })
  })
  it('reads errors inside both Realtime error events and terminal responses', () => {
    const error = { code: 'rate_limit_exceeded', type: 'requests', message: 'Rate limit reached. Please try again in 1s.' }
    expect(classifyRealtimeRateLimit({ type: 'error', error })).toMatchObject({ resource: 'requests', waitMs: 1000 })
    expect(classifyRealtimeRateLimit({ type: 'response.done', response: { status_details: { error } } })).toMatchObject({ resource: 'requests', waitMs: 1000 })
  })
  it('preserves structured Error fields and gives explicit retry hints precedence over generic resets', () => {
    const error = Object.assign(new Error('Rate limit reached. Please try again in 1s.'), { code: 'rate_limit_exceeded', retryAfterMs: 3500 })
    expect(classifyRealtimeRateLimit(error, { tokens: { remaining: 0, resetAtMs: now + 30_000 } }, now)).toMatchObject({ waitMs: 3500, source: 'retry_after' })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', retry_after: 2.5 })).toMatchObject({ waitMs: 2500 })
  })
  it('uses a resource-specific reset even when reserved token accounting reports positive remaining', () => {
    const limits: RealtimeRateLimitSnapshot = { tokens: { remaining: 300, resetAtMs: now + 12_000 }, requests: { remaining: 0, resetAtMs: now + 55_000 } }
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', type: 'tokens' }, limits, now)).toEqual({ resource: 'tokens', waitMs: 12_000, canRetry: true, source: 'reset' })
  })
  it('uses only exhausted counters when the limiting resource is unknown', () => {
    const limits = { tokens: { remaining: 0, resetAtMs: now + 2000 }, requests: { remaining: 10, resetAtMs: now + 50_000 } }
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded' }, limits, now)).toMatchObject({ waitMs: 2000, source: 'reset' })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded' }, limits, now + 3000)).toMatchObject({ waitMs: 5000, source: 'default' })
  })
  it('never automatically retries earlier than an explicit wait exceeding the one-minute ceiling', () => {
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', message: 'Try again in 1m30s' })).toMatchObject({ waitMs: 60_000, canRetry: false })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', retryAfterMs: 60_000 })).toMatchObject({ waitMs: 60_000, canRetry: true })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', retryAfterMs: 60_001 })).toMatchObject({ waitMs: 60_000, canRetry: false })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', retryAfterMs: 0 })).toMatchObject({ waitMs: 1000, canRetry: true })
  })
  it('declines automatic retry for nonrefillable oversized requests and explicit nonretryable responses', () => {
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', message: 'Request too large for gpt-realtime-mini on tokens per min: limit 1000 requested 2000.' })).toMatchObject({ resource: 'tokens', canRetry: false })
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded', retryable: false })).toMatchObject({ canRetry: false })
  })
})

describe('Realtime rate-limit snapshots', () => {
  it('records absolute reset deadlines without mutating prior state', () => {
    const before: RealtimeRateLimitSnapshot = { requests: { remaining: 2, resetAtMs: now + 10_000 } }
    const after = updateRealtimeRateLimits(before, { type: 'rate_limits.updated', rate_limits: [{ name: 'tokens', remaining: 0, limit: 10000, reset_seconds: 12.5 }] }, now)
    expect(after).toEqual({ requests: before.requests, tokens: { remaining: 0, limit: 10000, resetAtMs: now + 12_500 } })
    expect(before).not.toHaveProperty('tokens')
    expect(classifyRealtimeRateLimit({ type: 'rate_limits.updated', rate_limits: [] }, after, now)).toBeNull()
  })
  it('updates counters after output reservations are released and expires old snapshots', () => {
    const old: RealtimeRateLimitSnapshot = { tokens: { remaining: 0, resetAtMs: now - 1 }, requests: { remaining: 0, resetAtMs: now + 1000 } }
    const after = updateRealtimeRateLimits(old, { type: 'rate_limits.updated', rate_limits: [{ name: 'requests', remaining: 4, reset_seconds: 0.5 }] }, now)
    expect(after).toEqual({ requests: { remaining: 4, resetAtMs: now + 500 } })
    expect(updateRealtimeRateLimits(after, {}, now + 600)).toEqual({})
  })
  it('ignores malformed, negative, infinite, and unsupported counters', () => {
    expect(updateRealtimeRateLimits({}, { type: 'rate_limits.updated', rate_limits: [
      { name: 'tokens', remaining: NaN, reset_seconds: 3 }, { name: 'tokens', remaining: 0, reset_seconds: Infinity },
      { name: 'requests', remaining: -1, reset_seconds: 3 }, { name: 'requests', remaining: 2, reset_seconds: -3 },
      { name: 'images', remaining: 0, reset_seconds: 4 }, { name: 'tokens', remaining: '0', reset_seconds: 2 }, null,
    ] }, now)).toEqual({})
    expect(updateRealtimeRateLimits({}, { rate_limits: [{ name: 'tokens', remaining: 0, reset_seconds: 10 }] }, now)).toEqual({})
  })
  it('bounds enormous reset horizons and does not retry them automatically', () => {
    const limits = updateRealtimeRateLimits({}, { type: 'rate_limits.updated', rate_limits: [{ name: 'tokens', remaining: 0, reset_seconds: 1e100 }] }, now)
    expect(limits.tokens?.resetAtMs).toBe(now + 86_400_000)
    expect(classifyRealtimeRateLimit({ code: 'rate_limit_exceeded' }, limits, now)).toMatchObject({ canRetry: false, waitMs: 60_000 })
  })
})
