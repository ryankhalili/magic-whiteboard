import type { BoardCommand, BoardContext, BoardOperation } from '../../shared/board'
import { SERVER_UNREACHABLE } from './commands'

export type VoiceRecoveryState = {
  phase: 'repairing' | 'reconnecting' | 'renewing' | 'waiting'; message: string; attempt: number
} | null
export type VoiceRepairRequest = {
  instruction: string; context: BoardContext; failedOperations?: BoardOperation[];
  failure: { kind: 'malformed_arguments' | 'operation_rejected' | 'response_failed' | 'response_incomplete'; message: string; rawArguments?: string };
  history?: { role: 'user' | 'assistant'; text: string }[]
}
export type VoiceRepair = (request: VoiceRepairRequest, signal: AbortSignal) => Promise<BoardCommand>

export function contextFingerprint(context: BoardContext): string {
  return JSON.stringify(context, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
}

/** An unparsed request has no trusted operation scope. Use only its original selection. */
export function pinRecoveredCommand(command: BoardCommand, context: BoardContext): BoardOperation[] {
  const selected = context.contentSelection ? [context.contentSelection.shapeId]
    : context.selectedIds.length ? context.selectedIds : context.focus?.targetIds.length ? context.focus.targetIds : context.lastCreatedIds
  const allowed = new Set([...selected, ...(context.pendingMath?.objectIds ?? [])])
  return command.operations.map(operation => {
    if (['undo', 'redo', 'delete_objects'].includes(operation.type)) throw new Error('The correction includes a destructive action. Please give that instruction again.')
    if (operation.type === 'confirm_math' || operation.type === 'cancel_math') throw new Error('Please confirm or discard the preview again after voice resumes.')
    if (operation.followPointer) throw new Error('Repeat the pointer-follow instruction after voice resumes.')
    // library inserts and panel actions name no board object, so they pass through untargeted
    if (operation.type.startsWith('create_') || ['propose_image', 'insert_library', 'library_action'].includes(operation.type)) return operation
    const explicit = operation.ids?.length ? operation.ids : operation.target && !['selected', 'selection', 'focus', 'last'].includes(operation.target) ? [operation.target] : selected
    if (!explicit.length || explicit.some(id => !allowed.has(id))) throw new Error('The correction targets a different object. Please select the intended object and repeat the instruction.')
    const pinned = { ...operation }; delete pinned.target; delete pinned.ids
    if (explicit.length === 1) pinned.target = explicit[0]; else pinned.ids = [...explicit]
    return pinned
  })
}

export function isFatalVoiceError(error: unknown): boolean {
  const data = error && typeof error === 'object' ? error as { status?: number; code?: string; retryable?: boolean } : {}
  const message = `${data.code ?? ''} ${error instanceof Error ? error.message : String(error)}`
  return data.retryable === false || [400, 401, 403, 404].includes(data.status ?? 0)
    || /insufficient_quota|credit|quota|allowance|invalid.api.key|authentication|unauthorized|expired|pair.this|permission|cannot.access.*model/i.test(message)
}
export function isTransientVoiceError(error: unknown): boolean {
  if (isFatalVoiceError(error)) return false
  const data = error && typeof error === 'object' ? error as { status?: number; retryable?: boolean; retryAfterMs?: number } : {}
  if ((data.retryAfterMs ?? 0) > 5000) return false
  return error instanceof TypeError || data.retryable === true || (data.status ?? 0) >= 500 || data.status === 429
    || /server_error|temporar|network|connection|timed? ?out|timeout|rate.limit|service.unavailable/i.test(error instanceof Error ? error.message : String(error))
}
export class VoiceApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable?: boolean, readonly retryAfterMs?: number, readonly code?: string) { super(message); this.name = 'VoiceApiError' }
}

/** Preserve structured status so auth/credit failures never become reconnect loops. */
export async function voiceApiRequest<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(25_000)
  const init: RequestInit = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Marginalia': '1' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  let response: Response
  try { response = await fetch(url, init) }
  catch (error) {
    // a cancelled request keeps its own reason; a network failure or timeout stays retryable
    if (signal?.aborted) throw error
    throw new VoiceApiError(SERVER_UNREACHABLE, 0, true, undefined, 'server_unreachable')
  }
  const parsed = await response.json().catch(() => null)
  // a tunnel or proxy error page means the laptop behind it did not answer
  if (!parsed && response.status >= 500) throw new VoiceApiError(SERVER_UNREACHABLE, response.status, true, undefined, 'server_unreachable')
  const data = parsed ?? { error: 'The voice server returned an unreadable response.' }
  if (!response.ok) {
    const retryAfter = response.headers?.get('Retry-After')
    const retryAfterMs = typeof data.retryAfterMs === 'number' ? data.retryAfterMs : retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined
    throw new VoiceApiError(data.error || 'The voice request failed.', response.status, data.retryable, retryAfterMs, data.code)
  }
  return data as T
}

export function remember<K, V>(map: Map<K, V>, key: K, value: V, limit = 128) {
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
}
