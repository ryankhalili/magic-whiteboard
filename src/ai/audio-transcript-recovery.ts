import { remember } from './voice-recovery'

type WireEvent = { type: string; [key: string]: any }
export type TranscribeOriginalAudio = (audio: string, signal: AbortSignal) => Promise<string>
type PendingTranscript = {
  itemId: string; eventId: string; phase: 'retrieving' | 'transcribing'; abort: AbortController;
  resolve: (text: string) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; cleanup: () => void;
}
const unavailable = () => new Error('The original audio could not be transcribed clearly. Please repeat the instruction.')
const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new Error('Audio transcription recovery was cancelled.')
function transcript(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= 4000 && !/^\[?unintelligible\]?[.!]?$/i.test(text) ? text : null
}
function validAudio(audio: unknown): audio is string {
  if (typeof audio !== 'string' || audio.length > 1_920_000 || audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return false
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (audio.endsWith('==') ? (alphabet.indexOf(audio.at(-3)!) & 15) !== 0 : audio.endsWith('=') && (alphabet.indexOf(audio.at(-2)!) & 3) !== 0) return false
  const bytes = audio.length / 4 * 3 - (audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0)
  return bytes >= 4800 && bytes <= 1_440_000 && bytes % 2 === 0
}

/** Retrieves one exact committed audio item, then uses dedicated ASR if necessary. */
export function createAudioTranscriptRecovery(send: (event: unknown) => void, transcribeAudio: TranscribeOriginalAudio) {
  let pending: PendingTranscript | null = null
  const retiredItems = new Map<string, true>(), retiredEvents = new Map<string, true>()
  function settle(value: string | Error) {
    const request = pending
    if (!request) return
    pending = null
    clearTimeout(request.timer); request.cleanup(); request.abort.abort()
    remember(retiredItems, request.itemId, true, 64); remember(retiredEvents, request.eventId, true, 64)
    if (value instanceof Error) request.reject(value); else request.resolve(value)
  }
  function request(itemId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    if (!itemId || retiredItems.has(itemId)) return Promise.reject(unavailable())
    if (pending) return Promise.reject(new Error('An original-audio transcription is already pending.'))
    return new Promise((resolve, reject) => {
      const eventId = crypto.randomUUID().replaceAll('-', ''), aborted = () => settle(abortError(signal))
      pending = { itemId, eventId, phase: 'retrieving', abort: new AbortController(), resolve, reject,
        timer: setTimeout(() => settle(unavailable()), 4000), cleanup: () => signal.removeEventListener('abort', aborted) }
      signal.addEventListener('abort', aborted, { once: true })
      send({ type: 'conversation.item.retrieve', item_id: itemId, event_id: eventId })
    })
  }
  function handle(event: WireEvent): boolean {
    if (event.type === 'error') {
      const eventId = event.error?.event_id
      if (typeof eventId !== 'string') return false
      if (pending?.eventId === eventId) {
        settle(Object.assign(new Error(event.error?.message || unavailable().message), { code: event.error?.code }))
        return true
      }
      return retiredEvents.has(eventId)
    }
    if (event.type !== 'conversation.item.retrieved') return false
    const itemId = event.item?.id
    if (typeof itemId !== 'string') return false
    if (retiredItems.has(itemId)) return true
    const request = pending
    if (!request || request.itemId !== itemId) return false
    if (request.phase !== 'retrieving') return true
    const item = event.item
    if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1 || item.content[0]?.type !== 'input_audio') {
      settle(unavailable()); return true
    }
    const content = item.content[0], existing = transcript(content.transcript)
    if (existing) { settle(existing); return true }
    if (!validAudio(content.audio)) { settle(unavailable()); return true }
    clearTimeout(request.timer); request.phase = 'transcribing'
    request.timer = setTimeout(() => settle(unavailable()), 18_000)
    // Audio never enters a generative text response, conversation preview, or log.
    void Promise.resolve().then(() => {
      if (pending !== request || request.abort.signal.aborted) throw abortError(request.abort.signal)
      return transcribeAudio(content.audio, request.abort.signal)
    }).then(result => {
      if (pending === request) settle(transcript(result) ?? unavailable())
    }, error => {
      if (pending === request) settle(error instanceof Error ? error : unavailable())
    })
    return true
  }
  function reset() {
    if (pending) settle(new Error('Audio transcription recovery was cancelled.'))
    retiredItems.clear(); retiredEvents.clear()
  }
  return { request, handle, reset, getDiagnostics: () => ({ pending: !!pending, retiredItems: retiredItems.size, retiredEvents: retiredEvents.size }) }
}
