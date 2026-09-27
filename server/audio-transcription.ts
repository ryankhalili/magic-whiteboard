import OpenAI from 'openai'
import type { Transcription } from 'openai/resources/audio/transcriptions'
import { z } from 'zod'
import { CommandRecoveryError, publicCommandError } from './command-retry'

export const AUDIO_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
export const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 18_000
export const MAX_RECOVERED_AUDIO_BASE64 = 1_920_000
export const MIN_RECOVERED_AUDIO_BYTES = 4_800 // 100 ms, 24 kHz mono PCM16.
export const MAX_RECOVERED_AUDIO_BYTES = 1_440_000 // 30 seconds.
const invalidAudioMessage = 'That audio could not be read. Repeat a short phrase or type it.'

function validPCM(audio: string): boolean {
  // Check size before the character scan or allocation. Buffer.from alone tolerates invalid base64.
  if (audio.length < 4 || audio.length > MAX_RECOVERED_AUDIO_BASE64 || audio.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return false
  const pcm = Buffer.from(audio, 'base64')
  return pcm.length >= MIN_RECOVERED_AUDIO_BYTES && pcm.length <= MAX_RECOVERED_AUDIO_BYTES
    && pcm.length % 2 === 0 && pcm.toString('base64') === audio
}

export const audioTranscriptionRequestSchema = z.object({
  audio: z.string().refine(validPCM, invalidAudioMessage),
}).strict()

/** Original PCM samples are copied verbatim into a small in-memory RIFF/WAVE container. */
export function recoveredPCMToWav(pcm: Buffer): Buffer {
  if (pcm.length < MIN_RECOVERED_AUDIO_BYTES || pcm.length > MAX_RECOVERED_AUDIO_BYTES || pcm.length % 2 !== 0) {
    throw new CommandRecoveryError(invalidAudioMessage, 'invalid_request')
  }
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44)
  return wav
}

type AudioFile = Awaited<ReturnType<typeof OpenAI.toFile>>
export type AudioTranscriptionProvider = (
  request: { model: typeof AUDIO_TRANSCRIPTION_MODEL; file: AudioFile; language: 'en'; response_format: 'json' },
  options: { signal: AbortSignal; maxRetries: 0; timeout: number },
) => Promise<Transcription>

export function createOpenAIAudioTranscriber(apiKey: string): AudioTranscriptionProvider {
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: AUDIO_TRANSCRIPTION_TIMEOUT_MS })
  return (request, options) => client.audio.transcriptions.create(request, options)
}

function withAbort<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new DOMException('Transcription cancelled.', 'AbortError')) }
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return action() }).then(
      value => { signal.removeEventListener('abort', cancel); resolve(value) },
      error => { signal.removeEventListener('abort', cancel); reject(error) },
    )
  })
}

/** Dedicated ASR for a retrieved user-audio item; never generates an assistant answer. */
export async function transcribeRecoveredAudio(body: unknown, options: {
  provider: AudioTranscriptionProvider; reserve: () => Promise<void>;
  recordTokens: (input: number, output: number) => Promise<void>; signal?: AbortSignal;
}): Promise<{ transcript: string }> {
  const parsed = audioTranscriptionRequestSchema.safeParse(body)
  if (!parsed.success) throw new CommandRecoveryError(invalidAudioMessage, 'invalid_request')
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new CommandRecoveryError('Transcription timed out. Repeat a shorter phrase or type it.', 'timeout')), AUDIO_TRANSCRIPTION_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  try {
    return await withAbort(async () => {
      const file = await OpenAI.toFile(recoveredPCMToWav(Buffer.from(parsed.data.audio, 'base64')), 'recovered-speech.wav', { type: 'audio/wav' })
      signal.throwIfAborted()
      await options.reserve() // Persist the command allowance before any billable request.
      signal.throwIfAborted()
      let response: Transcription
      try {
        response = await options.provider({ model: AUDIO_TRANSCRIPTION_MODEL, file, language: 'en', response_format: 'json' },
          { signal, maxRetries: 0, timeout: AUDIO_TRANSCRIPTION_TIMEOUT_MS })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        const safe = publicCommandError(error)
        if (['authentication', 'quota', 'rate_limit'].includes(safe.code)) throw safe
        throw new CommandRecoveryError('Audio could not be transcribed. Repeat a short phrase or type it.', safe.code)
      }
      // Keep accounting even if a provider that ignored cancellation returns late.
      if (response.usage?.type === 'tokens') await options.recordTokens(response.usage.input_tokens, response.usage.output_tokens)
      signal.throwIfAborted()
      const transcript = typeof response.text === 'string' ? response.text.trim() : ''
      if (!transcript || transcript.length > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(transcript)) {
        throw new CommandRecoveryError('No clear transcript was returned. Repeat a shorter phrase or type it.', 'invalid_transcript')
      }
      return { transcript }
    }, signal)
  } finally { clearTimeout(timer) }
}
