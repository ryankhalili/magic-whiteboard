import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'

export const pairingCode = String(randomInt(100_000, 1_000_000))
const sessions = new Map<string, number>()
const COOKIE = 'marginalia_session'
const DAY = 24 * 60 * 60 * 1000

export function isLocalBrowser(req: Pick<Request, 'hostname' | 'socket' | 'headers'>) {
  const address = req.socket.remoteAddress
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
    && !req.headers['x-forwarded-for'] && !req.headers['forwarded']
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

export function blockedPath(url: string) {
  let value = url.split('?')[0]
  for (let i = 0; i < 3; i++) { try { value = decodeURIComponent(value) } catch { return true } }
  value = value.replaceAll('\\', '/').toLowerCase()
  return /(?:^|\/)(?:api\.txt|\.env(?:\.[^/]*)?|\.git|\.local|server)(?:\/|$)/.test(value)
    || value.includes('/@fs/') && !value.includes('/node_modules/')
}

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
