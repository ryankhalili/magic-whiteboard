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
const audioRecoveryRequest = (channel: FakeChannel) => channel.sent.filter(event => event.type === 'conversation.item.retrieve').at(-1)
async function completeAudioRecovery(channel: FakeChannel, request: any, _id: string, transcript: string) {
  channel.receive({ type: 'conversation.item.retrieved', item: { id: request.item_id, type: 'message', role: 'user', content: [{ type: 'input_audio', transcript }] } })
  await vi.advanceTimersByTimeAsync(0)
}

describe('voice lifecycle without microphone or paid API calls', () => {
  let stopTrack: ReturnType<typeof vi.fn>
  let media: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>
  let audioTrack: { stop: ReturnType<typeof vi.fn>; enabled: boolean }
  const callbacks = () => ({ getContext: () => context, applyOperations: vi.fn(() => ({ ok: true, message: 'Applied.', ids: ['shape:1'] })), onStatus: vi.fn(), onTranscript: vi.fn(), onAssistant: vi.fn(), onError: vi.fn(), onNotice: vi.fn() })
  beforeEach(() => {
    vi.useFakeTimers()
    stopTrack = vi.fn()
    audioTrack = { stop: stopTrack, enabled: true }
    const stream = { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] }
    media = vi.fn().mockResolvedValue(stream)
    fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 } : { ok: true } }))
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } })
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('writes literal text without any assistant response and keeps out-of-order phrases in speech order', async () => {
    let current: BoardContext = { ...structuredClone(context), dictationMode: 'text' }
    const handlers = { ...callbacks(), getContext: () => current, repairRequest: vi.fn(), onContentPreview: vi.fn(),
      applyOperations: vi.fn((operations: BoardOperation[]) => {
        const op = operations[0], prior = current.objects[0]?.text ?? ''
        current = { ...current, selectedIds: ['text:1'], lastCreatedIds: ['text:1'], objects: [{ id: 'text:1', kind: 'text', text: op.text ?? prior + op.replacement, bounds: { x: 0, y: 0, w: 300, h: 120 }, rotation: 0 }] }
        return { ok: true, message: 'Written.', ids: ['text:1'] }
      }) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    for (const item of ['first', 'second']) {
      channel.receive({ type: 'input_audio_buffer.speech_started', item_id: item })
      channel.receive({ type: 'input_audio_buffer.committed', item_id: item })
    }
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: 'Do not answer this question.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: 'What is photosynthesis?' })
    await vi.advanceTimersByTimeAsync(0)
    expect(current.objects[0].text).toBe('What is photosynthesis? Do not answer this question.')
    expect(handlers.applyOperations).toHaveBeenCalledTimes(2)
    expect(responseRequests(channel)).toHaveLength(0)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: 'Duplicate' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(2)
    client.disconnect()
  })

  it('shows text previews and recovers a missing final from the original audio without an assistant turn', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'text' as const }), onContentPreview: vi.fn(), repairRequest: vi.fn(), onRecoveryState: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'literal' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'literal', delta: 'The cell membrane' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'text', value: 'The cell membrane' }))
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'literal' })
    await vi.advanceTimersByTimeAsync(6000)
    expect(audioRecoveryRequest(channel)?.item_id).toBe('literal')
    expect(audioTrack.enabled).toBe(false)
    await completeAudioRecovery(channel, audioRecoveryRequest(channel), '', 'The cell membrane controls transport.')
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'create_text', text: 'The cell membrane controls transport.', placement: 'auto' }])
    expect(audioTrack.enabled).toBe(true)
    expect(responseRequests(channel)).toHaveLength(0)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('cancels queued text when mode changes and ignores delayed finals after Stop', async () => {
    let current: BoardContext = { ...context, dictationMode: 'text' }
    const handlers = { ...callbacks(), getContext: () => current }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'old-text' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'old-text' })
    current = { ...current, dictationMode: 'assistant' }; client.updateContext()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-text', transcript: 'Do not write this.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(audioRecoveryRequest(channel)).toBeUndefined()
  })

  it('treats a no-operation repair reply as clarification rather than a red failure', async () => {
    const handlers = { ...callbacks(), repairRequest: vi.fn(async () => ({ operations: [], message: 'Which expression should I change?' })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Change it')
    await finishResponse(FakePeer.latest.channel, 'clarify', [{ type: 'function_call', call_id: 'unknown', name: 'unknown', arguments: '{}' }])
    expect(handlers.onNotice).toHaveBeenCalledWith('Which expression should I change?')
    expect(handlers.onAssistant).toHaveBeenCalledWith('Which expression should I change?', true)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('does not retain full board objects in tool results or request a silent success confirmation', async () => {
    const handlers = { ...callbacks(), spokenReplies: false,
      applyOperations: vi.fn(() => ({ ok: true, message: 'Written.', ids: ['text:1'], objects: [{ id: 'text:1', kind: 'text' as const, text: 'Long board source', bounds: { x: 0, y: 0, w: 100, h: 80 }, rotation: 0 }] })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Write hello')
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'compact-success', [toolCall('write', [{ type: 'create_text', text: 'Hello' }])])
    expect(toolOutputs(channel)).toEqual([{ results: { ok: true, message: 'Written.', ids: ['text:1'] } }])
    expect(responseRequests(channel)).toHaveLength(1)
    client.disconnect()
  })

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
    expect(handlers.onNotice).toHaveBeenCalledWith(expect.stringContaining('90 seconds'))
    expect(handlers.onError).not.toHaveBeenCalled()
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
  it('discards an oversized argument stream before concatenation and ignores its later deltas', async () => {
    const handlers = { ...callbacks(), onContentPreview: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'response.created', response: { id: 'oversized' } })
    channel.receive({ type: 'response.output_item.added', response_id: 'oversized', item: { type: 'function_call', call_id: 'large', name: 'apply_board_operations' } })
    channel.receive({ type: 'response.function_call_arguments.delta', response_id: 'oversized', call_id: 'large', delta: '{"operations":[{"type":"create_text","text":"Hello' })
    for (let i = 0; i < 500; i++) channel.receive({ type: 'response.function_call_arguments.delta', response_id: 'oversized', call_id: 'large', delta: 'x'.repeat(2000) })
    expect(client.getDiagnostics()).toMatchObject({ streams: 1, streamCharacters: 0 })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    // Initial arguments are bounded too, before any delta can be received.
    channel.receive({ type: 'response.output_item.added', response_id: 'oversized', item: { type: 'function_call', call_id: 'large-initial', arguments: 'x'.repeat(100_000) } })
    expect(client.getDiagnostics()).toMatchObject({ streams: 2, streamCharacters: 0 })
    channel.receive({ type: 'response.done', response: { id: 'oversized', status: 'completed', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getDiagnostics()).toMatchObject({ streams: 0, streamCharacters: 0 })
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
  it('uses exact added-item metadata when completed arguments omit the function name', async () => {
    const handlers = { ...callbacks(), repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    const call = { ...toolCall('integral', [{ type: 'create_math', latex: '\\int \\sin(x)\\,dx' }]), id: 'item-integral' }
    channel.receive({ type: 'response.created', response: { id: 'metadata' } })
    channel.receive({ type: 'response.output_item.added', response_id: 'metadata', item: { ...call, arguments: '' } })
    channel.receive({ type: 'response.function_call_arguments.done', response_id: 'metadata', call_id: call.call_id, item_id: call.id, arguments: call.arguments })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'create_math', latex: '\\int \\sin(x)\\,dx' }], expect.any(Function))
    channel.receive({ type: 'response.output_item.done', response_id: 'metadata', item: call })
    channel.receive({ type: 'response.done', response: { id: 'metadata', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    client.disconnect()
  })
  it('waits for a complete output item when arguments have no known function metadata', async () => {
    const handlers = { ...callbacks(), repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel, call = toolCall('late-name', [{ type: 'create_math', latex: 'x' }])
    channel.receive({ type: 'response.created', response: { id: 'missing-name' } })
    channel.receive({ type: 'response.function_call_arguments.done', response_id: 'missing-name', call_id: call.call_id, arguments: call.arguments })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    channel.receive({ type: 'response.output_item.done', response_id: 'missing-name', item: call })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })
  it('repairs conflicting event metadata without dispatching either claimed tool', async () => {
    const correction: BoardOperation = { type: 'create_math', latex: '\\int x\\,dx' }
    const handlers = { ...callbacks(), getVisualContext: vi.fn(), repairRequest: vi.fn(async () => ({ operations: [correction], message: 'Integral added.' })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Write the integral of x')
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'response.created', response: { id: 'conflict' } })
    channel.receive({ type: 'response.output_item.added', response_id: 'conflict', item: { type: 'function_call', call_id: 'conflict', name: 'apply_board_operations', arguments: '' } })
    channel.receive({ type: 'response.function_call_arguments.done', response_id: 'conflict', call_id: 'conflict', name: 'inspect_board', arguments: '{}' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.getVisualContext).not.toHaveBeenCalled()
    expect(handlers.repairRequest).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({ message: expect.stringContaining('inconsistent function metadata') }) }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([correction], expect.any(Function))
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
    expect(handlers.applyOperations).toHaveBeenLastCalledWith([{ ...correctedEdit, target: 'math:a' }], expect.any(Function))
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

  it('discards speech while a repair is paused and reports an unexpectedly cancelled correction', async () => {
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
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('correction was interrupted'))
    expect(handlers.onStatus).toHaveBeenLastCalledWith('listening')
    client.disconnect()
  })
  it.each(['{"operations":', '{"operations":"bad"}', '{"operations":[{"type":"invented_action"}]}'])('repairs a malformed payload once with the original typed intent: %s', async argumentsText => {
    const repairRequest = vi.fn(async () => ({ operations: [correctedEdit], message: 'Equation corrected.' }))
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest, onRecoveryState: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Extend this equation with equals question mark')
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'broken', [{ type: 'function_call', call_id: 'malformed', name: 'apply_board_operations', arguments: argumentsText }])
    expect(repairRequest).toHaveBeenCalledTimes(1)
    expect(repairRequest).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'Extend this equation with equals question mark', context: mathContext, failure: expect.objectContaining({ kind: 'malformed_arguments', rawArguments: argumentsText }) }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ ...correctedEdit, target: 'math:a' }], expect.any(Function))
    expect(handlers.onRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'repairing', attempt: 1 }))
    expect(handlers.onRecoveryState).toHaveBeenLastCalledWith(null)
    expect(audioTrack.enabled).toBe(true)
    expect(handlers.onError).not.toHaveBeenCalled()
    // Only the user's initial response; Luna returns the confirmation directly.
    expect(responseRequests(channel)).toHaveLength(1)
    client.disconnect()
  })

  it('accepts schema-valid array/single-operation shorthand locally without spending a repair request', async () => {
    const repairRequest = vi.fn()
    const handlers = { ...callbacks(), repairRequest }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'single', [{ type: 'function_call', call_id: 'single', name: 'apply_board_operations', arguments: '{"type":"create_text","text":"Hello"}' }])
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'create_text', text: 'Hello' }], expect.any(Function))
    expect(repairRequest).not.toHaveBeenCalled()
    client.disconnect()
  })
  it.each(['create_math', 'functions.apply_board_operations', undefined])('repairs an unsupported or missing final tool name once without guessing its meaning: %s', async name => {
    const correction: BoardOperation = { type: 'create_math', latex: '\\int \\sin(x)\\,dx' }
    const handlers = { ...callbacks(), repairRequest: vi.fn(async () => ({ operations: [correction], message: 'Integral added.' })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Write the integral of sine x')
    const channel = FakePeer.latest.channel
    const call = { type: 'function_call', call_id: 'unknown', name, arguments: '{"latex":"not trusted for dispatch"}' }
    await finishResponse(channel, 'unknown-tool', [call])
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    expect(handlers.repairRequest).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'Write the integral of sine x', failure: expect.objectContaining({ kind: 'malformed_arguments', rawArguments: call.arguments }) }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([correction], expect.any(Function))
    expect(handlers.onError).not.toHaveBeenCalled()
    channel.receive({ type: 'response.done', response: { id: 'unknown-tool', status: 'completed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })
  it('renders integral transcription deltas as temporary math without committing board edits', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'math' as const }), onContentPreview: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'integral-speech' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'integral-speech', delta: 'integral' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'transcript:integral-speech', value: '\\int', complete: false, operationType: 'create_math' }))
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'integral-speech', delta: ' of sine x' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ value: '\\int \\sin x', complete: false }))
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'integral-speech', transcript: 'integral of sine x dx' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ value: '\\int \\sin x\\,\\mathrm{d}x', complete: false }))
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
  })
  it.each(['source', 'selection', 'mode'] as const)('clears a math transcript draft when its original %s changes', async change => {
    let current: BoardContext = { ...structuredClone(mathContext), dictationMode: 'math' }
    const handlers = { ...callbacks(), getContext: () => current, onContentPreview: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'edit-speech' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'edit-speech', delta: 'plus three' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'math:a', operationType: 'edit_content' }))
    if (change === 'source') current = { ...current, objects: current.objects.map(object => object.id === 'math:a' ? { ...object, latex: 'x^3' } : object) }
    else if (change === 'selection') current = { ...current, selectedIds: ['math:b'] }
    else current = { ...current, dictationMode: 'assistant' }
    client.updateContext()
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'edit-speech', transcript: 'plus three' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
  })
  it('gives model previews and committed edits precedence over late transcript text', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'math' as const }), onContentPreview: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'model-speech' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'model-speech', delta: 'integral' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'model-speech' })
    channel.receive({ type: 'response.created', response: { id: 'model-preview' } })
    channel.receive({ type: 'response.function_call_arguments.delta', response_id: 'model-preview', call_id: 'model-call', delta: '{"operations":[{"type":"create_math","latex":"x^2' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'model-call', value: 'x^2' }))
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'model-speech', delta: ' of sine x' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'model-call', value: 'x^2' }))
    channel.receive({ ...toolCall('model-call', [{ type: 'create_math', latex: 'x^2' }]), type: 'response.function_call_arguments.done', response_id: 'model-preview' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'model-speech', transcript: 'integral of sine x dx' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    client.disconnect()
  })
  it('clears transcript drafts on a new utterance and on paused recovery', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'math' as const }), onContentPreview: vi.fn(), repairRequest: vi.fn(() => new Promise<never>(() => {})) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'old-draft' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old-draft', delta: 'integral' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'transcript:old-draft' }))
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-draft' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-draft', transcript: 'integral of sine x' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-draft', transcript: 'integral of cosine x' })
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'transcript:new-draft' }))
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'new-draft' })
    await finishResponse(channel, 'repair-draft', [{ type: 'function_call', call_id: 'unsupported', name: 'create_math', arguments: '{}' }])
    expect(audioTrack.enabled).toBe(false)
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(null)
    client.disconnect()
  })
  it('does not clear a newer transcript draft when an interrupted old response completes', async () => {
    const handlers = { ...callbacks(), getContext: () => ({ ...context, dictationMode: 'math' as const }), onContentPreview: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'old-speech' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'old-speech' })
    channel.receive({ type: 'response.created', response: { id: 'old-result' } })
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-speech' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new-speech', delta: 'integral of sine x' })
    const oldCall = toolCall('old-call', [{ type: 'create_math', latex: 'x' }])
    channel.receive({ ...oldCall, type: 'response.function_call_arguments.done', response_id: 'old-result' })
    channel.receive({ type: 'response.done', response: { id: 'old-result', status: 'cancelled', output: [oldCall] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.onContentPreview).toHaveBeenLastCalledWith(expect.objectContaining({ callId: 'transcript:new-speech' }))
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    client.disconnect()
  })
  it('does not replay earlier successful edits when a later tool name is unsupported', async () => {
    const handlers = { ...callbacks(), repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Write an integral')
    await finishResponse(FakePeer.latest.channel, 'partial', [toolCall('good', [{ type: 'create_math', latex: 'x' }]), { type: 'function_call', call_id: 'unsupported', name: 'create_math', arguments: '{}' }])
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('remaining change again'))
    client.disconnect()
  })

  it.each(['apply_board_operations', 'create_math'])('pauses the microphone and aborts a pending repair on Stop for tool %s', async name => {
    let finish!: (command: { operations: BoardOperation[]; message: string }) => void
    const repairRequest = vi.fn((_request: unknown, _signal: AbortSignal) => new Promise<{ operations: BoardOperation[]; message: string }>(resolve => { finish = resolve }))
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest, onRecoveryState: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Make it equal to zero')
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'malformed', [{ type: 'function_call', call_id: 'bad', name, arguments: '{}' }])
    expect(audioTrack.enabled).toBe(false)
    const responseCount = responseRequests(channel).length
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'discarded' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'discarded' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'discarded', transcript: 'An ambiguous new instruction' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.onTranscript).not.toHaveBeenCalled()
    expect(responseRequests(channel)).toHaveLength(responseCount)
    expect(() => client.sendText('Another request')).toThrow('paused')
    client.disconnect()
    expect(repairRequest.mock.calls[0][1].aborted).toBe(true)
    finish({ operations: [correctedEdit], message: 'Done.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(handlers.onRecoveryState).toHaveBeenLastCalledWith(null)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('idle')
  })

  it.each(['apply_board_operations', 'create_math'])('does not apply a repair after drawing or selection changed for tool %s', async name => {
    let current = structuredClone(mathContext)
    let finish!: (command: { operations: BoardOperation[]; message: string }) => void
    const handlers = { ...callbacks(), getContext: () => current, repairRequest: vi.fn(() => new Promise<{ operations: BoardOperation[]; message: string }>(resolve => { finish = resolve })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Append equals zero')
    await finishResponse(FakePeer.latest.channel, 'bad', [{ type: 'function_call', call_id: 'bad', name, arguments: '{}' }])
    current = { ...current, selectedIds: ['math:b'] }
    finish({ operations: [correctedEdit], message: 'Done.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('board changed during recovery'))
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })

  it('gives a stalled repair a finite deadline and leaves healthy voice available', async () => {
    const repairRequest = vi.fn((_request: unknown, _signal: AbortSignal) => new Promise<never>(() => {}))
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Append equals zero')
    await finishResponse(FakePeer.latest.channel, 'bad', [{ type: 'function_call', call_id: 'bad', name: 'apply_board_operations', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(repairRequest.mock.calls[0][1].aborted).toBe(true)
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('took too long'))
    expect(client.isConnected()).toBe(true)
    expect(audioTrack.enabled).toBe(true)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('listening')
    client.disconnect()
  })

  it('allows only one external correction even if its schema or board application fails', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })), applyOperations: vi.fn(() => mathFailure) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Extend the equation')
    const channel = FakePeer.latest.channel
    await finishResponse(channel, 'failed', [toolCall('first', [brokenEdit])])
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(2)
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('corrected edit also failed'))
    expect(responseRequests(channel)).toHaveLength(1)
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })

  it('aborts a Luna correction during reconnect and ignores its eventual old result', async () => {
    let finish!: (command: { operations: BoardOperation[]; message: string }) => void
    const repairRequest = vi.fn((_request: unknown, _signal: AbortSignal) => new Promise<{ operations: BoardOperation[]; message: string }>(resolve => { finish = resolve }))
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Extend the equation')
    const oldPeer = FakePeer.latest
    await finishResponse(oldPeer.channel, 'bad', [{ type: 'function_call', call_id: 'bad', name: 'apply_board_operations', arguments: '{}' }])
    oldPeer.connectionState = 'failed'; oldPeer.dispatchEvent(new Event('connectionstatechange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(repairRequest.mock.calls[0][1].aborted).toBe(true)
    finish({ operations: [correctedEdit], message: 'Old correction' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(client.isConnected()).toBe(true)
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })

  it('closes media immediately on fatal quota errors without attempting a repair', async () => {
    const handlers = { ...callbacks(), repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Create a note')
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'response.created', response: { id: 'quota' } })
    channel.receive({ type: 'response.done', response: { id: 'quota', status: 'failed', status_details: { error: { code: 'insufficient_quota', message: 'Credit exhausted' } }, output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1)
  })

  it('clears an active reconnect when the user pauses microphone and never resumes it later', async () => {
    let finish!: (response: unknown) => void
    const handlers = callbacks(), client = createRealtimeClient(handlers)
    await client.connect()
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/session')
      ? await new Promise(resolve => { finish = resolve }) : { ok: true, json: async () => ({ ok: true }) })
    FakePeer.latest.connectionState = 'failed'; FakePeer.latest.dispatchEvent(new Event('connectionstatechange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(audioTrack.enabled).toBe(false)
    client.disconnect()
    finish({ ok: true, json: async () => ({ sdp: 'answer', sessionId: 'late', maxDurationSeconds: 300 }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isConnected()).toBe(false)
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('idle')
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  it.each(['failed', 'incomplete'])('recovers a %s response once when nothing was applied', async status => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Extend the equation')
    await finishResponse(FakePeer.latest.channel, 'failed', [], status)
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ ...correctedEdit, target: 'math:a' }], expect.any(Function))
    expect(handlers.onError).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('never replays a turn after an early tool succeeded but response.done failed', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Append equals zero')
    const channel = FakePeer.latest.channel, call = toolCall('applied', [correctedEdit])
    channel.receive({ type: 'response.created', response: { id: 'failed' } })
    channel.receive({ ...call, type: 'response.function_call_arguments.done', response_id: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.done', response: { id: 'failed', status: 'failed', output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('Applied edits were kept'))
    client.disconnect()
  })

  it.each(['apply_board_operations', 'create_math'])('waits for the original finalized transcript before repairing tool %s', async name => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original' })
    await finishResponse(channel, 'bad', [{ type: 'function_call', call_id: 'bad', name, arguments: '{}' }])
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(audioRecoveryRequest(channel)).toBeUndefined()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'original', transcript: 'Add equals question mark' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.repairRequest).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'Add equals question mark' }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('declines repair when the original audio never produces an unambiguous transcript', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original' })
    await finishResponse(channel, 'failed', [], 'incomplete')
    await vi.advanceTimersByTimeAsync(6000)
    expect(audioRecoveryRequest(channel)).toBeDefined()
    await vi.advanceTimersByTimeAsync(4000)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not be transcribed clearly'))
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })
  it('retrieves the original transcript while the original tool completion is pending', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, onContentPreview: vi.fn(), repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Equation corrected.' })) }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    channel.receive({ type: 'response.created', response: { id: 'original-response' } })
    const failedCall = { type: 'function_call', call_id: 'unsupported', name: 'create_math', arguments: '{}' }
    channel.receive({ ...failedCall, type: 'response.function_call_arguments.done', response_id: 'original-response' })
    await vi.advanceTimersByTimeAsync(6000)
    const recovery = audioRecoveryRequest(channel)
    expect(recovery).toMatchObject({ type: 'conversation.item.retrieve', item_id: 'original-audio' })
    expect(audioTrack.enabled).toBe(false)
    channel.receive({ type: 'response.done', response: { id: 'original-response', status: 'completed', output: [failedCall] } })
    await completeAudioRecovery(channel, recovery, 'audio-only', 'This equals negative cosine of x evaluated from pi to two pi')
    expect(handlers.repairRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: 'This equals negative cosine of x evaluated from pi to two pi' }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledExactlyOnceWith([{ ...correctedEdit, target: 'math:a' }], expect.any(Function))
    expect(handlers.onAssistant).toHaveBeenCalledExactlyOnceWith('Equation corrected.', true)
    expect(handlers.onTranscript).not.toHaveBeenCalled()
    expect(handlers.onContentPreview.mock.calls.every(([preview]) => preview === null)).toBe(true)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(responseRequests(channel)).toHaveLength(1)
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })
  it('prefers a delayed normal final and aborts only the dedicated ASR request', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, transcribeAudio: vi.fn((_audio: string, _signal: AbortSignal) => new Promise<never>(() => {})), repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(6000)
    const recovery = audioRecoveryRequest(channel)
    channel.receive({ type: 'conversation.item.retrieved', item: { id: recovery.item_id, type: 'message', role: 'user', content: [{ type: 'input_audio', audio: 'A'.repeat(6400) }] } })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'original-audio', transcript: 'Append equals zero' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.transcribeAudio).toHaveBeenCalledTimes(1)
    expect(handlers.transcribeAudio.mock.calls[0][1].aborted).toBe(true)
    expect(channel.sent.filter(event => event.type === 'response.cancel')).toHaveLength(0)
    expect(handlers.repairRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: 'Append equals zero' }), expect.any(AbortSignal))
    await completeAudioRecovery(channel, recovery, 'audio-only', 'An inaccurate late transcript')
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })
  it('ignores old commits and transcription failures, but starts recovery immediately after the original transcript fails', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'old-audio' })
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'current-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'old-audio' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'old-audio' })
    expect(responseRequests(channel)).toHaveLength(0)
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'current-audio' })
    channel.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'current-audio' })
    await finishResponse(channel, 'current-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    const recovery = audioRecoveryRequest(channel)
    expect(recovery.item_id).toBe('current-audio')
    expect(handlers.onError).not.toHaveBeenCalled()
    await completeAudioRecovery(channel, recovery, 'audio-only', 'Append equals zero')
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    client.disconnect()
  })
  it.each([0, 6000])('Stop cancels original-audio recovery after %s ms without adopting late text', async wait => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(wait)
    const recovery = audioRecoveryRequest(channel)
    client.disconnect()
    if (recovery) await completeAudioRecovery(channel, recovery, 'late-audio', 'Old instruction')
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'original-audio', transcript: 'Old instruction' })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(client.isConnected()).toBe(false)
  })
  it('discards a recovered audio instruction when the original equation changes during transcription', async () => {
    let current = structuredClone(mathContext)
    const handlers = { ...callbacks(), getContext: () => current, repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(6000)
    current = { ...current, objects: current.objects.map(object => object.id === 'math:a' ? { ...object, latex: 'new source' } : object) }
    await completeAudioRecovery(channel, audioRecoveryRequest(channel), 'audio-only', 'Append equals zero')
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('board changed during recovery'))
    client.disconnect()
  })
  it('uses dedicated ASR once for exact retrieved PCM with no generative response', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, transcribeAudio: vi.fn(async () => 'Append negative cosine of x'), repairRequest: vi.fn(async () => ({ operations: [correctedEdit], message: 'Corrected.' })) }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(6000)
    const audio = 'A'.repeat(6400)
    channel.receive({ type: 'conversation.item.retrieved', item: { id: 'original-audio', type: 'message', role: 'user', content: [{ type: 'input_audio', audio }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.transcribeAudio).toHaveBeenCalledExactlyOnceWith(audio, expect.any(AbortSignal))
    expect(handlers.repairRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: 'Append negative cosine of x' }), expect.any(AbortSignal))
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(responseRequests(channel)).toHaveLength(1)
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })
  it('does not apply fallback words after a different authoritative final arrives during Luna repair', async () => {
    let finish!: (command: { operations: BoardOperation[]; message: string }) => void
    const handlers = { ...callbacks(), getContext: () => mathContext, transcribeAudio: vi.fn(async () => 'Append cosine x'), repairRequest: vi.fn(() => new Promise<{ operations: BoardOperation[]; message: string }>(resolve => { finish = resolve })) }, client = createRealtimeClient(handlers)
    await client.connect()
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(6000)
    channel.receive({ type: 'conversation.item.retrieved', item: { id: 'original-audio', type: 'message', role: 'user', content: [{ type: 'input_audio', audio: 'A'.repeat(6400) }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.repairRequest).toHaveBeenCalledTimes(1)
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'original-audio', transcript: 'Append sine x' })
    finish({ operations: [correctedEdit], message: 'Corrected.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('finalized transcript changed'))
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })
  it('leaves voice connected after the dedicated transcription endpoint rejects unusable speech', async () => {
    const handlers = { ...callbacks(), getContext: () => mathContext, repairRequest: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    fetchMock.mockImplementation(async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => ({ error: 'The recovered speech could not be transcribed.', code: 'invalid_transcript', retryable: false }) }))
    const channel = FakePeer.latest.channel
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'original-audio' })
    channel.receive({ type: 'input_audio_buffer.committed', item_id: 'original-audio' })
    await finishResponse(channel, 'original-response', [{ type: 'function_call', call_id: 'bad', name: 'create_math', arguments: '{}' }])
    await vi.advanceTimersByTimeAsync(6000)
    channel.receive({ type: 'conversation.item.retrieved', item: { id: 'original-audio', type: 'message', role: 'user', content: [{ type: 'input_audio', audio: 'A'.repeat(6400) }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/realtime/transcribe', expect.objectContaining({ method: 'POST' }))
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith('The recovered speech could not be transcribed.')
    expect(client.isConnected()).toBe(true)
    expect(audioTrack.enabled).toBe(true)
    client.disconnect()
  })
  it.each(['failed', 'incomplete'])('never repairs partial success after a terminal %s response', async status => {
    const handlers = { ...callbacks(), repairRequest: vi.fn(), applyOperations: vi.fn(() => [{ ok: true, message: 'One change applied.', ids: ['created'] }, mathFailure]) }, client = createRealtimeClient(handlers)
    await client.connect(); client.sendText('Write two equations')
    const channel = FakePeer.latest.channel, call = toolCall('partial', [{ type: 'create_math', latex: 'x' }, { type: 'create_math', latex: '\\answer' }])
    channel.receive({ type: 'response.created', response: { id: 'partial-response' } })
    channel.receive({ ...call, type: 'response.function_call_arguments.done', response_id: 'partial-response' })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.done', response: { id: 'partial-response', status, output: [call] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(handlers.repairRequest).not.toHaveBeenCalled()
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('reconnects a failed transport without rerequesting the microphone or replaying edits', async () => {
    const handlers = { ...callbacks(), onRecoveryState: vi.fn() }
    const client = createRealtimeClient(handlers)
    await client.connect()
    const oldPeer = FakePeer.latest
    await finishResponse(oldPeer.channel, 'done', [toolCall('once', [{ type: 'create_text', text: 'Once' }])])
    await finishResponse(oldPeer.channel, 'confirmation')
    oldPeer.connectionState = 'failed'; oldPeer.dispatchEvent(new Event('connectionstatechange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(FakePeer.latest).not.toBe(oldPeer)
    expect(oldPeer.closed).toBe(true)
    expect(media).toHaveBeenCalledTimes(1)
    expect(handlers.onRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'reconnecting' }))
    expect(audioTrack.enabled).toBe(true)
    oldPeer.channel.receive({ ...toolCall('late', [{ type: 'create_text', text: 'Replay' }]), type: 'response.function_call_arguments.done', response_id: 'done' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(true)
    client.disconnect()
  })

  it('bounds transient connection retries and never retries an authentication failure', async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/session') ? { ok: false, status: 503, json: async () => ({ error: 'Voice service temporarily unavailable', retryable: true }) } : { ok: true, json: async () => ({ ok: true }) })
    const handlers = callbacks(), client = createRealtimeClient(handlers)
    const sessionCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session')).length
    const connecting = client.connect()
    // retries back off (0.5, 1, 2, 4, 8 s) and stop at the one minute reconnect deadline
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessionCalls()).toBe(3)
    await vi.advanceTimersByTimeAsync(59_000); await connecting
    expect(sessionCalls()).toBe(12)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('within one minute'))
    expect(stopTrack).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sessionCalls()).toBe(12)
    fetchMock.mockClear().mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid API key', retryable: false }) }))
    await client.connect()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(client.isConnected()).toBe(false)
  })

  it('renews sessions between turns and retains hard credit and intentional idle-stop behavior', async () => {
    let sessions = 0
    // sessions of a minute or less no longer renew early, so this one is 75 s (renewal 15 s before the end)
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/session') ? ++sessions === 1
      ? { ok: true, json: async () => ({ sdp: 'answer', sessionId: 'first', maxDurationSeconds: 75 }) }
      : { ok: false, status: 429, json: async () => ({ error: 'The voice credit allowance has been reached.', retryable: false }) }
      : { ok: true, json: async () => ({ ok: true }) })
    const handlers = { ...callbacks(), onRecoveryState: vi.fn() }, client = createRealtimeClient(handlers)
    await client.connect()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(sessions).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessions).toBe(2)
    expect(handlers.onRecoveryState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'renewing' }))
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining('credit allowance'))
    expect(client.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sessions).toBe(2)
  })

  it('bounds state across 260 turns over two simulated hours and rejects events from old sessions', async () => {
    const handlers = callbacks(), client = createRealtimeClient(handlers)
    await client.connect()
    const first = FakePeer.latest
    for (let i = 0; i < 260; i++) {
      client.sendText(`Create note ${i}`)
      const channel = FakePeer.latest.channel
      await finishResponse(channel, `turn${i}`, [toolCall(`call${i}`, [{ type: 'create_text', text: String(i) }])])
      await finishResponse(channel, `confirm${i}`)
      await vi.advanceTimersByTimeAsync(30_000)
      const counts = client.getDiagnostics()
      expect(counts.executions).toBe(0); expect(counts.responses).toBe(0); expect(counts.streams).toBe(0)
      expect(counts.rememberedCalls).toBeLessThanOrEqual(256); expect(counts.rememberedResponses).toBeLessThanOrEqual(256)
    }
    expect(handlers.applyOperations).toHaveBeenCalledTimes(260)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/session')).length).toBeGreaterThanOrEqual(25)
    expect(media).toHaveBeenCalledTimes(1)
    first.channel.receive({ type: 'response.created', response: { id: 'old' } })
    first.channel.receive({ type: 'response.done', response: { id: 'old', status: 'completed', output: [toolCall('replay', [{ type: 'create_text', text: 'Old' }])] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(handlers.applyOperations).toHaveBeenCalledTimes(260)
    expect(handlers.onError).not.toHaveBeenCalled()
    client.disconnect()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('idle')
    expect(stopTrack).toHaveBeenCalledTimes(1)
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
