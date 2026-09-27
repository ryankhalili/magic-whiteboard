import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealtimeClient, type RealtimeClient } from '../src/ai/realtime'
import type { BoardContext } from '../shared/board'

class FakeChannel extends EventTarget {
  readyState = 'connecting'
  sent: any[] = []
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')) }
  receive(event: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })) }
}
class FakePeer extends EventTarget {
  static latest: FakePeer
  channel = new FakeChannel()
  connectionState = 'new'
  constructor() { super(); FakePeer.latest = this }
  addTrack() {}
  createDataChannel() { return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' } }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')) }
  close() {}
}
const initialContext: BoardContext = { focus: null, pointer: { x: 10, y: 20 }, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const responseRequests = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'response.create')
const userItems = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'conversation.item.create' && event.item?.role === 'user')
const rateError = (message = 'Rate limit reached on tokens per min. Please try again in 2s.') => ({ code: 'rate_limit_exceeded', type: 'tokens', message })

describe('bounded rate recovery over the existing voice connection', () => {
  let current: BoardContext
  let track: { stop: ReturnType<typeof vi.fn>; enabled: boolean }
  let fetchMock: ReturnType<typeof vi.fn>
  let getUserMedia: ReturnType<typeof vi.fn>
  const clients: RealtimeClient[] = []
  const handlers = () => ({ getContext: () => current, applyOperations: vi.fn(() => ({ ok: true, message: 'Applied.', ids: ['math:a'] })), repairRequest: vi.fn(),
    onStatus: vi.fn(), onRecoveryState: vi.fn(), onTranscript: vi.fn(), onAssistant: vi.fn(), onError: vi.fn(), onNotice: vi.fn(), spokenReplies: false })
  beforeEach(() => {
    vi.useFakeTimers(); current = structuredClone(initialContext)
    track = { stop: vi.fn(), enabled: true }
    getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }))
    fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 } : { ok: true } }))
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals() })
  async function start() {
    const callbacks = handlers(), client = createRealtimeClient(callbacks)
    clients.push(client); await client.connect(); client.sendText('Write the integral of sine x')
    return { callbacks, client, channel: FakePeer.latest.channel, peer: FakePeer.latest }
  }
  function sessionRequests() { return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session')) }
  function rejectRequest(channel: FakeChannel, request = responseRequests(channel).at(-1), error = rateError()) {
    channel.receive({ type: 'error', error: { ...error, event_id: request.event_id } })
  }
  async function rejectResponse(channel: FakeChannel, id: string, error = rateError()) {
    channel.receive({ type: 'response.created', response: { id } })
    channel.receive({ type: 'response.done', response: { id, status: 'failed', status_details: { error }, output: [] } })
    await vi.advanceTimersByTimeAsync(0)
  }

  it('waits for a top-level request rejection, then retries the response once on the same connection', async () => {
    const { callbacks, client, channel, peer } = await start()
    const first = responseRequests(channel)[0]
    rejectRequest(channel)
    expect(track.enabled).toBe(false)
    expect(callbacks.onRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'waiting', attempt: 1 }))
    expect(() => client.sendText('Do something else')).toThrow('paused')
    await vi.advanceTimersByTimeAsync(1999)
    expect(responseRequests(channel)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(responseRequests(channel)).toHaveLength(2)
    expect(responseRequests(channel)[1].event_id).not.toBe(first.event_id)
    expect(userItems(channel)).toHaveLength(1)
    expect(FakePeer.latest).toBe(peer)
    expect(sessionRequests()).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(track.enabled).toBe(true)
  })
  it('uses rate_limits.updated resets without treating output reservations alone as failures', async () => {
    const { callbacks, channel } = await start()
    channel.receive({ type: 'rate_limits.updated', rate_limits: [{ name: 'tokens', remaining: 0, reset_seconds: 4 }] })
    expect(track.enabled).toBe(true)
    expect(callbacks.onRecoveryState).not.toHaveBeenCalled()
    rejectRequest(channel, undefined, rateError('Rate limit reached on tokens per min.'))
    await vi.advanceTimersByTimeAsync(3999)
    expect(responseRequests(channel)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(responseRequests(channel)).toHaveLength(2)
    expect(sessionRequests()).toHaveLength(1)
  })
  it('handles a terminal rate-limit response with one same-session retry and no Luna correction', async () => {
    const { callbacks, channel } = await start()
    await rejectResponse(channel, 'limited-response')
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(track.enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(responseRequests(channel)).toHaveLength(2)
    channel.receive({ type: 'response.created', response: { id: 'retry-response' } })
    channel.receive({ type: 'response.done', response: { id: 'retry-response', status: 'completed', output: [{ type: 'function_call', call_id: 'once', name: 'apply_board_operations', arguments: '{"operations":[{"type":"create_math","latex":"x"}],"message":"Added."}' }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'create_math', latex: 'x' }])
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(responseRequests(channel)).toHaveLength(2)
    expect(sessionRequests()).toHaveLength(1)
  })
  it('keeps an already applied edit and never replays it after a later rate failure', async () => {
    const { callbacks, channel } = await start()
    channel.receive({ type: 'response.created', response: { id: 'partly-finished' } })
    const call = { type: 'function_call', call_id: 'applied', name: 'apply_board_operations', arguments: '{"operations":[{"type":"create_math","latex":"x"}],"message":"Added."}' }
    channel.receive({ ...call, type: 'response.function_call_arguments.done', response_id: 'partly-finished' })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.applyOperations).toHaveBeenCalledTimes(1)
    channel.receive({ type: 'response.done', response: { id: 'partly-finished', status: 'failed', status_details: { error: rateError() }, output: [call] } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(callbacks.applyOperations).toHaveBeenCalledTimes(1)
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onNotice).toHaveBeenCalledWith(expect.stringContaining('Applied edits were kept'))
    expect(track.enabled).toBe(true)
  })
  it('does not retry against a board or selection changed during the wait', async () => {
    const { callbacks, channel } = await start()
    rejectRequest(channel)
    current = { ...current, pointer: { x: 500, y: 600 }, selectedIds: ['another-object'] }
    await vi.advanceTimersByTimeAsync(2000)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onNotice).toHaveBeenCalledWith(expect.stringContaining('current selection'))
    expect(track.enabled).toBe(true)
  })
  it('ignores duplicate or late rejections belonging to an old request', async () => {
    const { callbacks, client, channel } = await start()
    const old = responseRequests(channel)[0]
    rejectRequest(channel, old)
    rejectRequest(channel, old)
    await vi.advanceTimersByTimeAsync(2000)
    expect(responseRequests(channel)).toHaveLength(2)
    rejectRequest(channel, old)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isConnected()).toBe(true)
    expect(track.enabled).toBe(true)
    expect(responseRequests(channel)).toHaveLength(2)
    expect(callbacks.onNotice).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('cancels the pending wait on Stop and never reconnects or resends later', async () => {
    const { callbacks, client, channel } = await start()
    rejectRequest(channel)
    client.disconnect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(sessionRequests()).toHaveLength(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(false)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'])('pauses the session after the second %s rate rejection without looping', async path => {
    const { callbacks, client, channel } = await start()
    if (path === 'request') rejectRequest(channel)
    else await rejectResponse(channel, 'first')
    await vi.advanceTimersByTimeAsync(2000)
    if (path === 'request') rejectRequest(channel)
    else await rejectResponse(channel, 'second')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.isConnected()).toBe(false)
    expect(responseRequests(channel)).toHaveLength(2)
    expect(sessionRequests()).toHaveLength(1)
    expect(callbacks.onNotice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('still rate limited'))
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'])('keeps exhausted credit fatal for %s errors', async path => {
    const { callbacks, client, channel } = await start()
    const quota = { code: 'insufficient_quota', type: 'tokens', message: 'You exceeded your current quota. Check billing.' }
    if (path === 'request') rejectRequest(channel, undefined, quota)
    else await rejectResponse(channel, 'quota', quota)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.isConnected()).toBe(false)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
  })
  it('does not retry a provider request that requires a wait longer than one minute', async () => {
    const { callbacks, client, channel } = await start()
    rejectRequest(channel, undefined, rateError('Rate limit reached. Please try again in 90s.'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(client.isConnected()).toBe(false)
    expect(callbacks.onNotice).toHaveBeenCalledWith(expect.stringContaining('still rate limited'))
  })
})
