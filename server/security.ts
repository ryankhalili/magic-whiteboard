import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'

const newPairingCode = () => String(randomInt(100_000, 1_000_000))
export let pairingCode = newPairingCode()
const sessions = new Map<string, number>()
const COOKIE = 'marginalia_session'
const DAY = 24 * 60 * 60 * 1000
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const PAIR_ROTATE_AFTER = 20
let pairFailures = 0

export function isLocalBrowser(req: Pick<Request, 'hostname' | 'socket' | 'headers'>) {
  const address = req.socket.remoteAddress
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)
    && LOOPBACK.includes(address ?? '')
    && !req.headers['x-forwarded-for'] && !req.headers['forwarded']
}

/** the tunnel connects over loopback and names the real client; a direct LAN socket cannot pick its own address */
export function clientAddress(req: Pick<Request, 'socket' | 'headers'>) {
  const socket = req.socket.remoteAddress ?? ''
  const forwarded = req.headers['cf-connecting-ip']
  return LOOPBACK.includes(socket) && typeof forwarded === 'string' && forwarded ? `tunnel ${forwarded.slice(0, 64)}` : socket || 'remote'
}

export function sameOrigin(req: Pick<Request, 'headers' | 'get'>) {
  const origin = req.headers.origin
  if (!origin) return true // Non-browser clients still need the session cookie and custom header.
  try { return new URL(origin).host === req.get('host') } catch { return false }
}

export function accessToken(req: Pick<Request, 'headers'>) {
  return req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
}

export function authorized(req: Request) {
  const token = accessToken(req)
  const expires = sessions.get(token)
  if (expires && expires > Date.now()) return true
  if (expires) sessions.delete(token)
  return false
}

export function grantAccess(req: Request, res: Response) {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + DAY)
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, maxAge: DAY, path: '/' })
}

export function validPairCode(code: unknown) {
  return typeof code === 'string' && /^\d{6}$/.test(code)
    && timingSafeEqual(Buffer.from(code), Buffer.from(pairingCode))
}

export type PairAttempt = { status: 200 | 401 | 429; error?: string; rotated?: boolean }

// each address has its own budget; wrong codes never lock others out: after 20 in total the code changes (Help shows it)
export function attemptPairing(req: Pick<Request, 'socket' | 'headers' | 'body'>, limiter: RateLimiter, now = Date.now()): PairAttempt {
  if (!limiter.take(clientAddress(req), now)) return { status: 429, error: 'Too many pairing attempts. Try again in ten minutes.' }
  if (validPairCode(req.body?.code)) return { status: 200 }
  const rotated = ++pairFailures >= PAIR_ROTATE_AFTER
  if (rotated) { pairFailures = 0; pairingCode = newPairingCode() }
  return { status: 401, error: 'That pairing code is not correct. Check the code on the laptop.', ...(rotated ? { rotated } : {}) }
}

export function blockedPath(url: string) {
  let value = url.split('?')[0]
  for (let i = 0; i < 3; i++) { try { value = decodeURIComponent(value) } catch { return true } }
  value = value.replaceAll('\\', '/').toLowerCase()
  return /(?:^|\/)(?:api\.txt|jev\.txt|\.env(?:\.[^/]*)?|\.git|\.local|server)(?:\/|$)/.test(value)
    || value.includes('/@fs/') && !value.includes('/node_modules/')
}

// vite dev server hosts: cloudflare assigns these names, so they cannot be rebound to this computer
export const DEV_ALLOWED_HOSTS = ['.trycloudflare.com']

export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  take(key: string, now = Date.now()) {
    if (this.buckets.size > 1000) for (const [k, v] of this.buckets) if (v.reset < now) this.buckets.delete(k)
    const current = this.buckets.get(key)
    if (!current || current.reset <= now) { this.buckets.set(key, { count: 1, reset: now + this.windowMs }); return true }
    if (current.count >= this.max) return false
    current.count++; return true
  }
}

// the one call per device check and the voice minute allowance bound spend; this only stops runaway loops
export const createVoiceLimiter = () => new RateLimiter(20, 10 * 60_000)

export type VoiceRefusal = { status: number; retryAfter?: string; body: { error: string; code: string; retryable: boolean } }
export type VoiceSlotDeps = { starting: Set<string>; callsOf: (owner: string) => { id: string; tab?: string }[]; close: (id: string) => Promise<boolean>; limiter: RateLimiter }

// one voice call per device: the same tab coming back (reload, network blip) takes over its own call,
// a second tab gets a clear refusal, and only an admitted request spends a token; the caller removes the owner from starting when done
export async function claimVoiceSlot(owner: string, deps: VoiceSlotDeps, tab?: string): Promise<VoiceRefusal | null> {
  if (deps.starting.has(owner)) return { status: 409, body: { error: 'Voice is already starting on this device. Wait a moment, then try again.', code: 'voice_session_active', retryable: false } }
  const live = deps.callsOf(owner)
  if (live.some(call => !tab || call.tab !== tab)) return { status: 409, body: { error: 'Voice is on in another tab. Stop it there first.', code: 'voice_session_active', retryable: false } }
  deps.starting.add(owner)
  for (const { id } of live) {
    if (await deps.close(id)) continue
    deps.starting.delete(owner)
    return { status: 502, body: { error: 'The previous voice session is still closing. Try again in a moment.', code: 'voice_close_pending', retryable: true } }
  }
  if (deps.limiter.take(owner)) return null
  deps.starting.delete(owner)
  return { status: 429, retryAfter: '600', body: { error: 'Please wait before opening another voice session.', code: 'local_rate_limit', retryable: true } }
}
