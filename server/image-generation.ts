import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { z } from 'zod'
import {
  DEFAULT_IMAGE_MODEL, IMAGE_QUALITY, IMAGE_SIZES,
  type GeneratedImage, type ImageGenerationJob, type ImageGenerationRequest,
  type ImageGenerationUsage, type ImageTokenUsage,
} from '../shared/image-generation'

export { DEFAULT_IMAGE_MODEL } from '../shared/image-generation'

export const imageGenerationRequestSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
  prompt: z.string().trim().min(1).max(4000),
  originalPrompt: z.string().trim().max(3000).optional(),
  size: z.enum(IMAGE_SIZES),
  confirmed: z.literal(true),
}).strict()

export class ImageJobError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message)
    this.name = 'ImageJobError'
  }
}

export interface ImageProviderContext {
  model: string
  quality: typeof IMAGE_QUALITY
  signal: AbortSignal
}
export type ImageProviderResult = GeneratedImage & { usage?: ImageTokenUsage }
/** Providers must perform one attempt only and honor signal; the manager never retries. */
export type ImageProvider = (request: ImageGenerationRequest, context: ImageProviderContext) => Promise<ImageProviderResult>

export interface ImageJobManagerOptions {
  provider: ImageProvider
  model?: string
  /** Persist a spend reservation before any provider call. Throw to refuse generation. */
  reserve?: (owner: string, request: ImageGenerationRequest) => Promise<void>
  limit?: number
  maxQueued?: number
  timeoutMs?: number
  resultTtlMs?: number
  maxRetainedBytes?: number
  now?: () => number
}

type Entry = {
  owner: string
  fingerprint: string
  request: ImageGenerationRequest
  job: ImageGenerationJob
  expiryTimer?: ReturnType<typeof setTimeout>
}
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function positiveInteger(value: number | undefined, fallback: number, maximum: number) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid image service limit.')
  return result
}

/** Validate bounded PNG bytes and read dimensions rather than trusting response metadata. */
export function decodeGeneratedPng(base64: string): GeneratedImage {
  if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new ImageJobError('invalid_image', 'The image service returned an invalid or oversized PNG.', 502)
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 33 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageJobError('invalid_image', 'The image service returned an invalid PNG.', 502)
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 1536 || height > 1536 || width * height > 1536 * 1024) {
    throw new ImageJobError('invalid_image', 'The image service returned unsupported image dimensions.', 502)
  }
  return { dataUrl: `data:image/png;base64,${base64}`, width, height }
}

function validatedResult(result: ImageProviderResult, size: ImageGenerationRequest['size']): ImageProviderResult {
  if (typeof result?.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/png;base64,')) {
    throw new ImageJobError('invalid_image', 'The image service did not return a PNG.', 502)
  }
  const image = decodeGeneratedPng(result.dataUrl.slice('data:image/png;base64,'.length))
  if (`${image.width}x${image.height}` !== size) {
    throw new ImageJobError('invalid_image', 'The image service returned a different image size than requested.', 502)
  }
  const usage = result.usage && Object.values(result.usage).every(n => Number.isSafeInteger(n) && n >= 0)
    ? { ...result.usage } : undefined
  return { ...image, ...(usage ? { usage } : {}) }
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ImageJobError) return { code: error.code, message: error.message }
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'content_policy_violation' || code === 'moderation_blocked') {
    return { code: 'image_declined', message: 'OpenAI declined this image request. Edit the description before confirming another request.' }
  }
  if (status === 401) return { code: 'invalid_key', message: 'The OpenAI API key is invalid or expired.' }
  if (status === 403 || status === 404) return { code: 'model_unavailable', message: 'This OpenAI project cannot access the image model. Check model access and organization verification.' }
  if (status === 429) return { code: 'provider_limit', message: 'OpenAI reports an image rate or credit limit. Check the project balance before trying a new request.' }
  if (status === 400) return { code: 'provider_rejected', message: 'OpenAI could not accept this image request. No automatic retry was made.' }
  return { code: 'generation_failed', message: 'Image generation could not finish. This request will not be sent again automatically; check usage before confirming a new request.' }
}

/**
 * One active provider promise, a bounded queue, and process-lifetime tombstones.
 * Results expire, IDs do not. Supply reserve() with durable ID/counter storage to
 * keep this guarantee across restarts. Polling never calls reserve or a provider.
 */
export class ImageJobManager {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: Entry[] = []
  private readonly now: () => number
  private readonly limit: number
  private readonly maxQueued: number
  private readonly timeoutMs: number
  private readonly resultTtlMs: number
  private readonly maxRetainedBytes: number
  private active: Entry | undefined
  private activeController: AbortController | undefined
  private disposed = false
  readonly model: string

  constructor(private readonly options: ImageJobManagerOptions) {
    this.now = options.now ?? Date.now
    this.model = options.model ?? DEFAULT_IMAGE_MODEL
    if (!/^gpt-image-[A-Za-z0-9.-]{1,80}$/.test(this.model)) throw new Error('Invalid image model.')
    this.limit = positiveInteger(options.limit, 20, 1000)
    this.maxQueued = positiveInteger(options.maxQueued, 4, 20)
    this.timeoutMs = positiveInteger(options.timeoutMs, 180_000, 600_000)
    this.resultTtlMs = positiveInteger(options.resultTtlMs, 30 * 60_000, 24 * 60 * 60_000)
    this.maxRetainedBytes = positiveInteger(options.maxRetainedBytes, 48 * 1024 * 1024, 256 * 1024 * 1024)
  }

  async submit(owner: string, input: unknown): Promise<ImageGenerationJob> {
    if (this.disposed) throw new ImageJobError('service_stopped', 'The image service is restarting.', 503)
    if (!owner || owner.length > 512) throw new ImageJobError('invalid_owner', 'Pair this device before generating an image.', 401)
    const parsed = imageGenerationRequestSchema.safeParse(input)
    if (!parsed.success) throw new ImageJobError('invalid_request', 'Confirm a description of 1–4000 characters and a supported image size.')
    const request = parsed.data
    const key = this.key(owner, request.requestId)
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    this.expireResults()
    const previous = this.entries.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ImageJobError('request_conflict', 'This image request ID already belongs to a different description or size.', 409)
      return this.view(previous)
    }
    if (this.entries.size >= this.limit) throw new ImageJobError('local_limit', 'The local image allowance has been reached. Check OpenAI billing before increasing it.', 429)
    if (this.active && this.queue.length >= this.maxQueued) throw new ImageJobError('queue_full', 'The image queue is full. Wait for an existing image to finish.', 429)
    const timestamp = this.now()
    const entry: Entry = {
      owner, fingerprint, request,
      job: { requestId: request.requestId, status: 'queued', createdAt: timestamp, updatedAt: timestamp, model: this.model, quality: IMAGE_QUALITY, size: request.size },
    }
    // Insert synchronously before any await: simultaneous duplicate submissions share this entry.
    this.entries.set(key, entry)
    this.queue.push(entry)
    this.pump()
    return this.view(entry)
  }

  get(owner: string, requestId: string): ImageGenerationJob | null {
    this.expireResults()
    const entry = this.entries.get(this.key(owner, requestId))
    return entry ? this.view(entry) : null
  }

  getUsage(): ImageGenerationUsage {
    return { reserved: this.entries.size, limit: this.limit, active: this.active ? 1 : 0, queued: this.queue.length }
  }

  dispose() {
    this.disposed = true
    this.activeController?.abort()
    for (const entry of this.entries.values()) {
      clearTimeout(entry.expiryTimer)
      if (entry.job.status === 'queued' || entry.job.status === 'generating') this.fail(entry, { code: 'service_stopped', message: 'The image service stopped. This request was not retried automatically.' })
    }
    this.queue.length = 0
  }

  private key(owner: string, requestId: string) { return JSON.stringify([owner, requestId]) }
  private view(entry: Entry): ImageGenerationJob { return structuredClone(entry.job) }
  private fail(entry: Entry, error: { code: string; message: string }) {
    entry.job.status = 'failed'
    entry.job.updatedAt = this.now()
    entry.job.error = error
    delete entry.job.result
  }
  private expireResults() {
    for (const entry of this.entries.values()) {
      if (entry.job.result && entry.job.expiresAt! <= this.now()) {
        clearTimeout(entry.expiryTimer)
        this.fail(entry, { code: 'result_expired', message: 'This generated image expired from the temporary server cache. It will not be generated or charged again automatically.' })
      }
    }
  }
  private trimResults() {
    this.expireResults()
    const results = [...this.entries.values()].filter(e => e.job.result).sort((a, b) => a.job.updatedAt - b.job.updatedAt)
    let bytes = results.reduce((total, e) => total + e.job.result!.dataUrl.length, 0)
    for (const entry of results) {
      if (bytes <= this.maxRetainedBytes) break
      bytes -= entry.job.result!.dataUrl.length
      clearTimeout(entry.expiryTimer)
      this.fail(entry, { code: 'result_expired', message: 'This image was removed from the bounded server cache. It will not be generated or charged again automatically.' })
    }
  }
  private pump() {
    if (this.active || this.disposed) return
    const entry = this.queue.shift()
    if (!entry) return
    this.active = entry
    void this.run(entry)
  }
  private async run(entry: Entry) {
    const controller = new AbortController()
    this.activeController = controller
    entry.job.status = 'generating'
    entry.job.updatedAt = this.now()
    const timer = setTimeout(() => {
      this.fail(entry, { code: 'generation_timeout', message: 'Image generation timed out. The provider may have charged this request; it will not be retried automatically.' })
      controller.abort()
    }, this.timeoutMs)
    timer.unref?.()
    try {
      try { await this.options.reserve?.(entry.owner, { ...entry.request }) }
      catch (error) {
        throw error instanceof ImageJobError ? error : new ImageJobError('reservation_failed', 'Could not safely save the image allowance. No image request was sent.', 503)
      }
      if (controller.signal.aborted) return
      const raw = await this.options.provider({ ...entry.request }, { model: this.model, quality: IMAGE_QUALITY, signal: controller.signal })
      if (controller.signal.aborted) return
      const result = validatedResult(raw, entry.request.size)
      entry.job.status = 'completed'
      entry.job.updatedAt = this.now()
      entry.job.expiresAt = this.now() + this.resultTtlMs
      entry.job.result = { dataUrl: result.dataUrl, width: result.width, height: result.height }
      if (result.usage) entry.job.usage = result.usage
      entry.expiryTimer = setTimeout(() => this.expireResults(), this.resultTtlMs)
      entry.expiryTimer.unref?.()
      this.trimResults()
    } catch (error) {
      if (!controller.signal.aborted) this.fail(entry, failure(error))
    } finally {
      clearTimeout(timer)
      // Do not release this slot at timeout: an abort-ignoring provider may still be running.
      this.active = undefined
      this.activeController = undefined
      this.pump()
    }
  }
}

/** Current Image API contract: GPT Image returns base64, not response_format URLs. */
export function imageProviderPrompt(request: ImageGenerationRequest): string {
  const original = request.originalPrompt?.trim(), reviewed = request.prompt.trim()
  if (!original || original === reviewed) return reviewed
  return `Create one image using the reviewed image description below. The original request provides context; if the descriptions differ, follow the reviewed description.\n\nOriginal request:\n${original}\n\nReviewed image description:\n${reviewed}`
}

export function createOpenAIImageProvider(readKey: () => Promise<string | undefined>): ImageProvider {
  return async (request, context) => {
    const key = await readKey()
    if (!key) throw new ImageJobError('missing_key', 'Add an OpenAI API key on the laptop before generating an image.', 503)
    context.signal.throwIfAborted()
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 180_000 })
    const response = await client.images.generate({
      model: context.model, prompt: imageProviderPrompt(request), n: 1,
      quality: context.quality, size: request.size, output_format: 'png', stream: false,
    }, { signal: context.signal, maxRetries: 0 })
    const encoded = response.data?.[0]?.b64_json
    if (response.data?.length !== 1 || !encoded) throw new ImageJobError('invalid_image', 'The image service did not return one PNG.', 502)
    const image = decodeGeneratedPng(encoded)
    return { ...image, ...(response.usage ? { usage: {
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens,
    } } : {}) }
  }
}
