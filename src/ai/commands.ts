import type { BoardCommand, BoardContext } from '../../shared/board'

export type CommandHistory = { role: 'user' | 'assistant'; text: string }[]
export type ApiStatus = {
  configured: boolean; authorized: boolean; pairingRequired: boolean; pairingCode?: string;
  models: { text: string; realtime: string };
  limits: { sessionMinutes: number; inactivitySeconds: number; commandLimit: number; voiceMinutesLimit: number };
  usage?: { commands: number; inputTokens: number; outputTokens: number; voiceSecondsReserved: number; note: string }
}

export async function apiRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Marginalia': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(35_000),
  })
  const data = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }))
  if (!response.ok) throw new Error(data.error || 'The request failed. Please try again.')
  return data as T
}

export function getApiStatus() { return apiRequest<ApiStatus>('/api/status') }
export function pairDevice(code: string) { return apiRequest<{ ok: boolean }>('/api/pair', { code }) }
export function sendBoardCommand(text: string, context: BoardContext, history: CommandHistory = [], image?: string) {
  return apiRequest<BoardCommand>('/api/command', { text, context, history: history.slice(-8), image })
}
