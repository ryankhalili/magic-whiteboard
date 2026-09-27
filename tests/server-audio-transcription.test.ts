import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transcription } from 'openai/resources/audio/transcriptions'
import { AUDIO_TRANSCRIPTION_MODEL, AUDIO_TRANSCRIPTION_TIMEOUT_MS, MAX_RECOVERED_AUDIO_BASE64, MAX_RECOVERED_AUDIO_BYTES,
  MIN_RECOVERED_AUDIO_BYTES, audioTranscriptionRequestSchema, transcribeRecoveredAudio, type AudioTranscriptionProvider } from '../server/audio-transcription'

const pcm = Buffer.alloc(MIN_RECOVERED_AUDIO_BYTES, 17)
const body = { audio: pcm.toString('base64') }
const usage = { type: 'tokens' as const, input_tokens: 12, output_tokens: 7, total_tokens: 19 }
function setup(provider?: AudioTranscriptionProvider) {
  return { provider: vi.fn(provider ?? (async () => ({ text: '  equals negative cosine of x  ', usage }))), reserve: vi.fn(async () => {}), recordTokens: vi.fn(async () => {}) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('recovered audio validation before paid work', () => {
  it.each([
    undefined, {}, { audio: 5 }, { audio: '' }, { audio: 'data:audio/pcm;base64,' + body.audio },
    { audio: body.audio + '\n' }, { audio: '-' + body.audio.slice(1) }, { audio: body.audio.slice(1) },
    { audio: body.audio + '====' }, { audio: body.audio.slice(0, 100) + '=' + body.audio.slice(101) },
    { audio: Buffer.alloc(MIN_RECOVERED_AUDIO_BYTES - 2).toString('base64') },
    { audio: Buffer.alloc(MIN_RECOVERED_AUDIO_BYTES + 1).toString('base64') },
    { audio: 'A'.repeat(MAX_RECOVERED_AUDIO_BASE64 + 4) },
    { audio: body.audio, model: 'another-model' },
  ])('rejects malformed or out-of-bounds audio without reserving usage', async invalid => {
    const options = setup()
    await expect(transcribeRecoveredAudio(invalid, options)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('Repeat a short phrase') })
    expect(options.reserve).not.toHaveBeenCalled()
    expect(options.provider).not.toHaveBeenCalled()
  })

  it('accepts exact minimum and maximum duration, rejecting above maximum', () => {
    expect(audioTranscriptionRequestSchema.safeParse(body).success).toBe(true)
    const maximum = Buffer.alloc(MAX_RECOVERED_AUDIO_BYTES).toString('base64')
    expect(maximum.length).toBe(MAX_RECOVERED_AUDIO_BASE64)
    expect(audioTranscriptionRequestSchema.safeParse({ audio: maximum }).success).toBe(true)
    expect(audioTranscriptionRequestSchema.safeParse({ audio: Buffer.alloc(MAX_RECOVERED_AUDIO_BYTES + 2).toString('base64') }).success).toBe(false)
  })

  it('rejects noncanonical padding bits that permissive base64 decoding would accept', async () => {
    const canonical = Buffer.alloc(MIN_RECOVERED_AUDIO_BYTES + 2).toString('base64')
    const noncanonical = canonical.slice(0, -2) + 'B='
    expect(Buffer.from(noncanonical, 'base64')).toEqual(Buffer.from(canonical, 'base64'))
    const options = setup()
    await expect(transcribeRecoveredAudio({ audio: noncanonical }, options)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(options.reserve).not.toHaveBeenCalled()
    expect(options.provider).not.toHaveBeenCalled()
  })
})

describe('dedicated original-audio transcription', () => {
  it('sends exact PCM samples with a WAV header to the ASR model, after the reservation', async () => {
    const order: string[] = []
    const options = setup(async (request, requestOptions) => {
      order.push('provider')
      expect(Object.keys(request).sort()).toEqual(['file', 'language', 'model', 'response_format'])
      expect(request).toMatchObject({ model: AUDIO_TRANSCRIPTION_MODEL, language: 'en', response_format: 'json' })
      expect(request.file.name).toBe('recovered-speech.wav')
      expect(request.file.type).toBe('audio/wav')
      expect(requestOptions).toMatchObject({ maxRetries: 0, timeout: 18_000 })
      expect(requestOptions.signal.aborted).toBe(false)
      const wav = Buffer.from(await request.file.arrayBuffer())
      expect(wav.subarray(0, 4).toString()).toBe('RIFF')
      expect(wav.readUInt32LE(4)).toBe(pcm.length + 36)
      expect(wav.subarray(8, 16).toString()).toBe('WAVEfmt ')
      expect(wav.readUInt32LE(16)).toBe(16)
      expect(wav.readUInt16LE(20)).toBe(1) // Linear PCM.
      expect(wav.readUInt16LE(22)).toBe(1) // Mono.
      expect(wav.readUInt32LE(24)).toBe(24_000)
      expect(wav.readUInt32LE(28)).toBe(48_000)
      expect(wav.readUInt16LE(32)).toBe(2)
      expect(wav.readUInt16LE(34)).toBe(16)
      expect(wav.subarray(36, 40).toString()).toBe('data')
      expect(wav.readUInt32LE(40)).toBe(pcm.length)
      expect(wav.subarray(44)).toEqual(pcm)
      return { text: '  equals negative cosine of x  ', usage }
    })
    options.reserve.mockImplementation(async () => { order.push('reserve') })
    expect(await transcribeRecoveredAudio(body, options)).toEqual({ transcript: 'equals negative cosine of x' })
    expect(order).toEqual(['reserve', 'provider'])
    expect(options.recordTokens).toHaveBeenCalledExactlyOnceWith(12, 7)
  })

  it('does not invent token counts for a duration-billed response', async () => {
    const options = setup(async () => ({ text: 'plus three', usage: { type: 'duration', seconds: 2 } }))
    expect(await transcribeRecoveredAudio(body, options)).toEqual({ transcript: 'plus three' })
    expect(options.recordTokens).not.toHaveBeenCalled()
  })

  it('stops before the provider when the command allowance cannot be reserved', async () => {
    const options = setup(), failure = new Error('Allowance exhausted')
    options.reserve.mockRejectedValue(failure)
    await expect(transcribeRecoveredAudio(body, options)).rejects.toBe(failure)
    expect(options.provider).not.toHaveBeenCalled()
  })

  it('does not return an unaccounted transcript when token recording fails', async () => {
    const options = setup(), failure = new Error('Usage unavailable')
    options.recordTokens.mockRejectedValue(failure)
    await expect(transcribeRecoveredAudio(body, options)).rejects.toBe(failure)
    expect(options.provider).toHaveBeenCalledOnce()
  })

  it.each(['', ' \n\t ', 'x'.repeat(4001), 'secret\u0000suffix', undefined])('rejects empty, oversized or malformed text while recording paid usage', async text => {
    const options = setup(async () => ({ text, usage }) as Transcription)
    await expect(transcribeRecoveredAudio(body, options)).rejects.toMatchObject({ code: 'invalid_transcript', message: expect.stringContaining('Repeat a shorter phrase') })
    expect(options.recordTokens).toHaveBeenCalledExactlyOnceWith(12, 7)
  })

  it('accepts a 4,000-character transcript after trimming', async () => {
    const options = setup(async () => ({ text: `  ${'x'.repeat(4000)} \n` }))
    expect((await transcribeRecoveredAudio(body, options)).transcript).toHaveLength(4000)
  })

  it.each([
    [{ status: 500, message: 'private audio or credentials' }, 'temporary_failure'],
    [{ status: 400, message: 'private audio or credentials' }, 'upstream_failure'],
    [{ status: 401, message: 'private audio or credentials' }, 'authentication'],
    [{ status: 429, error: { code: 'insufficient_quota', message: 'private audio or credentials' } }, 'quota'],
  ])('does not expose upstream content or retry a failed billable call', async (failure, code) => {
    const options = setup(async () => { throw failure })
    await expect(transcribeRecoveredAudio(body, options)).rejects.toMatchObject({ code, message: expect.not.stringContaining('private') })
    expect(options.reserve).toHaveBeenCalledOnce()
    expect(options.provider).toHaveBeenCalledOnce()
    expect(options.recordTokens).not.toHaveBeenCalled()
  })
})

describe('bounded transcription cancellation', () => {
  it('does not reserve or send after the browser has already disconnected', async () => {
    const options = setup(), controller = new AbortController()
    controller.abort()
    await expect(transcribeRecoveredAudio(body, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(options.reserve).not.toHaveBeenCalled()
    expect(options.provider).not.toHaveBeenCalled()
  })

  it('cancels during reservation and never starts the provider after that reservation finishes', async () => {
    const reservation = deferred<void>(), entered = deferred<void>(), controller = new AbortController(), options = setup()
    options.reserve.mockImplementation(() => { entered.resolve(); return reservation.promise })
    const pending = transcribeRecoveredAudio(body, { ...options, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    controller.abort()
    await rejected
    reservation.resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(options.provider).not.toHaveBeenCalled()
  })

  it('propagates cancellation to the provider and accounts for a late reply without returning it', async () => {
    const reply = deferred<Transcription>(), entered = deferred<AbortSignal>(), controller = new AbortController()
    const options = setup(async (_request, requestOptions) => { entered.resolve(requestOptions.signal); return reply.promise })
    const pending = transcribeRecoveredAudio(body, { ...options, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const upstreamSignal = await entered.promise
    controller.abort()
    await rejected
    expect(upstreamSignal.aborted).toBe(true)
    reply.resolve({ text: 'late', usage })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(options.recordTokens).toHaveBeenCalledExactlyOnceWith(12, 7)
  })

  it('enforces an 18-second overall deadline even when the provider ignores cancellation', async () => {
    vi.useFakeTimers()
    const entered = deferred<AbortSignal>()
    const options = setup(async (_request, requestOptions) => { entered.resolve(requestOptions.signal); return new Promise(() => {}) })
    const pending = transcribeRecoveredAudio(body, options)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('Repeat a shorter phrase') })
    const upstreamSignal = await entered.promise
    await vi.advanceTimersByTimeAsync(AUDIO_TRANSCRIPTION_TIMEOUT_MS)
    await rejected
    expect(upstreamSignal.aborted).toBe(true)
    expect(options.provider).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
