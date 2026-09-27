import { describe, expect, it } from 'vitest'
import { commandSchema, contextSchema, compactContext } from '../server/board-tools'
import { blockedPath, isLocalBrowser, RateLimiter, sameOrigin, validPairCode, pairingCode } from '../server/security'
import type { BoardContext } from '../shared/board'

const empty: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1000, h: 800 }, objects: [] }

describe('API request boundaries', () => {
  it('accepts zero-size point focus and an in-progress gesture', () => {
    expect(contextSchema.safeParse({ ...empty, focus: { kind: 'point', bounds: { x: 2, y: 3, w: 0, h: 0 }, targetIds: [] }, gesture: { active: true, bounds: { x: 2, y: 3, w: 0, h: 0 }, start: { x: 2, y: 3 }, current: { x: 2, y: 3 } } }).success).toBe(true)
  })
  it('rejects unsupported operations and unbounded edits', () => {
    expect(commandSchema.safeParse({ message: 'ok', operations: [{ type: 'run_code', text: 'x' }] }).success).toBe(false)
    expect(commandSchema.safeParse({ message: 'ok', operations: [{ type: 'transform_object', scale: Infinity }] }).success).toBe(false)
    expect(commandSchema.safeParse({ message: 'ok', operations: Array.from({ length: 13 }, () => ({ type: 'undo' })) }).success).toBe(false)
  })
  it('keeps targeted objects when limiting large canvas snapshots', () => {
    const objects = Array.from({ length: 70 }, (_, i) => ({ id: `shape:${i}`, kind: 'text', bounds: { x: 0, y: 0, w: 80, h: 80 }, rotation: 0, text: 'x'.repeat(3000) }))
    const result = compactContext({ ...empty, objects, selectedIds: ['shape:69'] })
    expect(result.objects).toHaveLength(35)
    expect(result.objects[0].id).toBe('shape:69')
    expect(result.objects[0].text).toHaveLength(3000) // Preserve source offsets for the active content edit.
    expect(result.objects[1].text).toHaveLength(1500)
  })
})

describe('local credential and remote API protection', () => {
  it.each(['/api.txt', '/API.TXT?raw', '/%61pi.txt', '/%2561pi.txt', '/@fs/D:/Data%20Projects/Hackathon/api.txt', '/server/index.ts', '/.env.local', '/.local/usage.json', '/.git/config'])('never serves private path %s', url => {
    expect(blockedPath(url)).toBe(true)
  })
  it('does not block ordinary assets', () => {
    expect(blockedPath('/src/App.tsx')).toBe(false)
    expect(blockedPath('/assets/index.js')).toBe(false)
  })
  it('checks exact pairing code length and value', () => {
    expect(validPairCode(pairingCode)).toBe(true)
    expect(validPairCode('')).toBe(false)
    expect(validPairCode('1234567')).toBe(false)
  })
  it('does not auto-authorize a tunnel merely because its TCP connection is local', () => {
    const req = { hostname: 'demo.example.com', socket: { remoteAddress: '127.0.0.1' }, headers: {} }
    expect(isLocalBrowser(req as any)).toBe(false)
    expect(isLocalBrowser({ ...req, hostname: 'localhost' } as any)).toBe(true)
    expect(isLocalBrowser({ ...req, hostname: 'localhost', headers: { 'x-forwarded-for': '1.2.3.4' } } as any)).toBe(false)
  })
  it('blocks cross-origin requests even when a cookie is present', () => {
    expect(sameOrigin({ headers: { origin: 'https://evil.example' }, get: () => 'localhost:3000' } as any)).toBe(false)
    expect(sameOrigin({ headers: { origin: 'http://localhost:3000' }, get: () => 'localhost:3000' } as any)).toBe(true)
  })
  it('limits bursts, then permits requests after the window expires', () => {
    const limit = new RateLimiter(2, 1000)
    expect(limit.take('one', 0)).toBe(true)
    expect(limit.take('one', 1)).toBe(true)
    expect(limit.take('one', 2)).toBe(false)
    expect(limit.take('two', 2)).toBe(true)
    expect(limit.take('one', 1000)).toBe(true)
  })
})
