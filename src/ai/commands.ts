import type { BoardCommand, BoardContext, PlacementCandidate } from '../../shared/board'

export type CommandHistory = { role: 'user' | 'assistant'; text: string }[]
export type ApiStatus = {
  configured: boolean; authorized: boolean; pairingRequired: boolean; pairingCode?: string;
  models: { text: string; realtime: string };
  limits: { sessionMinutes: number; inactivitySeconds: number; commandLimit: number; voiceMinutesLimit: number };
  usage?: { commands: number; inputTokens: number; outputTokens: number; voiceSecondsReserved: number; note: string }
}

export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryAfterMs?: number) { super(message); this.name = 'ApiRequestError' }
}

export const SERVER_UNREACHABLE = 'The laptop server is not reachable. Check that it and the tunnel are running.'

export async function apiRequest<T>(url: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 35_000)
  const init: RequestInit = {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Marginalia': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  }
  let response: Response
  try { response = await fetch(url, init) }
  catch (error) {
    // a cancelled request keeps its own reason; network failures and the deadline get a plain message
    if (options.signal?.aborted) throw error
    throw new ApiRequestError(SERVER_UNREACHABLE, 0, 'server_unreachable')
  }
  const parsed = await response.json().catch(() => null)
  // a tunnel or proxy error page means the laptop behind it did not answer
  if (!parsed && response.status >= 500) throw new ApiRequestError(SERVER_UNREACHABLE, response.status, 'server_unreachable')
  const data = parsed ?? { error: 'The server returned an unreadable response.' }
  if (!response.ok) {
    const retryAfter = response.headers?.get('retry-after')
    const delay = retryAfter ? Number(retryAfter) * 1000 : undefined
    throw new ApiRequestError(data.error || 'The request failed. Please try again.', response.status, data.code, Number.isFinite(delay) ? delay : undefined)
  }
  return data as T
}

export function getApiStatus() { return apiRequest<ApiStatus>('/api/status') }
export function pairDevice(code: string) { return apiRequest<{ ok: boolean }>('/api/pair', { code }) }
export function sendBoardCommand(text: string, context: BoardContext, history: CommandHistory = [], image?: string, signal?: AbortSignal, placementCandidates?: PlacementCandidate[]) {
  // the server takes history texts up to 3000 characters; one long paste must not block later commands
  const recent = history.slice(-8).map(message => ({ ...message, text: message.text.slice(0, 3000) }))
  return apiRequest<BoardCommand>('/api/command', { text, context, history: recent, image, ...(placementCandidates?.length ? { placementCandidates } : {}) }, { signal, timeoutMs: 80_000 })
}

export function repairBoardCommand(request: unknown, signal?: AbortSignal) {
  return apiRequest<BoardCommand>('/api/repair', request, { signal, timeoutMs: 80_000 })
}
