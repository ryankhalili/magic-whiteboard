import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealtimeClient } from '../src/ai/realtime'
import { apiRequest, sendBoardCommand, SERVER_UNREACHABLE } from '../src/ai/commands'
import { isTransientVoiceError, pinRecoveredCommand, voiceApiRequest } from '../src/ai/voice-recovery'
import type { BoardContext, BoardOperation, BoardResult } from '../shared/board'

class FakeChannel extends EventTarget {
  readyState = 'connecting'
  sent: any[] = []
  refuse: ((value: string) => boolean) | null = null
  send(value: string) {
    if (this.refuse?.(value)) throw new TypeError('Message too large')
    this.sent.push(JSON.parse(value))
  }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')) }
  receive(event: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })) }
}
class FakePeer extends EventTarget {
  static latest: FakePeer
  channel = new FakeChannel()
  connectionState = 'new'
  closed = false
  constructor() { super(); FakePeer.latest = this }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() { return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' } }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')) }
  close() { this.closed = true }
}

const base: BoardContext = { focus: null, pointer: { x: 12, y: 14 }, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body })
const call = (id: string, operations: BoardOperation[]) => ({ type: 'function_call', call_id: id, name: 'apply_board_operations', arguments: JSON.stringify({ operations, message: '' }) })
const creates = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'response.create')
const outputs = (channel: FakeChannel) => channel.sent.filter(event => event.item?.type === 'function_call_output').map(event => JSON.parse(event.item.output))
const contextItems = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'conversation.item.create' && event.item?.role === 'system')
const snapshot = (event: any) => JSON.parse(event.item.content[0].text.split('\n').slice(1).join('\n'))

async function speak(channel: FakeChannel, item: string, transcript?: string) {
  channel.receive({ type: 'input_audio_buffer.speech_started', item_id: item })
  channel.receive({ type: 'input_audio_buffer.speech_stopped', item_id: item })
  channel.receive({ type: 'input_audio_buffer.committed', item_id: item })
  if (transcript !== undefined) channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript })
  await vi.advanceTimersByTimeAsync(0)
}
async function respond(channel: FakeChannel, id: string, output: unknown[] = [], status = 'completed') {
  channel.receive({ type: 'response.created', response: { id } })
  for (const item of output as any[]) channel.receive({ ...item, type: 'response.function_call_arguments.done', response_id: id })
  await vi.advanceTimersByTimeAsync(0)
  channel.receive({ type: 'response.done', response: { id, status, output } })
  await vi.advanceTimersByTimeAsync(0)
}

describe('voice fixes', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let track: { stop: ReturnType<typeof vi.fn>; enabled: boolean }
  const handlers = (overrides: Record<string, unknown> = {}) => ({
    getContext: () => base, applyOperations: vi.fn((): BoardResult | BoardResult[] | Promise<BoardResult> => ({ ok: true, message: 'Applied.', ids: ['shape:1'] })),
    onStatus: vi.fn(), onTranscript: vi.fn(), onAssistant: vi.fn(), onError: vi.fn(), onNotice: vi.fn(), onRecoveryState: vi.fn(), ...overrides,
  })
  beforeEach(() => {
    vi.useFakeTimers()
    track = { stop: vi.fn(), enabled: true }
    fetchMock = vi.fn(async (url: string) => reply(200, url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 } : { ok: true }))
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }) } })
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  describe('V1 brief tool results', () => {
    it('sends a short result for a successful edit and refreshes the context item right after it', async () => {
      const big = Array.from({ length: 80 }, (_, i) => `shape:${i}`)
      const board: BoardContext = { ...base, objects: Array.from({ length: 40 }, (_, i) => ({ id: `shape:p${i}`, kind: 'pdf_page', text: 'Solve 3x^2 + 2x - 7 = 0. '.repeat(60), bounds: { x: 0, y: i * 1100, w: 816, h: 1056 }, rotation: 0 })) }
      const h = handlers({ getContext: () => board, applyOperations: vi.fn(() => ({ ok: true, message: 'Created 80 shapes.', ids: big, objects: board.objects })) })
      const client = createRealtimeClient(h)
      await client.connect()
      const channel = FakePeer.latest.channel
      await speak(channel, 'in1', 'write x squared')
      await respond(channel, 'r1', [call('c1', [{ type: 'create_math', latex: 'x^2' }])])
      const [output] = outputs(channel)
      expect(output).toEqual({ results: { ok: true, message: 'Created 80 shapes.', ids: big.slice(0, 50), idCount: 80 } })
      const raw = channel.sent.find(event => event.item?.type === 'function_call_output').item.output as string
      expect(raw.length).toBeLessThan(2000)
      // the output, then the fresh board snapshot, then the confirmation response
      const outputAt = channel.sent.findIndex(event => event.item?.type === 'function_call_output')
      const contextAt = channel.sent.findIndex((event, index) => index > outputAt && event.type === 'conversation.item.create' && event.item?.role === 'system')
      const responseAt = channel.sent.findIndex((event, index) => index > outputAt && event.type === 'response.create')
      expect(contextAt).toBeGreaterThan(outputAt)
      expect(responseAt).toBeGreaterThan(contextAt)
      client.disconnect()
    })
    it('keeps the board context on a failed edit so the correction can read it', async () => {
      const failure: BoardResult = { ok: false, message: 'Unsupported LaTeX command \\answer.', ids: [] }
      const board: BoardContext = { ...base, selectedIds: ['math:a'], objects: [{ id: 'math:a', kind: 'math', latex: 'x^2', bounds: { x: 0, y: 0, w: 240, h: 80 }, rotation: 0 }] }
      const client = createRealtimeClient(handlers({ getContext: () => board, applyOperations: vi.fn(() => failure) }))
      await client.connect()
      const channel = FakePeer.latest.channel
      await respond(channel, 'r1', [call('c1', [{ type: 'edit_content', field: 'latex', replacement: '=\\answer' }])])
      expect(outputs(channel)[0]).toMatchObject({ results: failure, recovery: { attemptsRemaining: 1 }, context: { objects: [{ id: 'math:a', latex: 'x^2' }] } })
      client.disconnect()
    })
    it('a tool output the data channel refuses ends that turn and later turns still get answers', async () => {
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      const channel = FakePeer.latest.channel
      channel.refuse = value => value.includes('function_call_output')
      await speak(channel, 'in1', 'write x squared')
      await respond(channel, 'r1', [call('c1', [{ type: 'create_math', latex: 'x^2' }])])
      expect(h.applyOperations).toHaveBeenCalledTimes(1)
      expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('could not send that update'))
      expect(client.getDiagnostics()).toMatchObject({ executions: 0, responses: 0 })
      channel.refuse = null
      const before = creates(channel).length
      await speak(channel, 'in2', 'write y squared')
      expect(creates(channel)).toHaveLength(before + 1)
      await respond(channel, 'r2', [call('c2', [{ type: 'create_math', latex: 'y^2' }])])
      expect(h.applyOperations).toHaveBeenCalledTimes(2)
      expect(outputs(channel)).toHaveLength(1)
      expect(creates(channel)).toHaveLength(before + 2)
      client.disconnect()
    })
    it('a refused context snapshot falls back to short texts', async () => {
      let board = base
      const client = createRealtimeClient(handlers({ getContext: () => board }))
      await client.connect()
      const channel = FakePeer.latest.channel
      channel.refuse = value => value.length > 4000
      board = { ...base, selectedIds: ['shape:page'], objects: [{ id: 'shape:page', kind: 'pdf_page', text: 'x'.repeat(5000), bounds: { x: 0, y: 0, w: 816, h: 1056 }, rotation: 0 }] }
      client.updateContext()
      await vi.advanceTimersByTimeAsync(160)
      const items = contextItems(channel)
      expect(items).toHaveLength(2)
      expect(snapshot(items[1]).objects[0].text).toHaveLength(300)
      expect(channel.sent.filter(event => event.type === 'conversation.item.delete').map(event => event.item_id)).toEqual([items[0].item.id])
      client.disconnect()
    })
  })

  describe('V2 id lists in the voice context', () => {
    it('sends at most 100 ids per list plus the full count, in the session request and the context item', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `shape:ink${i}`)
      const board: BoardContext = { ...base, selectedIds: ids, lastCreatedIds: ids.slice(0, 20), focus: { kind: 'region', bounds: { x: 0, y: 0, w: 500, h: 300 }, targetIds: ids } }
      const client = createRealtimeClient(handlers({ getContext: () => board }))
      await client.connect()
      const request = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/session'))![1].body)
      for (const context of [request.context, snapshot(contextItems(FakePeer.latest.channel)[0])]) {
        expect(context.selectedIds).toHaveLength(100)
        expect(context.selectedCount).toBe(150)
        expect(context.focus.targetIds).toHaveLength(100)
        expect(context.focus.targetCount).toBe(150)
        expect(context.lastCreatedIds).toHaveLength(20)
        expect(context.lastCreatedCount).toBeUndefined()
      }
      client.disconnect()
    })
  })

  describe('V4 reconnect', () => {
    it('continues after a failed stop and retries with backoff until the laptop answers', async () => {
      let sessions = 0
      const times: number[] = []
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      const start = Date.now()
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/stop')) throw new TypeError('Failed to fetch')
        times.push(Date.now() - start)
        return ++sessions < 4 ? reply(502, { error: 'The AI request could not finish.', code: 'temporary_failure', retryable: true }) : reply(200, { sdp: 'answer', sessionId: 'rtc_2', maxDurationSeconds: 300 })
      })
      FakePeer.latest.connectionState = 'disconnected'; FakePeer.latest.dispatchEvent(new Event('connectionstatechange'))
      await vi.advanceTimersByTimeAsync(10_000)
      // the failed stop is retried once after 0.5 s, then the session is asked for again after 0.5, 1 and 2 s
      expect(times).toEqual([500, 1000, 2000, 4000])
      expect(client.isConnected()).toBe(true)
      expect(h.onError).not.toHaveBeenCalled()
      client.disconnect()
    })
    it('still stops at an authentication failure', async () => {
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      fetchMock.mockClear()
      fetchMock.mockImplementation(async (url: string) => url.endsWith('/stop') ? reply(200, { ok: true }) : reply(401, { error: 'Pair this device using the six-digit code shown on the laptop.', code: 'pairing_required', retryable: false }))
      FakePeer.latest.connectionState = 'failed'; FakePeer.latest.dispatchEvent(new Event('connectionstatechange'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1)
      expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Pair this device'))
      expect(client.isConnected()).toBe(false)
    })
  })

  describe('V6 library operations in a repaired voice command', () => {
    it('passes insert_library and library_action through without a board target', () => {
      const operations: BoardOperation[] = [{ type: 'insert_library', book: 'Calculus', page: '22' }, { type: 'library_action', action: 'store_import' }]
      expect(pinRecoveredCommand({ operations, message: '' }, base)).toEqual(operations)
      expect(pinRecoveredCommand({ operations, message: '' }, { ...base, lastCreatedIds: ['shape:old'] })).toEqual(operations)
    })
    it('a repaired spoken page request is applied instead of refused', async () => {
      const repairRequest = vi.fn(async () => ({ operations: [{ type: 'insert_library', page: '22' } as BoardOperation], message: 'Page 22 is on the board.' }))
      const h = handlers({ repairRequest })
      const client = createRealtimeClient(h)
      await client.connect(); client.sendText('put page 22 on the board')
      await respond(FakePeer.latest.channel, 'r1', [call('c1', [{ type: 'insert_library', page: 22 } as unknown as BoardOperation])])
      expect(repairRequest).toHaveBeenCalledTimes(1)
      expect(h.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'insert_library', page: '22' }])
      expect(h.onError).not.toHaveBeenCalled()
      client.disconnect()
    })
  })

  describe('V8 the last minute of the allowance', () => {
    it('a short session does not renew early; it ends with the allowance notice', async () => {
      fetchMock.mockImplementation(async (url: string) => reply(200, url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_last', maxDurationSeconds: 15 } : { ok: true }))
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      await vi.advanceTimersByTimeAsync(13_000)
      expect(client.isConnected()).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(client.isConnected()).toBe(false)
      expect(h.onNotice).toHaveBeenCalledWith('Voice allowance is almost used up.')
      expect(h.onRecoveryState).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'renewing' }))
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1)
      expect(h.onError).not.toHaveBeenCalled()
    })
  })

  describe('V10 refused library requests', () => {
    it('shows only the board message', async () => {
      const h = handlers({ applyOperations: vi.fn(async () => ({ ok: false, message: 'Page 900 is not in Calculus Volume 1.', ids: [] })) })
      const client = createRealtimeClient(h)
      await client.connect(); client.sendText('insert page 900')
      await respond(FakePeer.latest.channel, 'r1', [call('c1', [{ type: 'insert_library', page: '900' }])])
      expect(h.onError).toHaveBeenCalledExactlyOnceWith('Page 900 is not in Calculus Volume 1.')
      client.disconnect()
    })
  })

  describe('COST F3 fillers and empty utterances', () => {
    it.each(['', 'um', 'Uh.', 'hmm...', 'Okay.', 'ok', 'So', 'um, okay'])('cancels the reply to %j and applies nothing', async transcript => {
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      const channel = FakePeer.latest.channel
      await speak(channel, 'in1', transcript)
      expect(creates(channel)).toHaveLength(1)
      expect(channel.sent.filter(event => event.type === 'response.cancel')).toHaveLength(1)
      await respond(channel, 'r1', [call('c1', [{ type: 'create_text', text: 'Um' }])], 'cancelled')
      expect(h.applyOperations).not.toHaveBeenCalled()
      expect(h.onError).not.toHaveBeenCalled()
      expect(creates(channel)).toHaveLength(1)
      expect(h.onStatus).toHaveBeenLastCalledWith('listening')
      client.disconnect()
    })
    it('cancels a reply that already started and ignores its tool call', async () => {
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      const channel = FakePeer.latest.channel
      await speak(channel, 'in1')
      channel.receive({ type: 'response.created', response: { id: 'r1' } })
      channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'in1', transcript: 'um' })
      channel.receive({ ...call('c1', [{ type: 'create_text', text: 'um' }]), type: 'response.function_call_arguments.done', response_id: 'r1' })
      channel.receive({ type: 'response.output_text.done', response_id: 'r1', text: 'What would you like?' })
      await vi.advanceTimersByTimeAsync(0)
      expect(channel.sent.filter(event => event.type === 'response.cancel')).toHaveLength(1)
      expect(h.applyOperations).not.toHaveBeenCalled()
      expect(h.onAssistant).not.toHaveBeenCalled()
      client.disconnect()
    })
    it('lets a busy command finish when a filler is heard while it is being answered', async () => {
      const client = createRealtimeClient(handlers())
      await client.connect()
      const channel = FakePeer.latest.channel
      client.sendText('write x squared')
      channel.receive({ type: 'response.created', response: { id: 'r1' } })
      await speak(channel, 'in2', 'hmm')
      channel.receive({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } })
      await vi.advanceTimersByTimeAsync(0)
      expect(creates(channel)).toHaveLength(2)
      client.disconnect()
    })
    it('leaves real instructions, including ones that start with a filler, alone', async () => {
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      const channel = FakePeer.latest.channel
      for (const [index, transcript] of ['so plot y equals x squared', 'okay everyone, write the derivative', 'undo'].entries()) {
        await speak(channel, `in${index}`, transcript)
        await respond(channel, `r${index}`, [call(`c${index}`, [{ type: 'create_text', text: transcript }])])
        await respond(channel, `k${index}`)
      }
      expect(channel.sent.filter(event => event.type === 'response.cancel')).toHaveLength(0)
      expect(h.applyOperations).toHaveBeenCalledTimes(3)
      client.disconnect()
    })
  })

  describe('V3 page reload', () => {
    it('ends the laptop call with a keepalive stop when the page is hidden', async () => {
      const page = new EventTarget()
      vi.stubGlobal('window', Object.assign(page, { isSecureContext: true }))
      const h = handlers()
      const client = createRealtimeClient(h)
      await client.connect()
      fetchMock.mockClear()
      page.dispatchEvent(new Event('pagehide'))
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/realtime/stop', expect.objectContaining({ keepalive: true, body: JSON.stringify({ sessionId: 'rtc_test' }) }))
      expect(client.isConnected()).toBe(false)
      expect(h.onStatus).toHaveBeenLastCalledWith('idle')
      page.dispatchEvent(new Event('pagehide'))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})

describe('B9 and B3 request helpers', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const failures: [string, () => Promise<unknown>][] = [
    ['Chrome network error', async () => { throw new TypeError('Failed to fetch') }],
    ['Safari network error', async () => { throw new TypeError('Load failed') }],
    ['tunnel 502 page', async () => new Response('<!DOCTYPE html><html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['tunnel 530 page', async () => new Response('<html>error code: 1033</html>', { status: 530 })],
    ['deadline', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }],
  ]
  it.each(failures)('typed commands explain a %s plainly', async (_name, fetcher) => {
    vi.stubGlobal('fetch', fetcher)
    await expect(sendBoardCommand('plot y = x^2', base)).rejects.toMatchObject({ message: SERVER_UNREACHABLE, code: 'server_unreachable' })
  })
  it.each(failures)('voice requests explain a %s plainly and stay retryable', async (_name, fetcher) => {
    vi.stubGlobal('fetch', fetcher)
    const error = await voiceApiRequest<never>('/api/realtime/session', {}).catch((caught: Error) => caught)
    expect(error.message).toBe(SERVER_UNREACHABLE)
    expect(isTransientVoiceError(error)).toBe(true)
  })
  it('keeps server messages, readable errors and cancellation as they were', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Pair this device using the six-digit code shown on the laptop.', code: 'pairing_required' }), { status: 401 }))
    await expect(apiRequest('/api/command', {})).rejects.toMatchObject({ status: 401, code: 'pairing_required' })
    vi.stubGlobal('fetch', async () => new Response('Blocked request.', { status: 403 }))
    await expect(apiRequest('/api/command', {})).rejects.toThrow('unreadable')
    const abort = new AbortController(); abort.abort()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { throw init.signal!.reason })
    await expect(apiRequest('/api/command', {}, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(voiceApiRequest('/api/realtime/session', {}, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('trims each history text to what the server accepts', async () => {
    let sent: any
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ operations: [], message: 'ok' })) })
    const paste = 'A ladder 10 m long rests against a vertical wall. '.repeat(70)
    await sendBoardCommand('plot y = x^2', base, [{ role: 'user', text: paste }, { role: 'assistant', text: 'Done.' }])
    expect(paste.length).toBeGreaterThan(3000)
    expect(sent.history).toEqual([{ role: 'user', text: paste.slice(0, 3000) }, { role: 'assistant', text: 'Done.' }])
  })
})
