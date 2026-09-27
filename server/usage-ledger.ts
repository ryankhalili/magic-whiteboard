import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z.object({
  commands: count, inputTokens: count, outputTokens: count, voiceSecondsReserved: count,
  imagesReserved: count.default(0), imageRequestHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100_000).default([]),
}).refine(value => new Set(value.imageRequestHashes).size === value.imageRequestHashes.length && value.imagesReserved >= value.imageRequestHashes.length)
export type UsageState = z.infer<typeof usageSchema>
const initial = (): UsageState => ({ commands: 0, inputTokens: 0, outputTokens: 0, voiceSecondsReserved: 0, imagesReserved: 0, imageRequestHashes: [] })

export class UsageLedgerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); this.name = 'UsageLedgerError' }
}

/** Numeric env overrides are explicit; invalid text cannot silently reset an allowance. */
export function configuredLimit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw new Error('Usage limit environment variables must be whole numbers.')
  return Math.max(1, Math.min(Number(value), maximum))
}

export async function atomicWriteUsage(filename: string, state: UsageState) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx')
    try { await file.writeFile(JSON.stringify(state, null, 2), 'utf8'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, filename)
  }
  finally { await unlink(temporary).catch(() => {}) }
}

/** A single serialized ledger commits reservations before paid requests can start. */
export class UsageLedger {
  private state = initial()
  private unavailable = false
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(private filename: string, private write: typeof atomicWriteUsage) {}
  static async open(filename: string, write = atomicWriteUsage) {
    const ledger = new UsageLedger(filename, write)
    try { ledger.state = usageSchema.parse(JSON.parse(await readFile(filename, 'utf8'))) }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) ledger.unavailable = true
    }
    return ledger
  }
  snapshot() {
    if (this.unavailable) return null
    const { imageRequestHashes: _privateHashes, ...publicCounters } = this.state
    return { ...publicCounters }
  }
  private change<T>(mutate: (state: UsageState) => T): Promise<T> {
    const transaction = this.queue.then(async () => {
      if (this.unavailable) throw new UsageLedgerError('usage_unavailable', 'Saved usage counters could not be read safely. Paid requests are disabled until the usage file is repaired.')
      const next = structuredClone(this.state), result = mutate(next)
      usageSchema.parse(next)
      try { await this.write(this.filename, next) }
      catch { this.unavailable = true; throw new UsageLedgerError('usage_unavailable', 'Could not safely save usage counters. No further paid requests will be sent.') }
      this.state = next
      return result
    })
    this.queue = transaction.catch(() => {})
    return transaction
  }
  reserveCommand(limit: number) {
    return this.change(state => {
      if (state.commands >= limit) throw new UsageLedgerError('local_command_limit', 'The configured command allowance has been reached. Check usage before increasing OPENAI_COMMAND_LIMIT.', 429)
      state.commands++
    })
  }
  recordTokens(input: number, output: number) {
    return this.change(state => { state.inputTokens += count.parse(input); state.outputTokens += count.parse(output) })
  }
  reserveVoice(maximumSeconds: number, totalLimit: number) {
    return this.change(state => {
      const seconds = Math.min(maximumSeconds, totalLimit - state.voiceSecondsReserved)
      if (seconds < 1) throw new UsageLedgerError('local_voice_limit', 'The configured voice allowance has been reached. Check usage before increasing OPENAI_VOICE_MINUTES_LIMIT.', 429)
      state.voiceSecondsReserved += seconds
      return seconds
    })
  }
  /** Call only after confirmed rejection/closure; uncertain provider outcomes keep the reservation. */
  settleVoice(reservedSeconds: number, usedSeconds: number) {
    return this.change(state => { state.voiceSecondsReserved = Math.max(0, state.voiceSecondsReserved - count.parse(reservedSeconds)) + count.parse(usedSeconds) })
  }
  reserveImage(requestId: string, limit: number) {
    return this.change(state => {
      const hash = createHash('sha256').update(requestId).digest('hex')
      if (state.imageRequestHashes.includes(hash)) throw new UsageLedgerError('request_already_reserved', 'This image request was already reserved before this server session. It will not be generated or charged again automatically.', 409)
      if (state.imagesReserved >= limit) throw new UsageLedgerError('local_image_limit', 'The configured image allowance has been reached. Check usage before increasing OPENAI_IMAGE_LIMIT.', 429)
      state.imagesReserved++; state.imageRequestHashes.push(hash)
    })
  }
  async flush() { await this.queue }
}
