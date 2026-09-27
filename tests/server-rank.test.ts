import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { rankItems, rankRequestSchema, registerRankRoute, type RankUsage } from '../server/rank'
import { grantAccess, RateLimiter } from '../server/security'
import { isConfident, localRank, type RankItem, type RankRequest } from '../shared/ranking'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

type JevOptions = { exists?: number; confidence?: number; choice?: string; none?: number }
/** answers like Jev: probabilities from a score over each option's text */
function fakeJev(score: (text: string) => number, opts: JevOptions = {}) {
  const calls: any[] = []
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    const criteria = body.questions.pick.criteria as Record<string, string>
    const raw = Object.entries(criteria).map(([k, v]) => [k, k === 'none' ? opts.none ?? .01 : score(v)] as const)
    const total = raw.reduce((a, [, v]) => a + v, 0) || 1
    const probabilities = Object.fromEntries(raw.map(([k, v]) => [k, v / total]))
    const [top, topP] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]
    const answers: Record<string, unknown> = { pick: { type: 'choice', choice: opts.choice ?? top, probabilities, confidence: opts.confidence ?? topP } }
    if (body.questions.exists) answers.exists = { type: 'noul', noul: opts.exists ?? .9 }
    return json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 4 } })
  }) as typeof fetch
  return { fetcher, calls }
}

const library: RankRequest = { task: 'library', query: 'problem 3.2', context: 'Book: Calculus Volume 1', items: [
  { id: 'book#199:example:3.2', text: 'Example 3.2 on page 192: Finding a derivative from the definition', features: { exactLabel: 1, kindMatch: 1, kindPrior: .8 } },
  { id: 'book#201:checkpoint:3.2', text: 'Checkpoint 3.2 on page 194: use a table to estimate the derivative', features: { exactLabel: 1, kindMatch: 1, kindPrior: .7 } },
  { id: 'book#194:section:3.2', text: 'Section 3.2 on page 187: The Derivative as a Function', features: { exactLabel: 1, kindPrior: .4 } },
] }
const favor = (word: string, p = .9) => (text: string) => text.includes(word) ? p : .02

describe('rankItems', () => {
  it('uses the local ranker without a key and never calls Jev', async () => {
    const { fetcher, calls } = fakeJev(() => 1)
    const result = await rankItems(library, { fetcher })
    expect(result.source).toBe('local')
    expect(result.note).toBe('jev not configured')
    expect(result.ranked.map(r => r.id)).toEqual(localRank(library).ranked.map(r => r.id))
    expect(calls).toHaveLength(0)
  })

  it('blends Jev probabilities with the local score', async () => {
    const { fetcher, calls } = fakeJev(favor('Section', .8))
    const usage: RankUsage[] = []
    const result = await rankItems(library, { key: 'k', fetcher, onUsage: u => usage.push({ ...u }) })
    expect(result.source).toBe('jev')
    expect(result.model).toBe('jev-1.13.0')
    expect(result.ranked[0].id).toBe('book#194:section:3.2')
    const body = calls[0]
    const pick = body.questions.pick
    expect(pick.type).toBe('choice')
    expect(Object.keys(pick.criteria)).toEqual(['o1', 'o2', 'o3', 'none'])
    expect(pick.criteria.none).toBe('None of these match the request')
    expect(body.questions.exists.type).toBe('noul')
    expect(body.state).toEqual({ request: 'problem 3.2', context: 'Book: Calculus Volume 1', options: { o1: library.items[0].text, o2: library.items[1].text, o3: library.items[2].text } })
    // .7 jev (none removed, renormalized) + .3 local
    const jevRaw = [.02, .02, .8], jevTotal = .84
    const local = new Map(localRank(library).ranked.map(r => [r.id, r.p]))
    const expected = library.items.map((item, i) => .7 * jevRaw[i] / jevTotal + .3 * local.get(item.id)!)
    const total = expected.reduce((a, b) => a + b, 0)
    for (const [i, item] of library.items.entries()) expect(result.ranked.find(r => r.id === item.id)!.p).toBeCloseTo(expected[i] / total, 9)
    expect(result.ranked.reduce((a, r) => a + r.p, 0)).toBeCloseTo(1, 9)
    expect(usage).toEqual([{ calls: 1, inputTokens: 100 }])
  })

  it('is confident when Jev and the local score agree', async () => {
    const { fetcher } = fakeJev(favor('Example', .97))
    const result = await rankItems(library, { key: 'k', fetcher })
    expect(result.ranked[0].id).toBe('book#199:example:3.2')
    expect(isConfident(result.ranked)).toBe(true)
    expect(result.confident).toBe(true)
  })

  it.each([
    ['the noul says nothing matches', { exists: .2 }],
    ['Jev picks none', { choice: 'none', none: 5 }],
    ['Jev confidence is low', { confidence: .4 }],
  ])('is not confident when %s', async (_name, opts: JevOptions) => {
    const { fetcher } = fakeJev(favor('Example', .97), opts)
    const result = await rankItems(library, { key: 'k', fetcher })
    expect(result.source).toBe('jev')
    expect(result.confident).toBe(false)
    expect(result.ranked.map(r => r.id)).not.toContain('none')
  })

  it('asks placement without the noul and keeps spot ids', async () => {
    const spots: RankItem[] = [
      { id: 'S1', text: 'top left, 300 px free below', features: { inView: 1 } },
      { id: 'S2', text: 'right of the graph, top aligned, 420 px free below', features: { inView: 1, readingOrder: 1 } },
    ]
    const { fetcher, calls } = fakeJev(favor('right of the graph'))
    const result = await rankItems({ task: 'placement', query: 'plot y = x^2', items: spots }, { key: 'k', fetcher })
    expect(calls[0].questions.exists).toBeUndefined()
    expect(calls[0].state.context).toBeUndefined()
    expect(result.ranked.map(r => r.id)).toEqual(['S2', 'S1'])
    expect(result.confident).toBe(true)
  })

  it.each([
    [401, {}, 'The Jev key is missing or invalid.', 1],
    [422, {}, 'Jev rejected the request: body.questions: bad', 1],
    [429, { 'retry-after': '0' }, 'Jev is rate limited right now.', 2],
    [529, { 'retry-after': '0' }, 'Jev is overloaded right now.', 2],
  ])('falls back to the local ranker on %i', async (status, headers, note, attempts) => {
    let count = 0
    const fetcher = (async () => { count++; return json({ detail: [{ loc: ['body', 'questions'], msg: 'bad' }] }, status, headers) }) as typeof fetch
    const usage: RankUsage[] = []
    const result = await rankItems(library, { key: 'k', fetcher, onUsage: u => usage.push({ ...u }) })
    expect(result.source).toBe('local')
    expect(result.note).toBe(note)
    expect(result.ranked.map(r => r.id)).toEqual(localRank(library).ranked.map(r => r.id))
    expect(count).toBe(attempts)
    expect(usage).toEqual([{ calls: 1, inputTokens: 0 }])
  })

  it('falls back to the local ranker on timeout', async () => {
    const fetcher = (() => new Promise<Response>(() => {})) as typeof fetch
    const started = Date.now()
    const result = await rankItems(library, { key: 'k', fetcher, timeoutMs: 250 })
    expect(result).toMatchObject({ source: 'local', note: 'Jev timed out.' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result.ms).toBeGreaterThanOrEqual(200)
  })

  it('ranks over 254 items in chunks, then ranks the winners', async () => {
    const items = Array.from({ length: 600 }, (_, i) => ({ id: `item-${i}`, text: i === 417 ? 'Example 7.3 the target' : `Exercise ${i} filler`, features: { textMatch: (i % 10) / 10 } }))
    const { fetcher, calls } = fakeJev(favor('target', .95))
    const result = await rankItems({ task: 'library', query: 'example 7.3', items }, { key: 'k', fetcher })
    expect(result.source).toBe('jev')
    expect(calls).toHaveLength(4)
    for (const call of calls) expect(Object.keys(call.questions.pick.criteria).length).toBeLessThanOrEqual(255)
    expect(calls.slice(0, 3).every(c => !c.questions.exists)).toBe(true)
    const final = calls[3]
    expect(final.questions.exists).toBeDefined()
    expect(Object.keys(final.questions.pick.criteria)).toHaveLength(10)
    expect(Object.values(final.state.options)).toContain('Example 7.3 the target')
    expect(result.ranked[0].id).toBe('item-417')
    expect(result.ranked).toHaveLength(600)
    expect(new Set(result.ranked.map(r => r.id)).size).toBe(600)
  })

  it('keeps each Jev call small when option texts are long', async () => {
    const items = Array.from({ length: 255 }, (_, i) => ({ id: `p${i}`, text: `${i === 3 ? 'target ' : ''}${'word '.repeat(90)}`, features: { early: 1 - i / 255 } }))
    const { fetcher, calls } = fakeJev(favor('target'))
    const result = await rankItems({ task: 'library', query: 'target', items }, { key: 'k', fetcher })
    expect(calls.length).toBeGreaterThan(2)
    for (const call of calls) expect(JSON.stringify(call).length).toBeLessThan(70_000)
    expect(result.ranked[0].id).toBe('p3')
  })

  it('drops duplicate ids and clips direct callers', async () => {
    const { fetcher, calls } = fakeJev(favor('first'))
    const result = await rankItems({ task: 'book', query: 'q'.repeat(5000), items: [{ id: 'a', text: 'first ' + 'x'.repeat(900) }, { id: 'a', text: 'dup' }, { id: 'b', text: 'second' }] }, { key: 'k', fetcher })
    expect(result.ranked.map(r => r.id)).toEqual(['a', 'b'])
    expect(calls[0].state.options.o1).toHaveLength(400)
    expect(calls[0].state.request.length).toBeLessThanOrEqual(2000)
  })
})

describe('POST /api/rank', () => {
  let server: Server
  let base = ''
  let cookie = ''
  let key: string | undefined
  const jev = fakeJev(favor('Example', .97))
  beforeAll(async () => {
    const app = express()
    app.use(express.json({ limit: '2300kb' }))
    registerRankRoute(app, { readKey: async () => { if (key === 'throw') throw new Error('disk'); return key }, fetcher: jev.fetcher, limiter: new RateLimiter(12, 60_000) })
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    grantAccess({ secure: false, headers: {} } as any, { cookie: (_name: string, value: string) => { cookie = `marginalia_session=${value}` } } as any)
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  const post = (body: unknown, headers: Record<string, string> = { 'X-Marginalia': '1', cookie }) =>
    fetch(`${base}/api/rank`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('requires the app header, same origin and a paired session', async () => {
    expect((await post(library, { cookie })).status).toBe(403)
    expect((await post(library, { 'X-Marginalia': '1', cookie, Origin: 'https://evil.example' })).status).toBe(403)
    const unpaired = await post(library, { 'X-Marginalia': '1' })
    expect(unpaired.status).toBe(401)
    expect(await unpaired.json()).toMatchObject({ code: 'pairing_required' })
    expect((await post(library, { 'X-Marginalia': '1', cookie: 'marginalia_session=forged' })).status).toBe(401)
  })

  it.each([
    ['no items', { ...library, items: [] }],
    ['too many items', { ...library, items: Array.from({ length: 256 }, (_, i) => ({ id: `i${i}`, text: 'x' })) }],
    ['a long query', { ...library, query: 'x'.repeat(501) }],
    ['a long item text', { ...library, items: [{ id: 'a', text: 'x'.repeat(401) }] }],
    ['a long id', { ...library, items: [{ id: 'x'.repeat(121), text: 'x' }] }],
    ['an empty id', { ...library, items: [{ id: '', text: 'x' }] }],
    ['a text feature', { ...library, items: [{ id: 'a', text: 'x', features: { exactLabel: 'yes' } }] }],
    ['a null feature', { ...library, items: [{ id: 'a', text: 'x', features: { exactLabel: null } }] }],
    ['an unknown task', { ...library, task: 'solve' }],
    ['a long context', { ...library, context: 'x'.repeat(2001) }],
  ])('rejects %s', async (_name, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'The ranking request is incomplete or too large.' })
  })

  it('ranks locally without a key and with Jev when a key exists', async () => {
    key = undefined
    const local = await (await post(library)).json()
    expect(local.source).toBe('local')
    expect(local.ranked).toHaveLength(3)
    key = 'k'
    const ranked = await (await post(library)).json()
    expect(ranked).toMatchObject({ source: 'jev', model: 'jev-1.13.0', confident: true })
    expect(ranked.ranked[0].id).toBe('book#199:example:3.2')
    key = 'throw'
    expect((await (await post(library)).json()).source).toBe('local')
  })

  it('rate limits each session', async () => {
    key = undefined
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await post({ task: 'book', query: 'calc', items: [{ id: 'a', text: 'Calculus' }] })).status)
    expect(statuses.at(-1)).toBe(429)
  })

  it('accepts the largest valid request', () => {
    const items = Array.from({ length: 255 }, (_, i) => ({ id: 'x'.repeat(115) + i, text: 'y'.repeat(400), features: { exactLabel: 1, textMatch: .5 } }))
    expect(rankRequestSchema.safeParse({ task: 'library', query: 'q'.repeat(500), items, context: 'c'.repeat(2000) }).success).toBe(true)
  })
})
