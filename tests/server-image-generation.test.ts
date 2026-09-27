import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IMAGE_MODEL, type ImageGenerationRequest } from '../shared/image-generation'
import { createOpenAIImageProvider, decodeGeneratedPng, imageProviderPrompt, ImageJobError, ImageJobManager, type ImageProviderResult } from '../server/image-generation'

const sdk = vi.hoisted(() => ({ generate: vi.fn(), construct: vi.fn() }))
vi.mock('openai', () => ({ default: class {
  images = { generate: sdk.generate }
  constructor(options: unknown) { sdk.construct(options) }
} }))

function png(width = 1024, height = 1024) {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // Grayscale, eight-bit samples.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}
const encoded = png()
const image = { dataUrl: `data:image/png;base64,${encoded}`, width: 1024, height: 1024 }
const request = (requestId = 'request-0001'): ImageGenerationRequest => ({ requestId, prompt: 'A labeled plant cell diagram.', size: '1024x1024', confirmed: true })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
const managers: ImageJobManager[] = []
function manager(options: ConstructorParameters<typeof ImageJobManager>[0]) {
  const instance = new ImageJobManager(options)
  managers.push(instance)
  return instance
}
afterEach(() => {
  managers.splice(0).forEach(item => item.dispose())
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('confirmed image jobs', () => {
  it('rejects absent confirmation, long prompts, unsafe IDs and unsupported options before reservation', async () => {
    const provider = vi.fn().mockResolvedValue(image), reserve = vi.fn()
    const jobs = manager({ provider, reserve })
    for (const invalid of [
      { ...request(), confirmed: false }, { ...request(), confirmed: undefined },
      { ...request(), prompt: ' ' }, { ...request(), prompt: 'x'.repeat(4001) },
      { ...request(), originalPrompt: 'x'.repeat(3001) }, { ...request(), size: 'auto' },
      { ...request(), requestId: '../a/b/c' }, { ...request(), n: 2 },
    ]) await expect(jobs.submit('device-a', invalid)).rejects.toMatchObject({ code: 'invalid_request', status: 400 })
    expect(provider).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(jobs.getUsage().reserved).toBe(0)
  })

  it('shares one reservation and provider call across 100 concurrent duplicate submissions and polls', async () => {
    const pending = deferred<ImageProviderResult>()
    const provider = vi.fn(() => pending.promise), reserve = vi.fn().mockResolvedValue(undefined)
    const jobs = manager({ provider, reserve })
    const submitted = await Promise.all(Array.from({ length: 100 }, () => jobs.submit('device-a', request())))
    await settle()
    expect(submitted.every(job => job.requestId === request().requestId)).toBe(true)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(jobs.get('device-a', request().requestId)?.status).toBe('generating')
    pending.resolve(image)
    await settle()
    const completed = await jobs.submit('device-a', request())
    expect(completed).toMatchObject({ status: 'completed', model: DEFAULT_IMAGE_MODEL, quality: 'low', result: image })
    expect(jobs.getUsage()).toEqual({ reserved: 1, limit: 20, active: 0, queued: 0 })
    expect(provider).toHaveBeenCalledTimes(1)
    completed.result!.width = 9
    expect(jobs.get('device-a', request().requestId)?.result?.width).toBe(1024)
  })

  it('isolates owners and rejects changed payloads under the same request ID', async () => {
    const provider = vi.fn().mockResolvedValue(image)
    const jobs = manager({ provider })
    await jobs.submit('device-a', request())
    await settle()
    expect(jobs.get('device-b', request().requestId)).toBeNull()
    await expect(jobs.submit('device-a', { ...request(), prompt: 'A different picture' })).rejects.toMatchObject({ code: 'request_conflict' })
    await jobs.submit('device-b', request())
    await settle()
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('serializes distinct jobs and rejects queue overflow without consuming allowance', async () => {
    const first = deferred<ImageProviderResult>()
    const provider = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(image)
    const jobs = manager({ provider, maxQueued: 2 })
    await jobs.submit('a', request('request-one'))
    await jobs.submit('a', request('request-two'))
    await jobs.submit('a', request('request-three'))
    await expect(jobs.submit('a', request('request-four'))).rejects.toMatchObject({ code: 'queue_full' })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(jobs.get('a', 'request-two')?.status).toBe('queued')
    expect(jobs.getUsage()).toMatchObject({ reserved: 3, active: 1, queued: 2 })
    first.resolve(image)
    await settle()
    expect(provider).toHaveBeenCalledTimes(3)
    expect(jobs.get('a', 'request-three')?.status).toBe('completed')
  })

  it('waits for a durable reservation and refuses a previously spent request across manager restarts', async () => {
    const stored = new Set<string>(), disk = deferred<void>()
    const provider = vi.fn().mockResolvedValue(image)
    const reserve = vi.fn(async (_owner: string, input: ImageGenerationRequest) => {
      if (stored.has(input.requestId)) throw new ImageJobError('already_spent', 'This request was already reserved; its previous result is unavailable.', 409)
      stored.add(input.requestId)
      await disk.promise
    })
    const first = manager({ provider, reserve })
    await first.submit('a', request())
    await settle()
    expect(provider).not.toHaveBeenCalled()
    disk.resolve()
    await settle()
    expect(provider).toHaveBeenCalledTimes(1)
    first.dispose()
    const restarted = manager({ provider, reserve })
    await restarted.submit('a', request())
    await settle()
    expect(restarted.get('a', request().requestId)).toMatchObject({ status: 'failed', error: { code: 'already_spent' } })
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('fails closed on reservation disk failure and never sends a provider request', async () => {
    const provider = vi.fn(), reserve = vi.fn().mockRejectedValue(new Error('private filesystem detail'))
    const jobs = manager({ provider, reserve })
    await jobs.submit('a', request())
    await settle()
    expect(jobs.get('a', request().requestId)).toMatchObject({ status: 'failed', error: { code: 'reservation_failed' } })
    await jobs.submit('a', request())
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(provider).not.toHaveBeenCalled()
    expect(JSON.stringify(jobs.get('a', request().requestId))).not.toContain('private filesystem')
  })

  it('retains failed IDs and counts possibly charged failures against the local allowance', async () => {
    const provider = vi.fn().mockRejectedValue({ status: 429, message: 'private provider response' })
    const jobs = manager({ provider, limit: 1 })
    await jobs.submit('a', request())
    await settle()
    expect(await jobs.submit('a', request())).toMatchObject({ status: 'failed', error: { code: 'provider_limit' } })
    await expect(jobs.submit('a', request('request-0002'))).rejects.toMatchObject({ code: 'local_limit' })
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('expires image bytes but keeps the request tombstone so a lost-response retry never rebills', async () => {
    vi.useFakeTimers()
    const provider = vi.fn().mockResolvedValue(image)
    const jobs = manager({ provider, resultTtlMs: 1000 })
    await jobs.submit('a', request())
    await settle()
    expect(jobs.get('a', request().requestId)?.result).toEqual(image)
    await vi.advanceTimersByTimeAsync(1001)
    const expired = await jobs.submit('a', request())
    expect(expired).toMatchObject({ status: 'failed', error: { code: 'result_expired' } })
    expect(expired.result).toBeUndefined()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('evicts older completed bytes under the memory bound without releasing their IDs', async () => {
    const provider = vi.fn().mockResolvedValue(image)
    const jobs = manager({ provider, maxRetainedBytes: image.dataUrl.length + 1 })
    await jobs.submit('a', request('request-0001'))
    await settle()
    await jobs.submit('a', request('request-0002'))
    await settle()
    expect(jobs.get('a', 'request-0001')?.error?.code).toBe('result_expired')
    expect(jobs.get('a', 'request-0002')?.result).toEqual(image)
    await jobs.submit('a', request('request-0001'))
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('aborts at the deadline but holds concurrency until an abort-ignoring provider settles', async () => {
    vi.useFakeTimers()
    const hanging = deferred<ImageProviderResult>()
    const provider = vi.fn().mockImplementationOnce(() => hanging.promise).mockResolvedValue(image)
    const jobs = manager({ provider, timeoutMs: 100 })
    await jobs.submit('a', request('request-0001'))
    await jobs.submit('a', request('request-0002'))
    await vi.advanceTimersByTimeAsync(101)
    expect(jobs.get('a', 'request-0001')).toMatchObject({ status: 'failed', error: { code: 'generation_timeout' } })
    expect(provider.mock.calls[0][1].signal.aborted).toBe(true)
    expect(jobs.getUsage()).toMatchObject({ active: 1, queued: 1 })
    expect(provider).toHaveBeenCalledTimes(1)
    hanging.resolve(image)
    await settle()
    expect(provider).toHaveBeenCalledTimes(2)
    expect(jobs.get('a', 'request-0001')?.result).toBeUndefined()
    expect(jobs.get('a', 'request-0002')?.status).toBe('completed')
  })

  it('does not start a provider when a reservation completes after timeout', async () => {
    vi.useFakeTimers()
    const disk = deferred<void>(), provider = vi.fn().mockResolvedValue(image)
    const jobs = manager({ provider, timeoutMs: 100, reserve: () => disk.promise })
    await jobs.submit('a', request())
    await vi.advanceTimersByTimeAsync(101)
    disk.resolve()
    await settle()
    expect(provider).not.toHaveBeenCalled()
    expect(jobs.get('a', request().requestId)?.error?.code).toBe('generation_timeout')
  })

  it('rejects invalid provider bytes and mismatched actual PNG dimensions', async () => {
    const provider = vi.fn().mockResolvedValueOnce({ ...image, dataUrl: 'https://untrusted.example/image.png' })
      .mockResolvedValueOnce({ ...image, dataUrl: `data:image/png;base64,${png(1024, 1536)}` })
    const jobs = manager({ provider })
    await jobs.submit('a', request('request-0001'))
    await settle()
    await jobs.submit('a', request('request-0002'))
    await settle()
    expect(jobs.get('a', 'request-0001')?.error?.code).toBe('invalid_image')
    expect(jobs.get('a', 'request-0002')?.error?.code).toBe('invalid_image')
    expect(() => decodeGeneratedPng(Buffer.from('<svg/>').toString('base64'))).toThrow('invalid')
  })
})

describe('OpenAI image provider boundary', () => {
  it('forwards the original request alongside the reviewed description, making reviewed changes authoritative', () => {
    const prompt = imageProviderPrompt({ ...request(), originalPrompt: 'Draw a red leaf', prompt: 'Draw a green leaf in a botany diagram' })
    expect(prompt).toContain('Original request:\nDraw a red leaf')
    expect(prompt).toContain('Reviewed image description:\nDraw a green leaf in a botany diagram')
    expect(prompt).toContain('if the descriptions differ, follow the reviewed description')
    expect(imageProviderPrompt({ ...request(), originalPrompt: request().prompt })).toBe(request().prompt)
  })
  it('makes exactly one low-quality PNG call with automatic SDK retries disabled', async () => {
    sdk.generate.mockResolvedValue({ data: [{ b64_json: encoded }], usage: { input_tokens: 20, output_tokens: 300, total_tokens: 320 } })
    const readKey = vi.fn().mockResolvedValue('unit-test-placeholder')
    const provider = createOpenAIImageProvider(readKey)
    const controller = new AbortController()
    const result = await provider(request(), { model: DEFAULT_IMAGE_MODEL, quality: 'low', signal: controller.signal })
    expect(sdk.construct).toHaveBeenCalledWith({ apiKey: 'unit-test-placeholder', maxRetries: 0, timeout: 180_000 })
    expect(sdk.generate).toHaveBeenCalledExactlyOnceWith({
      model: DEFAULT_IMAGE_MODEL, prompt: request().prompt, n: 1,
      quality: 'low', size: '1024x1024', output_format: 'png', stream: false,
    }, { signal: controller.signal, maxRetries: 0 })
    expect(result).toMatchObject({ ...image, usage: { inputTokens: 20, outputTokens: 300, totalTokens: 320 } })
  })

  it('does not call the SDK without a key or after cancellation', async () => {
    const controller = new AbortController()
    const context = { model: DEFAULT_IMAGE_MODEL, quality: 'low' as const, signal: controller.signal }
    await expect(createOpenAIImageProvider(async () => undefined)(request(), context)).rejects.toMatchObject({ code: 'missing_key' })
    controller.abort()
    await expect(createOpenAIImageProvider(async () => 'unit-test-placeholder')(request(), context)).rejects.toThrow()
    expect(sdk.generate).not.toHaveBeenCalled()
  })
})
