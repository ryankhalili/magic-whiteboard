import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkVoiceConnection, createRealtimeClient } from '../src/ai/realtime'
import type { BoardContext, BoardOperation, BoardResult } from '../shared/board'

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

const context: BoardContext = { focus: null, pointer: { x: 12, y: 14 }, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const mathContext: BoardContext = { ...context, selectedIds: ['math:a'], objects: [
  { id: 'math:a', kind: 'math', latex: 'x^2', bounds: { x: 0, y: 0, w: 240, h: 80 }, rotation: 0 },
  { id: 'math:b', kind: 'math', latex: 'y^2', bounds: { x: 400, y: 0, w: 240, h: 80 }, rotation: 0 },
] }
const mathFailure: BoardResult = { ok: false, message: 'Unsupported LaTeX command \\answer.', ids: [] }
const brokenEdit: BoardOperation = { type: 'edit_content', field: 'latex', replacement: '=\\answer' }
const correctedEdit: BoardOperation = { type: 'update_object', latex: 'x^2 = ?' }
function toolCall(id: string, operations: BoardOperation[]) {
  return { type: 'function_call', call_id: id, name: 'apply_board_operations', arguments: JSON.stringify({ operations, message: '' }) }
}
async function finishResponse(channel: FakeChannel, id: string, output: unknown[] = [], status = 'completed') {
  channel.receive({ type: 'response.created', response: { id } })
  channel.receive({ type: 'response.done', response: { id, status, output } })
  await vi.advanceTimersByTimeAsync(0)
}
const responseRequests = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'response.create')
const toolOutputs = (channel: FakeChannel) => channel.sent.filter(event => event.item?.type === 'function_call_output').map(event => JSON.parse(event.item.output))

describe('voice lifecycle without microphone or paid API calls', () => {
  let stopTrack: ReturnType<typeof vi.fn>
  let media: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>
  const callbacks = () => ({ getContext: () => context, applyOperations: vi.fn(() => ({ ok: true, message: 'Applied.', ids: ['shape:1'] })), onStatus: vi.fn(), onTranscript: vi.fn(), onAssistant: vi.fn(), onError: vi.fn() })
  beforeEach(() => {
    vi.useFakeTimers()
    stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }], getAudioTracks: () => [{ stop: stopTrack }] }
    media = vi.fn().mockResolvedValue(stream)
    fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 } : { ok: true } }))
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } })
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('does not request a microphone on construction and closes media on stop', async () => {
    const handlers = callbacks()
    const client = createRealtimeClient(handlers)
    expect(media).not.toHaveBeenCalled()
    await client.connect()
    expect(media).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(true)
    client.disconnect()
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(FakePeer.latest.closed).toBe(true)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/realtime/stop', expect.objectContaining({ method: 'POST' }))
    expect(handlers.onStatus).toHaveBeenLastCalledWith('idle')
  })
  it('stops a microphone that resolves after the user has already cancelled', async () => {
    let resolveMedia!: (stream: unknown) => void
    media.mockImplementation(() => new Promise(resolve => { resolveMedia = resolve }))
    const client = createRealtimeClient(callbacks())
    const pending = client.connect()
    client.disconnect()
    resolveMedia({ getTracks: () => [{ stop: stopTrack }] })
    await pending
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('closes the microphone after 90 seconds without speech', async () => {
    const handlers = callbacks()
    const client = createRealtimeClient(handlers)
    await client.connect()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(client.isConnected()).toBe(false)
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('90 seconds'))
  })
  it('sends current pen context before requesting a response to speech', async () => {
    const client = createRealtimeClient(callbacks())
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.sent = []
    channel.receive({ type: 'input_audio_buffer.committed' })
    const snapshot = channel.sent.findIndex(e => e.type === 'conversation.item.create')
    const response = channel.sent.findIndex(e => e.type === 'response.create')
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(response).toBeGreaterThan(snapshot)
    client.disconnect()
  })
  it('uses unique context item IDs within the 32-character protocol limit at startup and replacement', async () => {
    let current = context
    const client = createRealtimeClient({ ...callbacks(), getContext: () => current })
    await client.connect()
    const channel = FakePeer.latest.channel
    const initial = channel.sent.filter(e => e.type === 'conversation.item.create' && e.item.role === 'system')
    expect(initial).toHaveLength(1)
    current = { ...context, pointer: { x: 80, y: 90 } }
    client.updateContext()
    await vi.advanceTimersByTimeAsync(160)
    current = { ...context, pointer: { x: 180, y: 190 } }
    client.updateContext()
    await vi.advanceTimersByTimeAsync(160)
    const snapshots = channel.sent.filter(e => e.type === 'conversation.item.create' && e.item.role === 'system')
    expect(snapshots).toHaveLength(3)
    const ids = snapshots.map(e => e.item.id as string)
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0)
      expect(id.length).toBeLessThanOrEqual(32)
    }
    expect(new Set(ids).size).toBe(ids.length)
    const deletions = channel.sent.filter(e => e.type === 'conversation.item.delete')
    expect(deletions.map(e => e.item_id)).toEqual(ids.slice(0, -1))
    expect(channel.sent.findIndex(e => e.type === 'conversation.item.delete' && e.item_id === ids[0])).toBeLessThan(channel.sent.findIndex(e => e.item?.id === ids[1]))
    expect(channel.sent.findIndex(e => e.type === 'conversation.item.delete' && e.item_id === ids[1])).toBeLessThan(channel.sent.findIndex(e => e.item?.id === ids[2]))
    client.disconnect()
  })
  it('closes media on an unrecoverable protocol error', async () => {
    const handlers = callbacks()
    const client = createRealtimeClient(handlers)
    await client.connect()
    FakePeer.latest.channel.receive({ type: 'error', error: { code: 'invalid_request', message: 'Invalid session.' } })
    expect(handlers.onError).toHaveBeenCalledWith('Invalid session.')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(false)
  })
  it('applies completed arguments immediately, then deduplicates the response.done fallback', async () => {
    const handlers = callbacks()
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'response.created', response: { id: 'resp1' } })
    const call = { type: 'function_call', call_id: 'call1', name: 'apply_board_operations', arguments: JSON.stringify({ operations: [{ type: 'create_math', latex: 'x^2' }], message: '' }) }
    channel.receive({ ...call, response_id: 'resp1', type: 'response.function_call_arguments.done' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(channel.sent.filter(e => e.type === 'response.create')).toHaveLength(0)
    channel.receive({ type: 'response.done', response: { id: 'resp1', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(channel.sent.filter(e => e.type === 'response.create')).toHaveLength(1)
    client.disconnect()
  })
  it('clears generated previews and skips a late tool from an interrupted response', async () => {
    const handlers = { ...callbacks(), onContentPreview: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'response.created', response: { id: 'resp2' } })
    channel.receive({ type: 'response.function_call_arguments.delta', response_id: 'resp2', call_id: 'call2', delta: '{"operations":[{"type":"create_text","text":"Hello' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'Hello' }))
    channel.receive({ type: 'input_audio_buffer.speech_started' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    channel.receive({ type: 'response.function_call_arguments.done', response_id: 'resp2', call_id: 'call2', name: 'apply_board_operations', arguments: '{"operations":[{"type":"create_text","text":"Hello"}],"message":""}' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
  })
  it('does not add a second response merely to confirm a successful dictated fragment', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'math' as const }) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    const call = { type: 'function_call', call_id: 'call3', name: 'apply_board_operations', arguments: '{"operations":[{"type":"create_math","latex":"x"}],"message":""}' }
    channel.receive({ type: 'response.created', response: { id: 'resp3' } })
    channel.receive({ type: 'response.done', response: { id: 'resp3', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(channel.sent.filter(e => e.type === 'response.create')).toHaveLength(0)
    client.disconnect()
  })
  it('waits for an in-flight tool result before continuing after response.done', async () => {
    let finish!: () => void
    const handlers = { ...callbacks(), applyOperations: vi.fn(() => new Promise<{ ok: boolean; message: string; ids: string[] }>(resolve => { finish = () => resolve({ ok: true, message: 'Applied.', ids: [] }) })) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    const call = { type: 'function_call', call_id: 'call4', name: 'apply_board_operations', arguments: '{"operations":[{"type":"create_text","text":"Hello"}],"message":""}' }
    channel.receive({ type: 'response.created', response: { id: 'resp4' } })
    channel.receive({ ...call, response_id: 'resp4', type: 'response.function_call_arguments.done' })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.done', response: { id: 'resp4', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sent.filter(e => e.type === 'response.create')).toHaveLength(0)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    const resultIndex = channel.sent.findIndex(e => e.item?.type === 'function_call_output')
    const responseIndex = channel.sent.findIndex(e => e.type === 'response.create')
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(responseIndex).toBeGreaterThan(resultIndex)
    client.disconnect()
  })
  it('repairs one atomic math failure, pins the original target, and confirms without more tools', async () => {
    let current = structuredClone(mathContext)
    const handlers = { ...callbacks(), getContext: () => current, onContentPreview: vi.fn(), applyOperations: vi.fn<(operations: BoardOperation[]) => BoardResult>().mockReturnValueOnce(mathFailure).mockReturnValue({ ok: true, message: 'Corrected.', ids: ['math:a'] }) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'failed', [toolCall('bad', [brokenEdit])])
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(toolOutputs(channel)[0]).toMatchObject({ results: mathFailure, recovery: { attemptsRemaining: 1, originalTargetIds: ['math:a'], failedOperations: [brokenEdit] }, context: { objects: [{ id: 'math:a', latex: 'x^2' }, { id: 'math:b' }] } })
    expect(responseRequests(channel)).toHaveLength(1)
    current = { ...current, selectedIds: ['math:b'] }
    channel.receive({ type: 'response.created', response: { id: 'repair' } })
    channel.receive({ type: 'response.function_call_arguments.delta', response_id: 'repair', call_id: 'good', delta: '{"operations":[{"type":"update_object","target":"selected","latex":"x^2 = ?' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    const good = toolCall('good', [{ ...correctedEdit, target: 'selected' }])
    channel.receive({ ...good, type: 'response.function_call_arguments.done', response_id: 'repair' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenLastCalledWith([{ ...correctedEdit, target: 'math:a' }])
    channel.receive({ type: 'response.done', response: { id: 'repair', status: 'completed', output: [good] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(2)
    expect(responseRequests(channel)).toHaveLength(2)
    expect(responseRequests(channel)[1].response.tool_choice).toBe('none')
    await finishResponse(channel, 'confirmation')
    expect(responseRequests(channel)).toHaveLength(2)
    expect(handlers.onError).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('stops after a second failed edit and rejects any extra apply calls in that turn', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    await finishResponse(channel, 'repair', [toolCall('second', [correctedEdit]), toolCall('extra', [correctedEdit])])
    expect(handlers.applyOperations).toHaveBeenCalledTimes(2)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('corrected edit also failed'))
    expect(responseRequests(channel)).toHaveLength(1)
    expect(toolOutputs(channel).at(-1)).toMatchObject({ ok: false })
    expect(client.isConnected()).toBe(true)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('listening')
    client.disconnect()
  })

  it('retries failed dictation but omits a spoken confirmation after the correction', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...mathContext, dictationMode: 'math' as const }), applyOperations: vi.fn().mockReturnValueOnce(mathFailure).mockReturnValue({ ok: true, message: 'Applied.', ids: ['math:a'] }) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    expect(responseRequests(channel)[0].response.output_modalities).toEqual(['text'])
    await finishResponse(channel, 'repair', [toolCall('second', [correctedEdit])])
    expect(responseRequests(channel)).toHaveLength(1)
    expect(handlers.onError).not.toHaveBeenCalled()
    client.disconnect()
  })

  it.each(['completed', 'incomplete', 'cancelled'])('reports a terminal repair with no usable tool (%s)', async status => {
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    await finishResponse(channel, 'repair', [], status)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining(mathFailure.message))
    expect(responseRequests(channel)).toHaveLength(1)
    client.disconnect()
  })

  it('bounds repeated read-only repair lookups and does not loop indefinitely', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    await finishResponse(channel, 'lookup1', [{ type: 'function_call', call_id: 'get1', name: 'get_board_context', arguments: '{}' }])
    expect(responseRequests(channel)).toHaveLength(2)
    await finishResponse(channel, 'lookup2', [{ type: 'function_call', call_id: 'get2', name: 'get_board_context', arguments: '{}' }])
    expect(responseRequests(channel)).toHaveLength(2)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('flushes a pending source draft before final repair validation and preserves the newer edit', async () => {
    let current = structuredClone(mathContext)
    let flushPending = false
    const handlers = { ...callbacks(), getContext: () => current, beforeApplyOperations: vi.fn(() => { if (flushPending) current = { ...current, objects: [{ ...current.objects[0], latex: 'x^3' }, current.objects[1]] } }), applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    flushPending = true
    await finishResponse(channel, 'repair', [toolCall('second', [correctedEdit])])
    expect(handlers.beforeApplyOperations).toHaveBeenCalledTimes(2)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('original object changed'))
    expect(current.objects[0].latex).toBe('x^3')
    expect(responseRequests(channel)).toHaveLength(1)
    client.disconnect()
  })

  it('does not automatically repeat a partly successful batch', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => [{ ok: true, message: 'Done.', ids: ['math:b'] }, mathFailure]) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    expect(responseRequests(channel)).toHaveLength(0)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('partly succeeded'))
    client.disconnect()
  })

  it('abandons an old failure when new speech begins while response.done awaits its tool', async () => {
    let finish!: (result: BoardResult) => void
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => new Promise<BoardResult>(resolve => { finish = resolve })) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    const call = toolCall('old', [brokenEdit])
    channel.receive({ type: 'response.created', response: { id: 'old-response' } })
    channel.receive({ ...call, type: 'response.function_call_arguments.done', response_id: 'old-response' })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.done', response: { id: 'old-response', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'input_audio_buffer.speech_started' })
    channel.receive({ type: 'input_audio_buffer.committed' })
    finish(mathFailure)
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(toolOutputs(channel)).toHaveLength(0)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(responseRequests(channel)[0].response.tool_choice).toBeUndefined()
    channel.receive({ ...toolCall('late', [correctedEdit]), type: 'response.function_call_arguments.done', response_id: 'old-response' })
    channel.receive({ type: 'response.output_text.done', response_id: 'old-response', text: 'Old response' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.onAssistant).not.toHaveBeenCalled()
    expect(client.isConnected()).toBe(true)
    client.disconnect()
  })

  it('cancels an in-flight repair for new speech without showing a stale error', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'initial', [toolCall('first', [brokenEdit])])
    channel.receive({ type: 'response.created', response: { id: 'repair' } })
    channel.receive({ type: 'input_audio_buffer.speech_started' })
    channel.receive({ type: 'response.done', response: { id: 'repair', status: 'cancelled', output: [toolCall('second', [correctedEdit])] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(handlers.onStatus).toHaveBeenLastCalledWith('listening')
    client.disconnect()
  })
  it('diagnoses context create/delete/replacement acknowledgements, not merely an open channel', async () => {
    const checking = checkVoiceConnection(context)
    let complete = false
    void checking.then(() => { complete = true })
    await vi.advanceTimersByTimeAsync(0)
    const peer = FakePeer.latest; const channel = peer.channel
    expect(channel.readyState).toBe('open')
    expect(complete).toBe(false)
    const initial = channel.sent.find(e => e.type === 'conversation.item.create')
    expect(initial?.item.id).toBeTruthy()
    expect(initial.item.id.length).toBeLessThanOrEqual(32)
    channel.receive({ type: 'conversation.item.done', item: { id: 'unrelated_item' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sent.filter(e => e.type === 'conversation.item.delete')).toHaveLength(0)
    expect(complete).toBe(false)

    channel.receive({ type: 'conversation.item.done', item: { id: initial.item.id } })
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sent.filter(e => e.type === 'conversation.item.delete')).toEqual([{ type: 'conversation.item.delete', item_id: initial.item.id }])
    expect(complete).toBe(false)
    channel.receive({ type: 'conversation.item.deleted', item_id: 'unrelated_item' })
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(1)

    channel.receive({ type: 'conversation.item.deleted', item_id: initial.item.id })
    await vi.advanceTimersByTimeAsync(0)
    const replacement = channel.sent.filter(e => e.type === 'conversation.item.create')[1]
    expect(replacement?.item.id).toBeTruthy()
    expect(replacement.item.id).not.toBe(initial.item.id)
    expect(replacement.item.id.length).toBeLessThanOrEqual(32)
    expect(complete).toBe(false)
    channel.receive({ type: 'conversation.item.done', item: { id: replacement.item.id } })
    await checking
    expect(complete).toBe(true)
    expect(peer.closed).toBe(true)
    expect(media).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/realtime/stop', expect.objectContaining({ method: 'POST' }))
  })
  it('fails the diagnostic on a real protocol error and closes its session', async () => {
    const checking = checkVoiceConnection(context)
    const failed = expect(checking).rejects.toThrow('Invalid item.id')
    await vi.advanceTimersByTimeAsync(0)
    const peer = FakePeer.latest
    peer.channel.receive({ type: 'error', error: { code: 'invalid_value', message: 'Invalid item.id: string too long.' } })
    await failed
    expect(peer.closed).toBe(true)
    expect(media).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/realtime/stop', expect.objectContaining({ method: 'POST' }))
  })
  it('times out an open diagnostic channel that never acknowledges the context item', async () => {
    const checking = checkVoiceConnection(context)
    const failed = expect(checking).rejects.toThrow(/15 seconds|timed out|within 15/i)
    await vi.advanceTimersByTimeAsync(15_001)
    await failed
    expect(FakePeer.latest.closed).toBe(true)
    expect(media).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/realtime/stop', expect.objectContaining({ method: 'POST' }))
  })
})
