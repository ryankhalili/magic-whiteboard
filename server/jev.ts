import { readFile } from 'node:fs/promises'
import path from 'node:path'

// typesafe system one api, see docs.typesafe.ai/api
export type JevValue = string | Record<string, unknown> | unknown[] | null
export type JevInstructions = string | Record<string, unknown> | unknown[]
export type JevChoiceQuestion = { type: 'choice'; instructions: JevInstructions; criteria: Record<string, JevValue> }
export type JevNoulQuestion = { type: 'noul'; instructions: JevInstructions; criteria?: { true?: JevValue; false?: JevValue } }
export type JevScoreQuestion = { type: 'score'; instructions: JevInstructions; criteria: JevValue[] }
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion

export type JevChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type JevNoulAnswer = { type: 'noul'; noul: number }
export type JevScoreAnswer = { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer
export type JevUsage = { input_tokens: number; output_tokens: number }
export type JevResponse = { model: string; answers: Record<string, JevAnswer>; usage?: JevUsage; requestId?: string }
export type JevBody = { state: unknown; questions: Record<string, JevQuestion>; model?: string }
export type JevOptions = { fetcher?: typeof fetch; timeoutMs?: number; retries?: number; baseUrl?: string }
export type JevResult = { ok: true; data: JevResponse } | { ok: false; status?: number; error: string }

export const JEV_BASE_URL = 'https://api.typesafe.ai'
export const JEV_MAX_OPTIONS = 255
export const JEV_MAX_SCORE_LEVELS = 10
const RETRY_CAP_MS = 1500
const RETRY_DEFAULT_MS = 400
const MIN_ATTEMPT_MS = 150

export function jevModel() { return process.env.TYPESAFE_MODEL?.trim() || 'jev-latest' }

function cleanKey(line: string | undefined) {
  let value = line?.trim() ?? ''
  const assigned = value.match(/^(?:export\s+)?[A-Z_]*KEY\s*=\s*(.*)$/)
  if (assigned) value = assigned[1].trim()
  value = value.replace(/^(['"])(.*)\1$/, '$2').trim()
  return value && !/\s/.test(value) && /^[\x21-\x7e]+$/.test(value) ? value : undefined
}

/** env first, then the first non empty line of jev.txt, .local/jev.txt, .local/typesafe.txt */
export async function readJevKey(root: string): Promise<string | undefined> {
  for (const name of ['TYPESAFE_API_KEY', 'JEV_API_KEY']) {
    const key = cleanKey(process.env[name])
    if (key) return key
  }
  for (const file of ['jev.txt', path.join('.local', 'jev.txt'), path.join('.local', 'typesafe.txt')]) {
    try {
      const line = (await readFile(path.join(root, file), 'utf8')).split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
      const key = cleanKey(line)
      if (key) return key
    } catch { /* missing file */ }
  }
  return undefined
}

/** p for an option: choice option name, score level index ('0'), or noul 'true'/'false'. */
export function probabilityOf(answer: JevAnswer | undefined, option: string): number {
  if (!answer) return 0
  if (answer.type === 'noul') return option === 'true' ? answer.noul : option === 'false' ? 1 - answer.noul : 0
  const p = answer.probabilities[option]
  if (typeof p === 'number' && Number.isFinite(p)) return p
  return answer.type === 'choice' && answer.choice === option ? answer.confidence : 0
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -1e-6 && v <= 1 + 1e-6
const unit = (v: number) => Math.min(1, Math.max(0, v))

export function questionError(id: string, q: JevQuestion): string | null {
  if (!q || typeof q !== 'object') return `Question ${id} is missing.`
  if (q.instructions === undefined || q.instructions === '') return `Question ${id} needs instructions.`
  if (q.type === 'choice') {
    const n = isObject(q.criteria) ? Object.keys(q.criteria).length : 0
    return n >= 1 && n <= JEV_MAX_OPTIONS ? null : `Question ${id} needs 1 to ${JEV_MAX_OPTIONS} options.`
  }
  if (q.type === 'score') return Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= JEV_MAX_SCORE_LEVELS ? null : `Question ${id} needs 2 to ${JEV_MAX_SCORE_LEVELS} levels.`
  if (q.type === 'noul') return q.criteria === undefined || isObject(q.criteria) && Object.keys(q.criteria).every(k => k === 'true' || k === 'false') ? null : `Question ${id} has invalid yes or no criteria.`
  return `Question ${id} has an unknown type.`
}

function readProbabilities(value: unknown): Record<string, number> | null {
  if (!isObject(value)) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!isUnit(v)) return null
    out[k] = unit(v)
  }
  return out
}

function readAnswer(q: JevQuestion, a: unknown): JevAnswer | null {
  if (!isObject(a) || a.type !== undefined && a.type !== q.type) return null
  if (q.type === 'noul') return isUnit(a.noul) ? { type: 'noul', noul: unit(a.noul) } : null
  const probabilities = a.probabilities === undefined ? {} : readProbabilities(a.probabilities)
  if (!probabilities) return null
  const top = Math.max(0, ...Object.values(probabilities))
  if (a.confidence !== undefined && !isUnit(a.confidence)) return null
  const confidence = isUnit(a.confidence) ? unit(a.confidence) : top
  if (q.type === 'choice') {
    if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice)) return null
    if (!Object.keys(probabilities).length) probabilities[a.choice] = confidence
    return { type: 'choice', choice: a.choice, probabilities, confidence }
  }
  if (typeof a.score !== 'number' || !Number.isFinite(a.score)) return null
  const legend: Record<string, string> = {}
  if (isObject(a.legend)) for (const [k, v] of Object.entries(a.legend)) if (typeof v === 'string') legend[k] = v
  return { type: 'score', score: a.score, legend, probabilities, confidence }
}

function readResponse(value: unknown, questions: Record<string, JevQuestion>, model: string, requestId?: string): JevResponse | null {
  if (!isObject(value) || !isObject(value.answers)) return null
  const answers: Record<string, JevAnswer> = {}
  for (const [id, q] of Object.entries(questions)) {
    const answer = readAnswer(q, value.answers[id])
    if (!answer) return null
    answers[id] = answer
  }
  const usage = isObject(value.usage) ? value.usage : null
  return {
    model: typeof value.model === 'string' && value.model ? value.model.slice(0, 80) : model, answers,
    ...(usage ? { usage: { input_tokens: Number(usage.input_tokens) || 0, output_tokens: Number(usage.output_tokens) || 0 } } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

/** Reads error, message or detail (string, {message} or [{loc, msg}]) from an error body. */
function errorDetail(body: string): string {
  let value: unknown
  try { value = JSON.parse(body) } catch { return '' }
  if (!isObject(value)) return ''
  const text = (v: unknown): string => typeof v === 'string' ? v
    : isObject(v) && typeof v.message === 'string' ? v.message
      : Array.isArray(v) ? v.map(d => isObject(d) ? [Array.isArray(d.loc) ? d.loc.join('.') : '', typeof d.msg === 'string' ? d.msg : ''].filter(Boolean).join(': ') : text(d)).filter(Boolean).join('; ')
        : ''
  return (text(value.error) || text(value.message) || text(value.detail)).replace(/\s+/g, ' ').trim().slice(0, 200)
}

function statusError(status: number, detail: string) {
  if (status === 401) return 'The Jev key is missing or invalid.'
  if (status === 403) return 'This Jev key cannot use that model.'
  if (status === 422 || status === 400) return `Jev rejected the request${detail ? `: ${detail}` : '.'}`
  if (status === 429) return 'Jev is rate limited right now.'
  if (status === 529) return 'Jev is overloaded right now.'
  return `Jev returned an error (${status}).`
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500

function retryDelay(header: string | null) {
  if (!header) return RETRY_DEFAULT_MS
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) ? Math.min(RETRY_CAP_MS, Math.max(0, ms)) : RETRY_DEFAULT_MS
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    promise.then(v => { signal.removeEventListener('abort', stop); resolve(v) }, e => { signal.removeEventListener('abort', stop); reject(e) })
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
class Timeout extends Error {}

/** One Jev request with a total time budget. Never throws. */
export async function callJev(key: string, body: JevBody, opts: JevOptions = {}): Promise<JevResult> {
  try {
    if (!key) return { ok: false, error: 'No Jev key is configured.' }
    const entries = Object.entries(body.questions ?? {})
    if (!entries.length) return { ok: false, error: 'Jev needs at least one question.' }
    for (const [id, q] of entries) { const error = questionError(id, q); if (error) return { ok: false, error } }
    const fetcher = opts.fetcher ?? fetch
    const model = body.model || jevModel()
    const url = `${(opts.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, '')}/v1/systemone`
    const payload = JSON.stringify({ state: body.state ?? {}, model, questions: body.questions })
    const deadline = Date.now() + Math.max(1, opts.timeoutMs ?? 5000)
    const attempts = 1 + Math.max(0, Math.floor(opts.retries ?? 1))
    let last: JevResult = { ok: false, error: 'Jev could not be reached.' }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ok: false, error: 'Jev timed out.' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Timeout()), remaining)
      let wait = RETRY_DEFAULT_MS
      try {
        const response = await withAbort(fetcher(url, {
          method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: payload,
        }), controller.signal)
        const text = await withAbort(response.text(), controller.signal)
        if (response.ok) {
          let json: unknown
          try { json = JSON.parse(text) } catch { return { ok: false, status: response.status, error: 'Jev returned an unreadable answer.' } }
          const data = readResponse(json, body.questions, model, response.headers.get('x-typesafe-request-id')?.slice(0, 120) || undefined)
          return data ? { ok: true, data } : { ok: false, status: response.status, error: 'Jev returned an unexpected answer.' }
        }
        last = { ok: false, status: response.status, error: statusError(response.status, errorDetail(text)) }
        if (!retryable(response.status)) return last
        wait = retryDelay(response.headers.get('retry-after'))
      } catch {
        if (controller.signal.aborted && controller.signal.reason instanceof Timeout) return { ok: false, error: 'Jev timed out.' }
        last = { ok: false, error: 'Jev could not be reached.' }
      } finally { clearTimeout(timer) }
      if (attempt + 1 >= attempts || deadline - Date.now() - wait < MIN_ATTEMPT_MS) return last
      await sleep(wait)
    }
    return last
  } catch {
    return { ok: false, error: 'Jev could not be reached.' }
  }
}
