import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealtimeClient, type RealtimeClient, type RealtimeOptions, type VoiceRepairRequest } from '../src/ai/realtime'
import type { BoardContext, BoardOperation } from '../shared/board'

class Channel extends EventTarget {
  readyState = 'connecting'
  sent: any[] = []
  refuse: (event: any) => boolean = () => false
  send(raw: string) { const event = JSON.parse(raw); if (this.refuse(event)) throw new Error('Channel refused'); this.sent.push(event) }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')) }
  receive(event: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })) }
}
class Peer extends EventTarget {
  static latest: Peer
  channel = new Channel()
  connectionState = 'new'
  constructor() { super(); Peer.latest = this }
  addTrack() {}
  createDataChannel() { return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'offer' } }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')) }
  close() {}
}
const base: BoardContext = { focus: null, pointer: { x: 10, y: 20 }, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const object = (id: string, text: string) => ({ id, kind: 'text', text, bounds: { x: 0, y: 0, w: 300, h: 200 }, rotation: 0 })
const requests = (channel: Channel) => channel.sent.filter(event => event.type === 'response.create')
const contexts = (channel: Channel) => channel.sent.filter(event => event.item?.role === 'system')
const contextOf = (event: any) => JSON.parse(event.item.content[0].text.split('\n').slice(1).join('\n'))
const contextError = { code: 'context_length_exceeded', message: 'Maximum context length exceeded.' }
const command = (operations: BoardOperation[], name = 'apply_board_operations') => ({ type: 'function_call', call_id: crypto.randomUUID(), name, arguments: JSON.stringify({ operations }) })
async function done(channel: Channel, id: string, calls: unknown[] = [], error?: unknown) {
  channel.receive({ type: 'response.created', response: { id } })
  channel.receive({ type: 'response.done', response: { id, status: error ? 'failed' : 'completed', output: calls, status_details: error ? { error } : undefined } })
  await vi.advanceTimersByTimeAsync(0)
}
async function speak(channel: Channel, item: string, transcript?: string) {
  channel.receive({ type: 'input_audio_buffer.speech_started', item_id: item })
  channel.receive({ type: 'input_audio_buffer.speech_stopped', item_id: item })
  channel.receive({ type: 'input_audio_buffer.committed', item_id: item })
  if (transcript !== undefined) channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript })
  await vi.advanceTimersByTimeAsync(0)
}

describe('merged voice context and instruction ownership', () => {
  let board: BoardContext
  let track: { enabled: boolean; stop: ReturnType<typeof vi.fn> }
  let fetchMock: ReturnType<typeof vi.fn>
  const clients: RealtimeClient[] = []
  beforeEach(() => {
    vi.useFakeTimers(); board = structuredClone(base); track = { enabled: true, stop: vi.fn() }
    fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/session') ? { sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 } : { ok: true } }))
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) } })
    vi.stubGlobal('RTCPeerConnection', Peer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.useRealTimers(); vi.unstubAllGlobals() })
  async function start(overrides: Partial<RealtimeOptions> = {}) {
    const callbacks = { getContext: () => board, applyOperations: vi.fn(() => ({ ok: true, message: 'Applied.', ids: ['shape:a'] })),
      repairRequest: vi.fn(async (_request: VoiceRepairRequest, _signal: AbortSignal) => ({ operations: [{ type: 'create_math' as const, latex: 'x^2' }], message: '' })),
      onStatus: vi.fn(), onTranscript: vi.fn(), onAssistant: vi.fn(), onNotice: vi.fn(), onRecoveryState: vi.fn(), onError: vi.fn(), spokenReplies: false }
    const client = createRealtimeClient({ ...callbacks, ...overrides }); clients.push(client); await client.connect()
    return { client, callbacks, channel: Peer.latest.channel }
  }
  it('keeps listening during an utterance longer than the idle timeout', async () => {
    const { client, channel, callbacks } = await start()
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'long' })
    await vi.advanceTimersByTimeAsync(95_000)
    expect(client.isConnected()).toBe(true)
    expect(track.stop).not.toHaveBeenCalled()
    expect(callbacks.onNotice).not.toHaveBeenCalledWith(expect.stringContaining('90 seconds'))
  })
  it('recovers an empty completed response instead of silently returning to listening', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'empty', 'Plot an empty three-dimensional axes for now.')
    await done(channel, 'nothing')
    expect(callbacks.repairRequest).toHaveBeenCalledOnce()
    expect(callbacks.applyOperations).toHaveBeenCalledOnce()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('recovers an explicit undo without treating it as an inferred deletion', async () => {
    const repair = vi.fn(async () => ({ operations: [{ type: 'undo' as const }], message: '' }))
    const { channel, callbacks } = await start({ repairRequest: repair })
    await speak(channel, 'undo', 'No, wait, can you undo that?')
    await done(channel, 'undo-failure', [command([], 'wrong_function')])
    expect(callbacks.applyOperations).toHaveBeenCalledExactlyOnceWith([{ type: 'undo' }], expect.any(Function))
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('recovers a self-contained command after interrupting an unfinished one', async () => {
    const { client, channel, callbacks } = await start(); client.sendText('write x')
    channel.receive({ type: 'response.created', response: { id: 'old' } })
    await speak(channel, 'new', 'Plot an empty three-dimensional axes for now.')
    channel.receive({ type: 'response.done', response: { id: 'old', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'new-response', [command([], 'wrong_function')])
    expect(callbacks.repairRequest).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'Plot an empty three-dimensional axes for now.' }), expect.any(AbortSignal))
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('finishes a spoken question retrieval when the model only opens the book and suppresses duplicate continuation', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'question', 'Pull question 2 from chapter 6, please.')
    await done(channel, 'retrieve', [command([{ type: 'library_action', action: 'open_book', book: 'Sakuri QM' }]),
      command([{ type: 'insert_library', item: 'question 6.2' }])])
    expect(callbacks.applyOperations).toHaveBeenCalledExactlyOnceWith([
      { type: 'insert_library', query: 'Pull question 2 from chapter 6, please.', book: 'Sakuri QM' },
    ], expect.any(Function))
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('waits for late final transcription before treating open-book as completed retrieval', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'late-question')
    await done(channel, 'late-open', [command([{ type: 'library_action', action: 'open_book' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-question', transcript: 'pull question 2 from chapter 6' })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.applyOperations).toHaveBeenCalledExactlyOnceWith([
      { type: 'insert_library', query: 'pull question 2 from chapter 6', book: undefined },
    ], expect.any(Function))
  })
  it('does not apply a pending open-only call after a new speech turn replaces it', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'old-question')
    await done(channel, 'old-open', [command([{ type: 'library_action', action: 'open_book' }])])
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new-question' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
  })
  it('keeps the microphone active through a preview revision and a later spoken confirmation', async () => {
    board.pendingMath = { id: 'math-preview:test', revision: 1, objectIds: ['draft:a'] }
    board.objects = [{ ...object('draft:a', ''), kind: 'plot', expression: 'x*y', visualization: { type: 'surface' } }]
    const apply = vi.fn((ops: BoardOperation[]) => {
      if (ops[0].type === 'update_object') { board.pendingMath!.revision++; board.objects[0].expression = 'x^2+y^2' }
      if (ops[0].type === 'confirm_math') delete board.pendingMath
      return { ok: true, message: 'Updated.', ids: [] }
    })
    const { channel, callbacks } = await start({ applyOperations: apply })
    await speak(channel, 'correction', 'make it x squared plus y squared')
    await done(channel, 'correct-draft', [command([{ type: 'update_object', target: 'draft:a', expression: 'x^2+y^2' }])])
    expect(track.enabled).toBe(true)
    expect(contextOf(contexts(channel).at(-1)).pendingMath.revision).toBe(2)
    await speak(channel, 'approval', 'add it')
    await done(channel, 'approve-draft', [command([{ type: 'confirm_math', target: 'math-preview:test', previewRevision: 2 }])])
    expect(apply).toHaveBeenCalledTimes(2)
    expect(board.pendingMath).toBeUndefined()
    expect(track.enabled).toBe(true)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('prevents a model from confirming a revision created within the same speech turn', async () => {
    board.pendingMath = { id: 'math-preview:test', revision: 1, objectIds: ['draft:a'] }
    const apply = vi.fn(() => { board.pendingMath!.revision++; return { ok: true, message: 'Revised.', ids: [] } })
    const { channel, callbacks } = await start({ applyOperations: apply })
    await speak(channel, 'correction', 'make it blue')
    await done(channel, 'self-approval', [
      command([{ type: 'update_object', target: 'draft:a', color: 'blue' }]),
      command([{ type: 'confirm_math', target: 'math-preview:test', previewRevision: 2 }]),
    ])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('new instruction'))
  })
  it('bounds large PDF boards by UTF-8 bytes while keeping the full selected equation first', async () => {
    const latex = String.raw`\int_0^1 x^2\,dx = \frac13`
    board = { ...base, selectedIds: ['math:chosen'], objects: [
      ...Array.from({ length: 100 }, (_, index) => ({ ...object(`pdf:${index}`, '物理学'.repeat(3500)), kind: 'pdf_page', locked: true })),
      { id: 'math:chosen', kind: 'math', latex, bounds: { x: 0, y: 0, w: 300, h: 100 }, rotation: 0 },
    ] }
    const { channel } = await start()
    const snapshot = contextOf(contexts(channel).at(-1))
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(12000)
    expect(snapshot.selectedIds).toEqual(['math:chosen'])
    expect(snapshot.objects[0]).toMatchObject({ id: 'math:chosen', latex })
    expect(snapshot.objects.filter((item: any) => item.kind === 'pdf_page').every((item: any) => item.text === undefined && item.sourceOmitted.includes('text'))).toBe(true)
    expect(snapshot.contextBudget.omittedObjectCount).toBeGreaterThan(0)
  })
  it('marks oversized selected source unavailable and rejects a whole-source rewrite', async () => {
    board = { ...base, selectedIds: ['text:a'], objects: [object('text:a', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start()
    client.sendText('correct the paragraph')
    const snapshot = contextOf(contexts(channel).at(-1))
    expect(snapshot.objects[0]).toMatchObject({ id: 'text:a', sourceOmitted: ['text'] })
    expect(snapshot.objects[0].text).toBeUndefined()
    await done(channel, 'rewrite', [command([{ type: 'update_object', target: 'text:a', text: 'short prefix' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('full source did not fit'))
  })
  it('allows a precise local append without giving the model an incomplete source prefix', async () => {
    board = { ...base, selectedIds: ['text:a'], objects: [object('text:a', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('append the word done')
    await done(channel, 'append', [command([{ type: 'edit_content', target: 'text:a', field: 'text', replacement: ' done' }])])
    expect(callbacks.applyOperations).toHaveBeenCalledOnce()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it.each(['selected', 'selection', undefined])('protects every selected source for target %s even while one source editor has a character selection', async target => {
    board = { ...base, selectedIds: ['text:visible', 'text:omitted'], contentSelection: { shapeId: 'text:visible', field: 'text', text: 'short' },
      objects: [object('text:visible', 'short'), object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('replace the selected text')
    await done(channel, 'rewrite', [command([{ type: 'update_object', ...(target ? { target } : {}), text: 'replacement' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('full source did not fit'))
  })
  it('checks the post-deletion last-target fallback before admitting any operation in the batch', async () => {
    board = { ...base, selectedIds: ['text:visible'], lastCreatedIds: ['text:omitted'], objects: [object('text:visible', 'short'), object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('delete this and rewrite the last one')
    await done(channel, 'batch', [command([{ type: 'delete_objects', target: 'selected' }, { type: 'update_object', text: 'replacement' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('full source did not fit'))
  })
  it('checks the selection changed by an earlier transform in the same atomic batch', async () => {
    board = { ...base, selectedIds: ['text:visible'], objects: [object('text:visible', 'short'), object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('move that other text then rewrite it')
    await done(channel, 'batch', [command([{ type: 'transform_object', target: 'text:omitted', dx: 10 }, { type: 'update_object', text: 'replacement' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
  })
  it('protects source properties passed on transform_object too', async () => {
    board = { ...base, selectedIds: ['text:omitted'], objects: [object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('move and rewrite it')
    await done(channel, 'transform', [command([{ type: 'transform_object', target: 'selected', dx: 10, text: 'replacement' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
  })
  it('preserves ordinary create-then-rewrite follow-ups even when the old selection has omitted source', async () => {
    board = { ...base, selectedIds: ['text:omitted'], objects: [object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('create and style a new note')
    const operations: BoardOperation[] = [{ type: 'create_text', text: 'New note' }, { type: 'update_object', target: 'selected', text: 'New note, revised' }, { type: 'update_object', target: 'last', color: 'blue' }]
    await done(channel, 'new', [command(operations)])
    expect(callbacks.applyOperations).toHaveBeenCalledExactlyOnceWith(operations, expect.any(Function))
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('requires an explicit rewrite target after an opaque library operation', async () => {
    board = { ...base, selectedIds: ['text:visible'], objects: [object('text:visible', 'short'), object('text:omitted', '漢'.repeat(7000))] }
    const { client, channel, callbacks } = await start(); client.sendText('open the book then rewrite that')
    await done(channel, 'library', [command([{ type: 'library_action', action: 'open_book', book: 'Calculus' }, { type: 'update_object', target: 'selected', text: 'replacement' }])])
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
  })
  it('stops before requesting a response if both context sizes are refused', async () => {
    const { client, channel, callbacks } = await start()
    channel.refuse = event => event.item?.role === 'system'
    client.sendText('write x')
    expect(requests(channel)).toHaveLength(0)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('could not send'))
    channel.refuse = () => false; client.sendText('write y')
    expect(requests(channel)).toHaveLength(1)
  })
  it('does not infer from the old conversation when the user-text event was refused', async () => {
    const { client, channel, callbacks } = await start()
    channel.refuse = event => event.item?.role === 'user'; client.sendText('write x')
    expect(requests(channel)).toHaveLength(0)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('could not send'))
  })
  it('repairs a filler-interrupted command using its original words, not the filler', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'original', 'write x squared')
    channel.receive({ type: 'response.created', response: { id: 'old' } })
    await speak(channel, 'filler', 'um')
    channel.receive({ type: 'response.done', response: { id: 'old', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'continued', [command([], 'made_up_function')])
    expect(callbacks.repairRequest).toHaveBeenCalledOnce()
    expect(callbacks.repairRequest.mock.calls[0][0]).toMatchObject({ instruction: 'write x squared' })
    expect(callbacks.applyOperations).toHaveBeenCalledOnce()
  })
  it('accepts a delayed final for the original audio after an intervening filler', async () => {
    const { channel, callbacks } = await start()
    await speak(channel, 'original')
    channel.receive({ type: 'response.created', response: { id: 'old' } })
    await speak(channel, 'filler', 'hmm')
    channel.receive({ type: 'response.done', response: { id: 'old', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'continued', [command([], 'wrong_function')])
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'original', transcript: 'write the integral of sine x' })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.repairRequest.mock.calls[0][0]).toMatchObject({ instruction: 'write the integral of sine x' })
    expect(callbacks.applyOperations).toHaveBeenCalledOnce()
  })
  it.each([true, false])('uses original words or validated operation intent, never filler, for a scoped correction (final available: %s)', async finalized => {
    board = { ...base, selectedIds: ['math:a'], objects: [{ id: 'math:a', kind: 'math', latex: 'x', bounds: { x: 0, y: 0, w: 200, h: 80 }, rotation: 0 }] }
    const applyOperations = vi.fn().mockReturnValueOnce({ ok: false, message: 'Unsupported LaTeX command \\answer.', ids: [] }).mockReturnValue({ ok: true, message: 'Applied.', ids: ['math:a'] })
    const repairRequest = vi.fn(async () => ({ operations: [{ type: 'update_object' as const, target: 'math:a', latex: 'x=1' }], message: '' }))
    const { channel, callbacks } = await start({ applyOperations, repairRequest })
    await speak(channel, 'original', finalized ? 'make x equal one' : undefined)
    channel.receive({ type: 'response.created', response: { id: 'old' } })
    await speak(channel, 'filler', 'hmm')
    channel.receive({ type: 'response.done', response: { id: 'old', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'continued', [command([{ type: 'update_object', target: 'math:a', latex: 'x=\\answer' }])])
    expect(repairRequest).toHaveBeenCalledOnce()
    const request = (repairRequest.mock.calls as unknown as [VoiceRepairRequest, AbortSignal][])[0][0]
    expect(request.instruction).toBe(finalized ? 'make x equal one' : 'Correct only the failed content operations shown, preserving their original intent and targets.')
    expect(applyOperations).toHaveBeenCalledTimes(2)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('refuses an ambiguous interrupted non-filler command instead of repairing only its final fragment', async () => {
    const { client, channel, callbacks } = await start(); client.sendText('write x squared')
    channel.receive({ type: 'response.created', response: { id: 'old' } })
    await speak(channel, 'different', 'and change that other one')
    channel.receive({ type: 'response.done', response: { id: 'old', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'continued', [command([], 'wrong_function')])
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('unfinished instruction was interrupted'))
  })
  it.each(['terminal', 'request'] as const)('refreshes once for a %s context-capacity failure without replay or Luna', async kind => {
    const { client, channel, callbacks } = await start(); client.sendText('write x')
    if (kind === 'terminal') await done(channel, 'full', [], contextError)
    else { channel.receive({ type: 'error', error: { ...contextError, event_id: requests(channel).at(-1).event_id } }); await vi.advanceTimersByTimeAsync(0) }
    expect(Peer.latest.channel).not.toBe(channel)
    expect(client.isConnected()).toBe(true)
    expect(track.enabled).toBe(true)
    expect(requests(Peer.latest.channel)).toHaveLength(0)
    expect(callbacks.applyOperations).not.toHaveBeenCalled()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onNotice).toHaveBeenCalledWith(expect.stringContaining('context limit'))
    expect(callbacks.onError).not.toHaveBeenCalled()
    client.sendText('write x again')
    await done(Peer.latest.channel, 'full-again', [], contextError)
    expect(client.isConnected()).toBe(false)
    expect(callbacks.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('still too large'))
  })
  it('ignores a capacity error from a superseded request', async () => {
    const { client, channel } = await start(); client.sendText('write x')
    const old = requests(channel)[0].event_id
    await done(channel, 'old')
    client.sendText('write y')
    channel.receive({ type: 'error', error: { ...contextError, event_id: old } }); await vi.advanceTimersByTimeAsync(0)
    expect(Peer.latest.channel).toBe(channel)
    expect(client.isConnected()).toBe(true)
  })
  it('retains an already applied change when the same response later reaches the context limit', async () => {
    const { client, channel, callbacks } = await start(); client.sendText('write x')
    const item = command([{ type: 'create_math', latex: 'x' }])
    channel.receive({ type: 'response.created', response: { id: 'partial' } })
    channel.receive({ ...item, type: 'response.function_call_arguments.done', response_id: 'partial' })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.done', response: { id: 'partial', status: 'failed', status_details: { error: contextError }, output: [item] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.applyOperations).toHaveBeenCalledOnce()
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(requests(Peer.latest.channel)).toHaveLength(0)
    expect(client.isConnected()).toBe(true)
  })
  it('does not lose an intervening substantive instruction across two filler carries', async () => {
    const { client, channel, callbacks } = await start(); client.sendText('write x')
    channel.receive({ type: 'response.created', response: { id: 'original' } })
    await speak(channel, 'change', 'actually make it y')
    channel.receive({ type: 'response.done', response: { id: 'original', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({ type: 'response.created', response: { id: 'changed' } })
    await speak(channel, 'filler', 'um')
    channel.receive({ type: 'response.done', response: { id: 'changed', status: 'cancelled', output: [] } })
    await vi.advanceTimersByTimeAsync(0)
    await done(channel, 'retry', [command([], 'wrong_tool')])
    expect(callbacks.repairRequest).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('unfinished instruction was interrupted'))
  })
  it('gives asynchronous PDF resolution an ownership guard that expires on newer speech', async () => {
    let guard: (() => boolean) | undefined, finish!: () => void
    const applyOperations = vi.fn(async (_operations: BoardOperation[], isCurrent?: () => boolean) => {
      guard = isCurrent; await new Promise<void>(resolve => { finish = resolve }); return { ok: false, message: 'Cancelled', ids: [] }
    })
    const { client, channel } = await start({ applyOperations }); client.sendText('insert page 2')
    channel.receive({ type: 'response.created', response: { id: 'pdf' } })
    channel.receive({ ...command([{ type: 'insert_library', page: '2' }]), type: 'response.function_call_arguments.done', response_id: 'pdf' })
    await vi.advanceTimersByTimeAsync(0)
    expect(guard?.()).toBe(true)
    channel.receive({ type: 'input_audio_buffer.speech_started', item_id: 'new' })
    expect(guard?.()).toBe(false)
    finish(); await vi.advanceTimersByTimeAsync(0)
    expect(applyOperations).toHaveBeenCalledOnce()
  })
})
