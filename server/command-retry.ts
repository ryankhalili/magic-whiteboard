/** Application retries own the budget; callers must disable SDK retries. */
export type RetryClassification = { retryable: boolean; code: string; retryAfterMs?: number }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function header(headers: unknown, key: string): string | null {
  if (headers instanceof Headers) return headers.get(key)
  const entry = Object.entries(record(headers)).find(([name]) => name.toLowerCase() === key)
  return entry ? String(entry[1]) : null
}
export function classifyCommandFailure(error: unknown, now = Date.now()): RetryClassification {
  const outer = record(error), inner = record(outer.error), cause = record(outer.cause)
  const status = Number(outer.status), code = String(outer.code ?? inner.code ?? ''), kind = String(outer.type ?? inner.type ?? '')
  if (outer.name === 'AbortError' || outer.name === 'APIUserAbortError') return { retryable: false, code: 'cancelled' }
  if (status === 401 || status === 403 || /invalid_api_key|authentication|permission/i.test(code)) return { retryable: false, code: 'authentication' }
  if (/quota|billing|credit|spend_limit|usage_limit/i.test(`${code} ${kind}`)
    || (status === 429 && /quota|billing|credit balance|usage limit/i.test(String(inner.message ?? outer.message ?? '')))) return { retryable: false, code: 'quota' }
  const retryable = [408, 409, 429, 500, 502, 503, 504].includes(status)
    || ['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError'].includes(String(outer.name))
    || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH'].includes(String(outer.code ?? cause.code))
  const delay = header(outer.headers, 'retry-after')
  let retryAfterMs: number | undefined
  if (delay !== null && delay.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(delay.trim())) retryAfterMs = Number(delay) * 1000
    else { const date = Date.parse(delay); if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - now) }
  }
  if (retryAfterMs !== undefined && !Number.isFinite(retryAfterMs)) retryAfterMs = Number.MAX_SAFE_INTEGER
  return { retryable, code: status === 429 ? 'rate_limit' : retryable ? 'temporary_failure' : 'upstream_failure', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

export class CommandRecoveryError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) { super(message); this.name = 'CommandRecoveryError' }
}

export function publicCommandError(error: unknown): CommandRecoveryError {
  if (error instanceof CommandRecoveryError) return error
  const info = classifyCommandFailure(error)
  const message = info.code === 'authentication' ? 'The API key is invalid, expired, or cannot access this model.'
    : info.code === 'quota' ? 'The API credit or usage limit has been reached. Check the project balance.'
    : info.code === 'cancelled' ? 'The request was cancelled.'
    : info.code === 'rate_limit' ? 'The AI is temporarily rate limited. Please wait before trying again.'
    : 'The AI request could not finish. Your board has not changed; please try again.'
  // keep the transient flag so a voice reconnect retries a blip instead of ending
  return new CommandRecoveryError(message, info.code, info.retryable)
}

export type RetryOptions = {
  signal?: AbortSignal; timeoutMs?: number; attemptTimeoutMs?: number; maxAttempts?: number
  onAttempt?: () => void; now?: () => number; random?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}
function aborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('The request was cancelled.', 'AbortError')
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) }
    operation.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
  })
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
  })
}

/** One shared transport/elapsed-time budget across the initial response and its correction. */
export function createCommandRetryBudget(options: RetryOptions = {}) {
  const now = options.now ?? Date.now, random = options.random ?? Math.random
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 30_000))
  const attemptTimeout = Math.max(1, Math.min(options.attemptTimeoutMs ?? 20_000, 25_000))
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 3)), deadline = now() + timeout
  let attempts = 0
  const deadlineController = new AbortController()
  const timer = setTimeout(() => deadlineController.abort(new CommandRecoveryError('The AI request timed out. Your board has not changed.', 'timeout')), timeout)
  const signal = options.signal ? AbortSignal.any([options.signal, deadlineController.signal]) : deadlineController.signal
  return {
    close() { clearTimeout(timer) },
    get attempts() { return attempts },
    async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
      let failures = 0
      while (true) {
        aborted(signal)
        const remaining = deadline - now()
        if (attempts >= maxAttempts || remaining <= 0) throw new CommandRecoveryError('The automatic retry limit was reached. Your board has not changed; please try again.', 'retry_limit')
        attempts++; options.onAttempt?.()
        const attemptController = new AbortController()
        const attemptTimer = setTimeout(() => attemptController.abort(new DOMException('The AI attempt timed out.', 'TimeoutError')), Math.min(attemptTimeout, remaining))
        const attemptSignal = AbortSignal.any([signal, attemptController.signal])
        let failure: unknown
        try { return await abortable(Promise.resolve().then(() => { aborted(attemptSignal); return request(attemptSignal) }), attemptSignal) }
        catch (error) { failure = error }
        finally { clearTimeout(attemptTimer) }
        aborted(signal)
        const info = classifyCommandFailure(failure, now())
        if (!info.retryable || attempts >= maxAttempts) throw publicCommandError(failure)
        const exponential = 350 * 2 ** failures++
        const delay = Math.max(info.retryAfterMs ?? 0, exponential) + Math.floor(Math.max(0, Math.min(1, random())) * 180)
        // Never shorten a Retry-After to fit the local deadline.
        if (delay + 250 >= deadline - now()) throw publicCommandError(failure)
        await (options.sleep ?? wait)(delay, signal)
      }
    },
  }
}
