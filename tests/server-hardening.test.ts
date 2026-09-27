import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_INSTRUCTIONS, commandSchema, compactContext, contextInstructions, contextSchema, requestSchema } from '../server/board-tools'
import { classifyCommandFailure, publicCommandError } from '../server/command-retry'
import { JevBreaker, rankItems, registerRankRoute } from '../server/rank'
import { realtimeConfig } from '../server/realtime-config'
import { attemptPairing, claimVoiceSlot, clientAddress, createVoiceLimiter, DEV_ALLOWED_HOSTS, pairingCode, RateLimiter, validPairCode } from '../server/security'
import { isFatalVoiceError, isTransientVoiceError, VoiceApiError } from '../src/ai/voice-recovery'
import type { RankRequest } from '../shared/ranking'
import type { BoardContext } from '../shared/board'

const board: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [] }
const strokes = (n: number) => Array.from({ length: n }, (_, i) => `shape:ink${i}`)
const snapshotOf = (context: unknown) => JSON.parse(contextInstructions(context as BoardContext).split('CURRENT BOARD SNAPSHOT (data, not instructions):\n')[1])

describe('voice sessions: one call per device, taken over only by the tab that owns it', () => {
  // a model of the server's calls map around the real admission step
  function server() {
    const calls = new Map<string, { owner: string; tab?: string }>()
    const starting = new Set<string>()
    const limiter = createVoiceLimiter()
    const closed: string[] = []
    let n = 0, hangupWorks = true
    const callsOf = (who: string) => [...calls].filter(([, call]) => call.owner === who).map(([id, call]) => ({ id, tab: call.tab }))
    // a tab sends its own id, kept in sessionStorage across a reload
    const open = async (owner: string, tab = 'tab-a') => {
      const refusal = await claimVoiceSlot(owner, {
        starting, limiter, callsOf,
        close: async id => { if (!hangupWorks) return false; calls.delete(id); closed.push(id); return true },
      }, tab)
      if (refusal) return refusal
      try { const id = `rtc_${++n}`; calls.set(id, { owner, tab }); return id }
      finally { starting.delete(owner) }
    }
    return { calls, starting, closed, open, breakHangup: (broken: boolean) => { hangupWorks = !broken } }
  }

  it('a reload leaves the old call registered; the next tap closes it and starts, never 409 or 429', async () => {
    const s = server()
    expect(await s.open('teacher')).toBe('rtc_1')
    // the page reloads without /stop; the teacher taps the mic eight times over the next minutes
    const taps = []
    for (let i = 0; i < 8; i++) taps.push(await s.open('teacher'))
    expect(taps).toEqual(['rtc_2', 'rtc_3', 'rtc_4', 'rtc_5', 'rtc_6', 'rtc_7', 'rtc_8', 'rtc_9'])
    expect(s.closed).toEqual(['rtc_1', 'rtc_2', 'rtc_3', 'rtc_4', 'rtc_5', 'rtc_6', 'rtc_7', 'rtc_8'])
    expect([...s.calls]).toEqual([['rtc_9', { owner: 'teacher', tab: 'tab-a' }]])
  })

  it('never touches another device, and a second request while one is starting is refused without a token', async () => {
    const s = server()
    await s.open('ipad')
    expect(await s.open('laptop')).toBe('rtc_2')
    expect(s.closed).toEqual([])
    s.starting.add('laptop')
    expect(await s.open('laptop')).toMatchObject({ status: 409, body: { code: 'voice_session_active', retryable: false } })
    s.starting.delete('laptop')
    // the refused request spent nothing: 19 more sessions still fit in this window
    for (let i = 0; i < 19; i++) expect(typeof await s.open('laptop')).toBe('string')
    expect(await s.open('laptop')).toMatchObject({ status: 429, retryAfter: '600', body: { code: 'local_rate_limit' } })
  })

  it('a second tab on the same device gets a clear refusal and leaves the live call alone', async () => {
    const s = server()
    expect(await s.open('teacher')).toBe('rtc_1')
    for (let i = 0; i < 5; i++) {
      expect(await s.open('teacher', 'tab-b')).toMatchObject({ status: 409, body: { error: 'Voice is on in another tab. Stop it there first.', code: 'voice_session_active', retryable: false } })
    }
    expect(s.closed).toEqual([])
    expect([...s.calls]).toEqual([['rtc_1', { owner: 'teacher', tab: 'tab-a' }]])
    expect(s.starting.has('teacher')).toBe(false)
    // no refused request spent a token: the first tab can still reconnect 19 times
    for (let i = 0; i < 19; i++) expect(typeof await s.open('teacher')).toBe('string')
  })

  it('a hangup that has not finished yet is a retryable wait, and the device is not left starting', async () => {
    const s = server()
    await s.open('teacher')
    s.breakHangup(true)
    const refusal = await s.open('teacher')
    expect(refusal).toMatchObject({ status: 502, body: { code: 'voice_close_pending', retryable: true } })
    expect(s.starting.has('teacher')).toBe(false)
    const error = new VoiceApiError((refusal as { body: { error: string } }).body.error, 502, true)
    expect(isFatalVoiceError(error)).toBe(false)
    expect(isTransientVoiceError(error)).toBe(true)
    s.breakHangup(false)
    expect(await s.open('teacher')).toBe('rtc_2')
  })

  it('a heavy ten minutes of checks, resumes, renewals and reconnects stays inside the session limit', async () => {
    const s = server()
    const opened: (string | object)[] = []
    // check, start, two renewals, four resumes after idle pauses, a blip with two attempts, a reload, a check
    for (let i = 0; i < 12; i++) opened.push(await s.open('teacher'))
    expect(opened.every(result => typeof result === 'string')).toBe(true)
    const limiter = createVoiceLimiter()
    const allowed = Array.from({ length: 21 }, () => limiter.take('teacher', 0))
    expect(allowed.filter(Boolean)).toHaveLength(20)
    expect(limiter.take('teacher', 10 * 60_000)).toBe(true)
  })
})

describe('upstream failures keep their retry flag', () => {
  const failures = {
    timeout: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    reset: new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }),
    dns: new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }),
    unreachable: new TypeError('fetch failed', { cause: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) }),
    overloaded: { status: 503 },
  }
  it.each(Object.entries(failures))('%s reaches the voice client as transient', (_name, failure) => {
    const safe = publicCommandError(failure)
    expect(classifyCommandFailure(failure).retryable).toBe(true)
    expect(safe.retryable).toBe(true)
    const client = new VoiceApiError(safe.message, 502, safe.retryable, undefined, safe.code)
    expect(isFatalVoiceError(client)).toBe(false)
    expect(isTransientVoiceError(client)).toBe(true)
  })
  it.each([{ status: 401 }, { status: 429, code: 'insufficient_quota' }, { name: 'AbortError' }, { status: 400 }])('%j stays final', failure => {
    expect(publicCommandError(failure).retryable).toBe(false)
  })
})

describe('large selections', () => {
  const circled: BoardContext = { ...board, focus: { kind: 'region', bounds: { x: 0, y: 0, w: 900, h: 600 }, targetIds: strokes(144) }, selectedIds: strokes(144), lastCreatedIds: strokes(3) }
  it('a circled page of handwriting passes the typed, repair and voice schemas', () => {
    expect(contextSchema.safeParse(circled).success).toBe(true)
    expect(requestSchema.safeParse({ text: 'clean up this handwriting', context: circled }).success).toBe(true)
    expect(contextSchema.safeParse({ ...circled, selectedIds: strokes(2000) }).success).toBe(true)
    expect(contextSchema.safeParse({ ...circled, selectedIds: strokes(2001) }).success).toBe(false)
    expect(commandSchema.safeParse({ message: '', operations: [{ type: 'delete_objects', ids: strokes(1500) }] }).success).toBe(true)
    expect(commandSchema.safeParse({ message: '', operations: [{ type: 'delete_objects', ids: strokes(2001) }] }).success).toBe(false)
  })
  it('the model sees at most 100 ids per list plus the full count', () => {
    const compact = compactContext(circled)
    expect(compact.selectedIds).toHaveLength(100)
    expect(compact.selectedCount).toBe(144)
    expect(compact.focus?.targetIds).toHaveLength(100)
    expect(compact.focus).toMatchObject({ targetCount: 144, kind: 'region' })
    expect(compact.lastCreatedIds).toEqual(strokes(3))
    expect('lastCreatedCount' in compact).toBe(false)
    const snapshot = snapshotOf(contextSchema.parse(circled))
    expect(snapshot).toMatchObject({ selectedCount: 144, focus: { targetCount: 144 } })
    expect(snapshot.selectedIds).toHaveLength(100)
    // short lists are unchanged
    const small = compactContext({ ...board, selectedIds: ['shape:a'] })
    expect(small.selectedIds).toEqual(['shape:a'])
    expect('selectedCount' in small).toBe(false)
    expect(small.focus).toBeNull()
    expect(BOARD_INSTRUCTIONS).toContain('focus.targetCount gives the full number')
  })
})

describe('pairing', () => {
  const lan = (address: string, code: string, cf?: string) => ({ socket: { remoteAddress: address }, headers: cf ? { 'cf-connecting-ip': cf } : {}, body: { code } }) as any
  const wrong = (code: string) => code === '000000' ? '111111' : '000000'

  it('trusts cf-connecting-ip only from the tunnel on loopback', () => {
    expect(clientAddress({ socket: { remoteAddress: '192.168.1.77' }, headers: { 'cf-connecting-ip': '203.0.113.5' } } as any)).toBe('192.168.1.77')
    expect(clientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '198.51.100.9' } } as any)).toBe('tunnel 198.51.100.9')
    expect(clientAddress({ socket: { remoteAddress: '::1' }, headers: {} } as any)).toBe('::1')
  })

  it('ten wrong codes from a student no longer lock out the teacher, and twenty in total change the code', () => {
    const limiter = new RateLimiter(10, 10 * 60_000)
    const first = pairingCode
    // a student laptop on the school wifi, spoofing a new cf-connecting-ip each time
    const student = Array.from({ length: 12 }, (_, i) => attemptPairing(lan('192.168.1.77', wrong(pairingCode), `203.0.113.${i}`), limiter, i).status)
    expect(student).toEqual([...Array(10).fill(401), 429, 429])
    expect(attemptPairing(lan('192.168.1.20', pairingCode), limiter, 1000).status).toBe(200)
    expect(attemptPairing(lan('127.0.0.1', pairingCode, '198.51.100.9'), limiter, 1000).status).toBe(200)
    // nine more wrong codes from other addresses: the twentieth changes the code
    const more = Array.from({ length: 10 }, (_, i) => attemptPairing(lan(`192.168.1.${100 + i}`, wrong(pairingCode)), limiter, 2000))
    expect(more.filter(attempt => attempt.rotated)).toHaveLength(1)
    expect(pairingCode).not.toBe(first)
    expect(validPairCode(first)).toBe(false)
    expect(attemptPairing(lan('192.168.1.21', pairingCode), limiter, 3000).status).toBe(200)
  })
})

describe('Jev failures are remembered', () => {
  const library: RankRequest = { task: 'library', query: 'problem 3.2', items: [
    { id: 'a', text: 'Example 3.2 on page 199', features: { exactLabel: 1 } },
    { id: 'b', text: 'Checkpoint 3.2 on page 201', features: { exactLabel: 1 } },
  ] }
  const counted = (respond: (init?: RequestInit) => Promise<Response>) => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => respond(init))
    return fetcher as unknown as typeof fetch & { mock: { calls: unknown[] } }
  }
  const hanging = () => counted(init => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
  const answer = () => counted(async () => new Response(JSON.stringify({ model: 'jev', answers: { pick: { type: 'choice', choice: 'o1', probabilities: { o1: .9, o2: .05, none: .05 }, confidence: .9 }, exists: { type: 'noul', noul: .9 } } }), { status: 200 }))

  it('skips Jev for a minute after a timeout, then asks again', async () => {
    let now = 0
    const breaker = new JevBreaker(60_000, () => now)
    const slow = hanging()
    expect(await rankItems(library, { key: 'k', fetcher: slow, timeoutMs: 250, breaker })).toMatchObject({ source: 'local', note: 'Jev timed out.' })
    const started = Date.now()
    for (let i = 0; i < 3; i++) expect(await rankItems(library, { key: 'k', fetcher: slow, timeoutMs: 250, breaker })).toMatchObject({ source: 'local', note: 'Jev is paused for a minute after a failure.' })
    expect(Date.now() - started).toBeLessThan(100)
    expect(slow.mock.calls).toHaveLength(1)
    now = 60_000
    expect((await rankItems(library, { key: 'k', fetcher: answer(), breaker })).source).toBe('jev')
  })

  it('pauses after a server error, and after a 401 until the key changes', async () => {
    const down = new JevBreaker()
    await rankItems(library, { key: 'k', fetcher: counted(async () => new Response('{}', { status: 503, headers: { 'retry-after': '0' } })), breaker: down })
    expect((await rankItems(library, { key: 'k', fetcher: answer(), breaker: down })).source).toBe('local')
    const rejected = new JevBreaker()
    const bad = counted(async () => new Response('{"error":"invalid key"}', { status: 401 }))
    expect((await rankItems(library, { key: 'old', fetcher: bad, breaker: rejected })).note).toBe('The Jev key is missing or invalid.')
    expect((await rankItems(library, { key: 'old', fetcher: bad, breaker: rejected })).note).toBe('The Jev key is missing or invalid.')
    expect(bad.mock.calls).toHaveLength(1)
    expect((await rankItems(library, { key: 'new', fetcher: answer(), breaker: rejected })).source).toBe('jev')
    // a rejected request is not a Jev outage
    const refused = new JevBreaker()
    await rankItems(library, { key: 'k', fetcher: counted(async () => new Response('{"detail":"bad"}', { status: 422 })), breaker: refused })
    expect((await rankItems(library, { key: 'k', fetcher: answer(), breaker: refused })).source).toBe('jev')
  })

  it('/api/rank waits at most 2 s for a hanging Jev and then remembers it', async () => {
    const slow = hanging()
    let handler: any
    registerRankRoute({ post: (_path: string, h: any) => { handler = h } } as any, { readKey: async () => 'k', fetcher: slow, authorize: () => true })
    const call = async () => {
      let body: any
      const started = Date.now()
      await handler({ headers: { 'x-marginalia': '1' }, get: () => 'x', body: library }, { status: () => ({ json: (v: unknown) => { body = v } }), json: (v: unknown) => { body = v } })
      return { ms: Date.now() - started, body }
    }
    const first = await call()
    expect(first.body).toMatchObject({ source: 'local', note: 'Jev timed out.' })
    expect(first.ms).toBeGreaterThanOrEqual(1900)
    expect(first.ms).toBeLessThan(3000)
    const second = await call()
    expect(second.ms).toBeLessThan(100)
    expect(second.body.note).toBe('Jev is paused for a minute after a failure.')
    expect(slow.mock.calls).toHaveLength(1)
  })
})

describe('model context and instructions', () => {
  const library = { openBook: { title: 'Calculus Volume 1' }, books: [{ title: 'Calculus Volume 1', pages: 873 }, { title: 'Algebra', pages: 410 }] }
  it('voice instructions carry the rules only; the first context item carries the board', () => {
    const busy: BoardContext = { ...board, objects: [{ id: 'shape:plot', kind: 'plot', bounds: { x: 0, y: 0, w: 440, h: 320 }, rotation: 0, expression: 'x^2' }] }
    const config = realtimeConfig(busy, true, 'gpt-realtime-mini')
    expect(config.instructions).toBe(BOARD_INSTRUCTIONS)
    expect(config.instructions).not.toContain('CURRENT BOARD SNAPSHOT')
    expect(config.instructions).not.toContain('shape:plot')
  })
  it('accepts a library context without book ids', () => {
    expect(contextSchema.safeParse({ ...board, library }).success).toBe(true)
    expect(contextSchema.safeParse({ ...board, library: { ...library, openBook: { id: 'sha256:abc', title: 'Calculus Volume 1' } } }).success).toBe(true)
  })
  it('accepts the reference panel page and tells the model what "this page" means', () => {
    for (const panelPage of [{ label: '234', pageIndex: 245 }, { label: null, pageIndex: 3 }, null, undefined]) {
      expect(contextSchema.safeParse({ ...board, library: { ...library, panelPage } }).success).toBe(true)
    }
    for (const panelPage of [{ label: '234', pageIndex: -1 }, { label: '234', pageIndex: 1.5 }, { label: 234, pageIndex: 3 }]) {
      expect(contextSchema.safeParse({ ...board, library: { ...library, panelPage } }).success).toBe(false)
    }
    const snapshot = snapshotOf(contextSchema.parse({ ...board, library: { ...library, panelPage: { label: '234', pageIndex: 245 } } }))
    expect(snapshot.library.panelPage).toEqual({ label: '234', pageIndex: 245 })
    expect(BOARD_INSTRUCTIONS).toContain('"the page I\'m looking at"')
    expect(BOARD_INSTRUCTIONS).toContain('means library.panelPage')
    expect(BOARD_INSTRUCTIONS).toContain('{"type":"insert_library","page":"234"}')
  })
  it('lists the graph functions and says log is the natural log', () => {
    expect(BOARD_INSTRUCTIONS).toContain('sec csc cot')
    expect(BOARD_INSTRUCTIONS).toContain('cbrt')
    expect(BOARD_INSTRUCTIONS).toContain('log(x) is natural log, use log10(x) for base 10')
    expect(BOARD_INSTRUCTIONS).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('iPad tunnel', () => {
  const temp: string[] = []
  afterAll(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }) })
  const sandbox = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tunnel-'))
    temp.push(root)
    mkdirSync(path.join(root, 'server'))
    copyFileSync(fileURLToPath(new URL('../server/start-tunnel.mjs', import.meta.url)), path.join(root, 'server', 'start-tunnel.mjs'))
    return root
  }
  const run = (root: string, env: Record<string, string>) => new Promise<{ code: number; out: string; err: string }>(resolve => {
    execFile(process.execPath, [path.join(root, 'server', 'start-tunnel.mjs')], { env, timeout: 30_000 }, (error, out, err) => resolve({ code: error ? Number(error.code ?? 1) : 0, out, err }))
  })

  it.skipIf(process.platform === 'win32')('starts cloudflared on PORT, prints the URL and saves the host', async () => {
    const root = sandbox()
    mkdirSync(path.join(root, '.local'))
    const fake = path.join(root, '.local', 'cloudflared')
    writeFileSync(fake, '#!/bin/sh\necho "args: $*" >&2\necho "INF |  https://quiet-fox-12.trycloudflare.com  |" >&2\nexec sleep 30\n')
    chmodSync(fake, 0o755)
    const result = await run(root, { PATH: process.env.PATH ?? '', PORT: '4321' })
    const pid = Number(result.out.match(/Tunnel PID: (\d+)/)?.[1])
    try {
      expect(result.code).toBe(0)
      expect(result.out).toContain('iPad URL: https://quiet-fox-12.trycloudflare.com')
      expect(result.out).toContain(`kill ${pid}`)
      expect(readFileSync(path.join(root, '.local', 'preview-host.txt'), 'utf8')).toBe('quiet-fox-12.trycloudflare.com')
      const log = readdirSync(path.join(root, '.local')).find(name => name.startsWith('tunnel-'))!
      expect(readFileSync(path.join(root, '.local', log), 'utf8')).toContain('args: tunnel --no-autoupdate --url http://localhost:4321')
    } finally { if (pid) try { process.kill(pid) } catch { /* already gone */ } }
  })

  it.skipIf(process.platform === 'win32')('explains a missing cloudflared and a bad PORT', async () => {
    const root = sandbox()
    const empty = mkdtempSync(path.join(os.tmpdir(), 'nopath-'))
    temp.push(empty)
    const missing = await run(root, { PATH: empty })
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('cloudflared was not found')
    expect(existsSync(path.join(root, '.local', 'preview-host.txt'))).toBe(false)
    const port = await run(root, { PATH: empty, PORT: 'abc' })
    expect(port.code).toBe(1)
    expect(port.err).toContain('PORT must be a port number')
  })

  it('the dev server accepts quick tunnel hosts and still blocks others', async () => {
    const { createServer: createViteServer } = await import('vite')
    const root = mkdtempSync(path.join(os.tmpdir(), 'hosts-'))
    temp.push(root)
    const vite = await createViteServer({ root, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, allowedHosts: DEV_ALLOWED_HOSTS } })
    const http: Server = createServer((req, res) => vite.middlewares(req, res, () => { res.end('ok') }))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as AddressInfo).port
    const get = (host: string) => new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
    })
    try {
      expect(await get('quiet-fox-12.trycloudflare.com')).toBe(200)
      expect(await get(`localhost:${port}`)).toBe(200)
      expect(await get('evil.example')).toBe(403)
      expect(await get('trycloudflare.com.evil.example')).toBe(403)
    } finally {
      await new Promise(resolve => http.close(resolve))
      await vite.close()
    }
  })
})
