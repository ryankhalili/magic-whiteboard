import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { callJev, probabilityOf, readJevKey, type JevAnswer, type JevQuestion } from '../server/jev'
import { blockedPath } from '../server/security'

type Reply = Response | ((init: RequestInit) => Response | Promise<Response>)
function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    return typeof reply === 'function' ? reply(init!) : reply.clone()
  }) as typeof fetch
  return { fetcher, calls }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const questions: Record<string, JevQuestion> = {
  pick: { type: 'choice', instructions: 'Which option?', criteria: { a: 'first', b: 'second', none: null } },
  exists: { type: 'noul', instructions: 'One option matches.' },
  level: { type: 'score', instructions: 'How clear?', criteria: ['vague', 'clear', 'exact'] },
}
const answers = {
  pick: { type: 'choice', choice: 'b', probabilities: { a: .1, b: .85, none: .05 }, confidence: .8 },
  exists: { type: 'noul', noul: .9 },
  level: { type: 'score', score: 1.4, legend: { 0: 'vague', 1: 'clear', 2: 'exact' }, probabilities: { 0: .1, 1: .4, 2: .5 }, confidence: .6 },
}
const ok = () => json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 392, output_tokens: 65 } }, 200, { 'x-typesafe-request-id': 'req_123' })

beforeEach(() => { vi.stubEnv('TYPESAFE_API_KEY', ''); vi.stubEnv('JEV_API_KEY', ''); vi.stubEnv('TYPESAFE_MODEL', '') })
afterEach(() => { vi.unstubAllEnvs() })

describe('Jev client', () => {
  it('posts the documented request and reads every answer type', async () => {
    const { fetcher, calls } = fakeFetch(ok)
    const result = await callJev('ts-key', { state: { request: 'problem 3.2' }, questions }, { fetcher })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer ts-key', 'Content-Type': 'application/json' })
    expect(calls[0].body).toEqual({ state: { request: 'problem 3.2' }, model: 'jev-latest', questions })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.model).toBe('jev-1.13.0')
    expect(result.data.requestId).toBe('req_123')
    expect(result.data.usage).toEqual({ input_tokens: 392, output_tokens: 65 })
    expect(result.data.answers.pick).toEqual(answers.pick)
    expect(result.data.answers.exists).toEqual({ type: 'noul', noul: .9 })
    expect(result.data.answers.level).toMatchObject({ type: 'score', score: 1.4, confidence: .6 })
  })

  it('uses TYPESAFE_MODEL and a custom base url', async () => {
    vi.stubEnv('TYPESAFE_MODEL', 'jev-1.13.0')
    const { fetcher, calls } = fakeFetch(ok)
    await callJev('k', { state: 'x', questions }, { fetcher, baseUrl: 'https://gateway.example/typesafe/' })
    expect(calls[0].url).toBe('https://gateway.example/typesafe/v1/systemone')
    expect(calls[0].body.model).toBe('jev-1.13.0')
  })

  it('refuses invalid questions without calling the api', async () => {
    const { fetcher, calls } = fakeFetch(ok)
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]))
    for (const bad of [
      { type: 'choice', instructions: 'x', criteria: many },
      { type: 'choice', instructions: 'x', criteria: {} },
      { type: 'score', instructions: 'x', criteria: ['only one'] },
      { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) },
      { type: 'noul', instructions: 'x', criteria: { maybe: 'x' } },
      { type: 'number', instructions: 'x' },
    ]) {
      const result = await callJev('k', { state: 'x', questions: { q: bad as JevQuestion } }, { fetcher })
      expect(result.ok).toBe(false)
    }
    expect((await callJev('', { state: 'x', questions }, { fetcher })).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['a choice outside the options', { ...answers, pick: { type: 'choice', choice: 'z', probabilities: { a: 1 }, confidence: 1 } }],
    ['a probability above one', { ...answers, pick: { type: 'choice', choice: 'a', probabilities: { a: 1.5 }, confidence: 1 } }],
    ['a missing answer', { pick: answers.pick, exists: answers.exists }],
    ['a wrong answer type', { ...answers, exists: { type: 'choice', choice: 'a' } }],
    ['a noul outside 0..1', { ...answers, exists: { type: 'noul', noul: 2 } }],
  ])('rejects %s', async (_name, bad) => {
    const { fetcher } = fakeFetch(json({ model: 'jev-1.13.0', answers: bad }))
    const result = await callJev('k', { state: 'x', questions }, { fetcher })
    expect(result).toMatchObject({ ok: false, status: 200, error: 'Jev returned an unexpected answer.' })
  })

  it('does not retry a bad key', async () => {
    const { fetcher, calls } = fakeFetch(json({ error: { message: 'invalid api key' } }, 401))
    const result = await callJev('bad', { state: 'x', questions }, { fetcher })
    expect(result).toEqual({ ok: false, status: 401, error: 'The Jev key is missing or invalid.' })
    expect(calls).toHaveLength(1)
  })

  it('reports the field named in a 422 body and does not retry', async () => {
    const { fetcher, calls } = fakeFetch(json({ detail: [{ loc: ['body', 'questions', 'pick', 'criteria'], msg: 'field required', type: 'missing' }] }, 422))
    const result = await callJev('k', { state: 'x', questions }, { fetcher })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.error).toContain('body.questions.pick.criteria: field required')
    expect(calls).toHaveLength(1)
  })

  it('retries a 429 once after retry-after', async () => {
    const { fetcher, calls } = fakeFetch(json({ error: 'slow down' }, 429, { 'retry-after': '0' }), ok)
    const result = await callJev('k', { state: 'x', questions }, { fetcher })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('gives up on a 529 after one retry', async () => {
    const { fetcher, calls } = fakeFetch(() => json({ message: 'overloaded' }, 529, { 'retry-after': '0' }))
    const result = await callJev('k', { state: 'x', questions }, { fetcher })
    expect(result).toEqual({ ok: false, status: 529, error: 'Jev is overloaded right now.' })
    expect(calls).toHaveLength(2)
  })

  it('caps a long retry-after at 1.5 s', async () => {
    const { fetcher, calls } = fakeFetch(json({}, 503, { 'retry-after': '30' }), ok)
    const started = Date.now()
    const result = await callJev('k', { state: 'x', questions }, { fetcher, timeoutMs: 4000 })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(2500)
  })

  it('skips a retry that would not fit in the time budget', async () => {
    const { fetcher, calls } = fakeFetch(json({}, 429, { 'retry-after': '1' }), ok)
    const result = await callJev('k', { state: 'x', questions }, { fetcher, timeoutMs: 600 })
    expect(result).toMatchObject({ ok: false, status: 429 })
    expect(calls).toHaveLength(1)
  })

  it('times out a request that never answers, even if fetch ignores the signal', async () => {
    const fetcher = (() => new Promise<Response>(() => {})) as typeof fetch
    const started = Date.now()
    const result = await callJev('k', { state: 'x', questions }, { fetcher, timeoutMs: 120 })
    expect(result).toEqual({ ok: false, error: 'Jev timed out.' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('aborts the fetch signal on timeout', async () => {
    let aborted = false
    const fetcher = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) })
    })) as unknown as typeof fetch
    const result = await callJev('k', { state: 'x', questions }, { fetcher, timeoutMs: 80 })
    expect(result).toEqual({ ok: false, error: 'Jev timed out.' })
    expect(aborted).toBe(true)
  })

  it('retries a network error once and never throws', async () => {
    let count = 0
    const fetcher = (async () => { count++; throw new TypeError('fetch failed') }) as typeof fetch
    const result = await callJev('k', { state: 'x', questions }, { fetcher, retries: 1 })
    expect(result).toEqual({ ok: false, error: 'Jev could not be reached.' })
    expect(count).toBe(2)
    const broken = (async () => new Response('not json', { status: 200 })) as typeof fetch
    expect(await callJev('k', { state: 'x', questions }, { fetcher: broken })).toMatchObject({ ok: false, error: 'Jev returned an unreadable answer.' })
  })

  it('reads probabilities for every answer type', () => {
    const choice = answers.pick as JevAnswer
    expect(probabilityOf(choice, 'b')).toBe(.85)
    expect(probabilityOf(choice, 'missing')).toBe(0)
    expect(probabilityOf({ type: 'choice', choice: 'a', probabilities: {}, confidence: .7 }, 'a')).toBe(.7)
    expect(probabilityOf({ type: 'noul', noul: .8 }, 'true')).toBe(.8)
    expect(probabilityOf({ type: 'noul', noul: .8 }, 'false')).toBeCloseTo(.2, 9)
    expect(probabilityOf(answers.level as JevAnswer, '2')).toBe(.5)
    expect(probabilityOf(undefined, 'a')).toBe(0)
  })
})

describe('Jev key', () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jev-key-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads env first, then jev.txt, .local/jev.txt and .local/typesafe.txt', async () => {
    expect(await readJevKey(root)).toBeUndefined()
    await mkdir(path.join(root, '.local'))
    await writeFile(path.join(root, '.local', 'typesafe.txt'), 'ts-typesafe\n')
    expect(await readJevKey(root)).toBe('ts-typesafe')
    await writeFile(path.join(root, '.local', 'jev.txt'), 'ts-local-jev\n')
    expect(await readJevKey(root)).toBe('ts-local-jev')
    await writeFile(path.join(root, 'jev.txt'), '\n# my key\n  ts-root  \nsecond line\n')
    expect(await readJevKey(root)).toBe('ts-root')
    vi.stubEnv('JEV_API_KEY', ' ts-env-jev ')
    expect(await readJevKey(root)).toBe('ts-env-jev')
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env')
    expect(await readJevKey(root)).toBe('ts-env')
  })

  it('accepts KEY=value lines and skips unusable ones', async () => {
    await writeFile(path.join(root, 'jev.txt'), 'TYPESAFE_API_KEY="ts-quoted"\n')
    expect(await readJevKey(root)).toBe('ts-quoted')
    await writeFile(path.join(root, 'jev.txt'), 'paste your key here\n')
    await mkdir(path.join(root, '.local'))
    await writeFile(path.join(root, '.local', 'typesafe.txt'), 'ts-fallback')
    expect(await readJevKey(root)).toBe('ts-fallback')
  })

  it.each(['/jev.txt', '/JEV.TXT', '/%6aev.txt', '/sub/jev.txt?raw', '/@fs/Users/x/jev.txt'])('never serves %s', url => {
    expect(blockedPath(url)).toBe(true)
  })
})
