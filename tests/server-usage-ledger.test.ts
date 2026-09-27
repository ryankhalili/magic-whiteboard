import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteUsage, configuredLimit, UsageLedger } from '../server/usage-ledger'
import { ImageJobManager } from '../server/image-generation'

const directories: string[] = []
async function filename() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whiteboard-usage-'))
  directories.push(directory)
  return path.join(directory, 'usage.json')
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('whiteboard-usage-')) throw new Error('Unexpected test cleanup directory')
    await rm(directory, { recursive: true, force: true })
  }
})
const prior = { commands: 199, inputTokens: 42, outputTokens: 24, voiceSecondsReserved: 1799 }

describe('durable cumulative usage', () => {
  it('preserves legacy counters and serializes concurrent command reservations at the cap', async () => {
    const file = await filename(); await writeFile(file, JSON.stringify(prior))
    const usage = await UsageLedger.open(file)
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => usage.reserveCommand(200)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(usage.snapshot()).toMatchObject({ ...prior, commands: 200, imagesReserved: 0 })
    expect((await UsageLedger.open(file)).snapshot()).toEqual(usage.snapshot())
    expect(await readdir(path.dirname(file))).toEqual(['usage.json'])
  })
  it.each(['{', '{}', JSON.stringify({ ...prior, commands: -1 }), JSON.stringify({ ...prior, voiceSecondsReserved: '0' })])('fails closed for corrupt saved state without rewriting it: %s', async text => {
    const file = await filename(); await writeFile(file, text)
    const usage = await UsageLedger.open(file)
    expect(usage.snapshot()).toBeNull()
    await expect(usage.reserveCommand(200)).rejects.toMatchObject({ code: 'usage_unavailable' })
    await expect(usage.reserveVoice(300, 10800)).rejects.toMatchObject({ code: 'usage_unavailable' })
    await expect(usage.reserveImage('request_test', 20)).rejects.toMatchObject({ code: 'usage_unavailable' })
    expect(await readFile(file, 'utf8')).toBe(text)
  })
  it('does not commit an in-memory reservation or allow later spend after disk failure', async () => {
    const file = await filename(); await writeFile(file, JSON.stringify(prior))
    const write = vi.fn(async () => { throw new Error('disk full') })
    const usage = await UsageLedger.open(file, write)
    await expect(usage.reserveCommand(200)).rejects.toMatchObject({ code: 'usage_unavailable' })
    await expect(usage.reserveImage('request_next', 20)).rejects.toMatchObject({ code: 'usage_unavailable' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(prior)
  })
  it('reclaims only explicitly settled unused voice time and allows a final partial segment', async () => {
    const usage = await UsageLedger.open(await filename())
    const seconds = await usage.reserveVoice(300, 180)
    expect(seconds).toBe(180)
    await expect(usage.reserveVoice(300, 180)).rejects.toMatchObject({ code: 'local_voice_limit' })
    expect(usage.snapshot()?.voiceSecondsReserved).toBe(180)
    await usage.settleVoice(seconds, 45)
    expect(await usage.reserveVoice(300, 180)).toBe(135)
    await usage.settleVoice(135, 150) // Account for delayed confirmed closure, even beyond the reservation.
    expect(usage.snapshot()?.voiceSecondsReserved).toBe(195)
  })
  it('saves global hashed image tombstones before provider invocation and retains them across restart', async () => {
    const file = await filename(), usage = await UsageLedger.open(file)
    const provider = vi.fn(async () => {
      const saved = JSON.parse(await readFile(file, 'utf8'))
      expect(saved.imagesReserved).toBe(1)
      expect(saved.imageRequestHashes).toEqual([createHash('sha256').update('request_persisted').digest('hex')])
      throw new Error('provider unavailable')
    })
    const manager = new ImageJobManager({ provider, reserve: async (_owner, request) => { await usage.reserveImage(request.requestId, 20) } })
    await manager.submit('first-owner', { requestId: 'request_persisted', prompt: 'A triangle', size: '1024x1024', confirmed: true })
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(manager.get('first-owner', 'request_persisted')?.status).toBe('failed'))
    manager.dispose()
    const reopened = await UsageLedger.open(file)
    await expect(reopened.reserveImage('request_persisted', 20)).rejects.toMatchObject({ code: 'request_already_reserved' })
    expect(reopened.snapshot()?.imagesReserved).toBe(1)
    expect(JSON.stringify(reopened.snapshot())).not.toContain('imageRequestHashes')
    expect(await readFile(file, 'utf8')).not.toContain('first-owner')
    expect(await readFile(file, 'utf8')).not.toContain('A triangle')
  })
  it('serializes image duplicates and distinct reservations at a durable global cap', async () => {
    const usage = await UsageLedger.open(await filename())
    const results = await Promise.allSettled(['same-request', 'same-request', 'other-request', 'third-request'].map(id => usage.reserveImage(id, 2)))
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected'])
    expect(usage.snapshot()?.imagesReserved).toBe(2)
  })
  it('atomically persists token accounting without losing concurrent increments', async () => {
    const file = await filename(), usage = await UsageLedger.open(file, atomicWriteUsage)
    await Promise.all(Array.from({ length: 12 }, () => usage.recordTokens(3, 5)))
    expect((await UsageLedger.open(file)).snapshot()).toMatchObject({ inputTokens: 36, outputTokens: 60 })
  })
  it('accepts explicit integer configuration, clamps bounds, and rejects invalid values', () => {
    expect(configuredLimit(undefined, 180, 1440)).toBe(180)
    expect(configuredLimit('0', 180, 1440)).toBe(1)
    expect(configuredLimit('2000', 180, 1440)).toBe(1440)
    expect(configuredLimit('500', 200, 1_000_000)).toBe(500)
    for (const value of ['NaN', '-1', '2.5', 'Infinity', '1e3']) expect(() => configuredLimit(value, 180, 1440)).toThrow()
  })
})
