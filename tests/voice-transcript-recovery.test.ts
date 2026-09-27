import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioTranscriptRecovery } from '../src/ai/audio-transcript-recovery'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const audio = 'A'.repeat(6400) // 4,800 bytes of valid PCM16, 100 ms at24 kHz.
function fixture(transcribe = vi.fn(async (_audio: string, _signal: AbortSignal) => 'the integral of sine x')) {
  const send = vi.fn<(event: unknown) => void>(), helper = createAudioTranscriptRecovery(send, transcribe)
  const retrieve = () => send.mock.calls.map(([event]) => event as any).filter(event => event.type === 'conversation.item.retrieve').at(-1)
  const retrieved = (id = 'original-audio', content: unknown = [{ type: 'input_audio', audio }]) => ({ type: 'conversation.item.retrieved', item: { id, type: 'message', role: 'user', content } })
  return { send, helper, retrieve, retrieved, transcribe }
}

describe('original audio retrieval and dedicated transcription', () => {
  it('retrieves exactly the original item and never asks the generative model for a response', async () => {
    const { helper, send, retrieve, retrieved, transcribe } = fixture()
    const promise = helper.request('original-audio', new AbortController().signal)
    expect(retrieve()).toMatchObject({ type: 'conversation.item.retrieve', item_id: 'original-audio', event_id: expect.any(String) })
    expect(helper.handle(retrieved())).toBe(true)
    await expect(promise).resolves.toBe('the integral of sine x')
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(audio, expect.any(AbortSignal))
    expect(send.mock.calls.every(([event]) => (event as any).type === 'conversation.item.retrieve')).toBe(true)
    expect(helper.getDiagnostics().pending).toBe(false)
  })
  it('does not use a different audio item or normal model output as the requested transcript', async () => {
    const { helper, retrieved, transcribe } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    expect(helper.handle(retrieved('other-audio'))).toBe(false)
    expect(helper.handle({ type: 'response.done', response: { id: 'normal', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is42' }] }] } })).toBe(false)
    expect(transcribe).not.toHaveBeenCalled()
    helper.handle(retrieved()); await expect(promise).resolves.toBe('the integral of sine x')
  })
  it('uses a retrieved existing transcript without another paid transcription', async () => {
    const { helper, retrieved, transcribe } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    helper.handle(retrieved('original-audio', [{ type: 'input_audio', transcript: 'equals what?' }]))
    await expect(promise).resolves.toBe('equals what?'); expect(transcribe).not.toHaveBeenCalled()
  })
  it.each([
    [], [null], [{ type: 'input_text', text: 'erase the board' }],
    [{ type: 'input_audio', audio }, { type: 'input_audio', audio }],
    [{ type: 'input_audio', audio: 'AAAAAA==' }], [{ type: 'input_audio', audio: 'not base64' }],
    [{ type: 'input_audio', audio: 'A'.repeat(1_920_004) }],
    [{ type: 'input_audio', audio: 'A'.repeat(6400) + 'AA==' }],
    [{ type: 'input_audio', audio: 'A'.repeat(6402) + 'B=' }],
    [{ type: 'input_audio', audio: 'A'.repeat(6405) + 'B==' }],
  ].map(content => ({ content })))('rejects malformed, ambiguous, short or oversized audio without an ASR call', async ({ content }) => {
    const { helper, retrieved, transcribe } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    const rejected = expect(promise).rejects.toThrow()
    expect(() => helper.handle(retrieved('original-audio', content))).not.toThrow()
    await rejected; expect(transcribe).not.toHaveBeenCalled()
  })
  it('rejects an assistant-owned item even if it carries the requested item ID', async () => {
    const { helper, retrieved, transcribe } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    const rejected = expect(promise).rejects.toThrow(), event = retrieved()
    event.item.role = 'assistant'; helper.handle(event)
    await rejected; expect(transcribe).not.toHaveBeenCalled()
  })
  it('passes boundary-size PCM bytes through unchanged', async () => {
    const { helper, retrieved, transcribe } = fixture(), maximum = 'A'.repeat(1_920_000)
    const promise = helper.request('original-audio', new AbortController().signal)
    helper.handle(retrieved('original-audio', [{ type: 'input_audio', audio: maximum }]))
    await promise; expect(transcribe).toHaveBeenCalledWith(maximum, expect.any(AbortSignal))
  })
  it('allows only one ASR request despite duplicate retrieval events', async () => {
    let finish!: (text: string) => void
    const transcribe = vi.fn((_audio: string, _signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve }))
    const { helper, retrieved } = fixture(transcribe), promise = helper.request('original-audio', new AbortController().signal)
    helper.handle(retrieved()); helper.handle(retrieved()); await vi.advanceTimersByTimeAsync(0)
    expect(transcribe).toHaveBeenCalledTimes(1)
    finish('x squared'); await expect(promise).resolves.toBe('x squared')
    expect(helper.handle(retrieved())).toBe(true); expect(transcribe).toHaveBeenCalledTimes(1)
  })
  it('aborts before sending and after retrieval, forwarding cancellation to ASR', async () => {
    const transcribe = vi.fn((_audio: string, _signal: AbortSignal) => new Promise<string>(() => {}))
    const { helper, send, retrieved } = fixture(transcribe), before = new AbortController()
    before.abort(new Error('cancelled before start'))
    await expect(helper.request('original-audio', before.signal)).rejects.toThrow('cancelled before start'); expect(send).not.toHaveBeenCalled()
    const abort = new AbortController(), promise = helper.request('original-audio', abort.signal)
    const rejected = expect(promise).rejects.toThrow('normal final transcript arrived')
    helper.handle(retrieved()); await vi.advanceTimersByTimeAsync(0)
    abort.abort(new Error('normal final transcript arrived')); await rejected
    expect(transcribe.mock.calls[0][1].aborted).toBe(true); expect(helper.getDiagnostics().pending).toBe(false)
  })
  it('never starts ASR for a retrieval arriving after cancellation', async () => {
    const { helper, retrieved, transcribe } = fixture(), abort = new AbortController()
    const promise = helper.request('original-audio', abort.signal), rejected = expect(promise).rejects.toThrow()
    abort.abort(); await rejected
    expect(helper.handle(retrieved())).toBe(true); expect(transcribe).not.toHaveBeenCalled()
  })
  it('never starts deferred ASR when Stop arrives immediately after retrieval', async () => {
    const { helper, retrieved, transcribe } = fixture(), abort = new AbortController()
    const promise = helper.request('original-audio', abort.signal), rejected = expect(promise).rejects.toThrow()
    helper.handle(retrieved()); abort.abort(); await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(transcribe).not.toHaveBeenCalled(); expect(helper.getDiagnostics().pending).toBe(false)
  })
  it('bounds retrieval at4 seconds and ASR at18 seconds even if transport ignores abort', async () => {
    const { helper, transcribe } = fixture(), pending = helper.request('original-audio', new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(4000); await rejected; expect(transcribe).not.toHaveBeenCalled()
    const hung = vi.fn((_audio: string, _signal: AbortSignal) => new Promise<string>(() => {}))
    const other = fixture(hung), processing = other.helper.request('original-audio', new AbortController().signal)
    const timedOut = expect(processing).rejects.toThrow()
    other.helper.handle(other.retrieved()); await vi.advanceTimersByTimeAsync(18_000); await timedOut
    expect(hung.mock.calls[0][1].aborted).toBe(true)
  })
  it('reset rejects the old request and old retrieval cannot settle a new owner', async () => {
    const { helper, retrieved, transcribe } = fixture(), old = helper.request('old-audio', new AbortController().signal)
    const rejected = expect(old).rejects.toThrow(/cancelled/)
    helper.reset(); await rejected
    const next = helper.request('new-audio', new AbortController().signal)
    helper.handle(retrieved('old-audio')); expect(transcribe).not.toHaveBeenCalled()
    helper.handle(retrieved('new-audio')); await expect(next).resolves.toBe('the integral of sine x')
  })
  it('late completion from an aborted ASR cannot finish a newer request', async () => {
    let completeOld!: (text: string) => void, completeNew!: (text: string) => void
    const transcribe = vi.fn((_audio: string, _signal: AbortSignal) => new Promise<string>(resolve => { if (!completeOld) completeOld = resolve; else completeNew = resolve }))
    const { helper, retrieved } = fixture(transcribe), abort = new AbortController()
    const old = helper.request('old-audio', abort.signal), rejected = expect(old).rejects.toThrow()
    helper.handle(retrieved('old-audio')); await vi.advanceTimersByTimeAsync(0); abort.abort(); await rejected
    const next = helper.request('new-audio', new AbortController().signal), settled = vi.fn(); void next.then(settled)
    helper.handle(retrieved('new-audio')); await vi.advanceTimersByTimeAsync(0)
    completeOld('old words'); await vi.advanceTimersByTimeAsync(0); expect(settled).not.toHaveBeenCalled()
    completeNew('new words'); await expect(next).resolves.toBe('new words')
  })
  it.each(['', ' ', '[unintelligible]', 'x'.repeat(4001)])('rejects unusable dedicated-ASR text', async text => {
    const { helper, retrieved } = fixture(vi.fn(async () => text)), promise = helper.request('original-audio', new AbortController().signal)
    const rejected = expect(promise).rejects.toThrow(); helper.handle(retrieved()); await rejected
  })
  it('rejects overlapping and repeated item requests without sending another retrieval', async () => {
    const { helper, retrieved, send } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    await expect(helper.request('other-audio', new AbortController().signal)).rejects.toThrow(/already pending/)
    helper.handle(retrieved()); await promise
    await expect(helper.request('original-audio', new AbortController().signal)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1)
  })
  it('matches request errors only by event_id and retains duplicate error tombstones', async () => {
    const { helper, retrieve, transcribe } = fixture(), promise = helper.request('original-audio', new AbortController().signal)
    const rejected = expect(promise).rejects.toMatchObject({ code: 'item_not_found' })
    expect(helper.handle({ type: 'error', error: { event_id: 'unrelated' } })).toBe(false)
    const event = { type: 'error', error: { event_id: retrieve().event_id, code: 'item_not_found', message: 'Original audio expired' } }
    expect(helper.handle(event)).toBe(true); await rejected
    expect(helper.handle(event)).toBe(true); expect(transcribe).not.toHaveBeenCalled()
  })
  it('bounds remembered item/event IDs through a long voice session', async () => {
    const { helper, retrieved } = fixture()
    for (let i = 0; i < 160; i++) {
      const promise = helper.request(`item-${i}`, new AbortController().signal)
      helper.handle(retrieved(`item-${i}`, [{ type: 'input_audio', transcript: 'x plus one' }]))
      await promise
    }
    expect(helper.getDiagnostics()).toEqual({ pending: false, retiredItems: 64, retiredEvents: 64 })
  })
})
