import type { BoardContext, BoardOperation, Bounds } from '../../shared/board'
import { IMAGE_SIZES, type ImageGenerationJob, type ImageSize } from '../../shared/image-generation'
import type { Editor } from '../canvas/editor'
import { ApiRequestError, apiRequest } from '../ai/commands'
import { uuid } from '../utils/uuid'
import { fitImageInArea, imagePlacementArea, validImageBounds, validateImageConfirmation } from './placement'
import { insertGeneratedImage } from './insertGeneratedImage'

export type ImageDraft = {
  requestId: string; prompt: string; originalPrompt: string; bounds: Bounds; area?: Bounds; size: ImageSize;
  phase: 'review' | 'submitting' | 'generating' | 'uncertain' | 'failed'; message?: string;
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type ImageApi = (url: string, body: unknown | undefined, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>
type ClientOptions = {
  notebookId: string; getEditor: () => Editor | null; getContext: () => BoardContext;
  /** Resolve only after the inserted document has been checkpointed. */
  onInserted: () => void | Promise<void>;
  isCurrent?: () => boolean; storage?: DraftStorage; api?: ImageApi; makeId?: () => string; now?: () => number;
}
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export function readImageDraft(storage: DraftStorage | undefined, key: string): ImageDraft | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw || raw.length > 100_000) return null
    const value = JSON.parse(raw)
    if (!value || typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)
      || typeof value.prompt !== 'string' || value.prompt.length > 4000
      || (value.originalPrompt !== undefined && (typeof value.originalPrompt !== 'string' || value.originalPrompt.length > 3000))
      || !['review', 'submitting', 'generating', 'uncertain', 'failed'].includes(value.phase)
      || !IMAGE_SIZES.includes(value.size) || !validImageBounds(value.bounds)
      || (value.area !== undefined && !validImageBounds(value.area))) return null
    // Construct known fields only. Pending POSTs resume exclusively through GET.
    return { requestId: value.requestId, prompt: value.prompt, originalPrompt: value.originalPrompt ?? value.prompt.slice(0, 3000),
      size: value.size, bounds: { ...value.bounds }, area: { ...(value.area ?? value.bounds) },
      phase: value.phase === 'submitting' ? 'generating' : value.phase,
      ...(typeof value.message === 'string' ? { message: value.message.slice(0, 2000) } : {}) }
  } catch { return null }
}

class ImageResponseError extends Error {}
function checkedJob(input: unknown, requestId: string): ImageGenerationJob {
  const job = input as ImageGenerationJob | undefined
  if (!job || job.requestId !== requestId || !['queued', 'generating', 'completed', 'failed'].includes(job.status)
    || (job.status === 'completed' && !job.result)
    || (job.error !== undefined && (!job.error || typeof job.error.message !== 'string' || job.error.message.length > 4000))) {
    throw new ImageResponseError('The server returned an invalid image status. No new generation has been sent.')
  }
  return job
}

/** One notebook's recoverable image request, independent of React render/effect timing. */
export class ImageGenerationClient {
  readonly storageKey: string
  private draft: ImageDraft | null
  private readonly listeners = new Set<() => void>()
  private readonly api: ImageApi
  private readonly now: () => number
  private started = false
  private epoch = 0
  private sequence = 0
  private inFlight = false
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private failures = 0
  private pollDeadline = 0

  constructor(private readonly options: ClientOptions) {
    this.storageKey = `magic-whiteboard:image-job:${options.notebookId}`
    this.draft = readImageDraft(options.storage, this.storageKey)
    this.api = options.api ?? apiRequest
    this.now = options.now ?? Date.now
  }
  getSnapshot = () => this.draft
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private live() { return this.started && this.options.isCurrent?.() !== false }
  start = () => {
    if (this.started) return
    this.started = true; this.epoch++; this.pollDeadline = this.now() + 20 * 60_000
    if (this.draft?.phase === 'submitting') this.publish({ ...this.draft, phase: 'generating' })
    if (this.draft?.phase === 'generating') this.schedule(500)
  }
  stop = () => { this.started = false; this.epoch++; this.cancelFetch() }
  private cancelFetch() {
    clearTimeout(this.timer); this.timer = undefined
    this.sequence++; this.controller?.abort(); this.controller = undefined; this.inFlight = false
  }
  private publish(value: ImageDraft | null) {
    this.draft = value
    try { if (value) this.options.storage?.setItem(this.storageKey, JSON.stringify(value)); else this.options.storage?.removeItem(this.storageKey) }
    catch { /* The current tab can continue; storage failure never creates a paid retry. */ }
    this.listeners.forEach(listener => listener())
  }
  propose = (operation: BoardOperation) => {
    if (!this.live()) throw new Error('Wait for this notebook to finish opening.')
    if (this.draft && !['review', 'failed'].includes(this.draft.phase)) throw new Error('An image request is still pending. Check its status before proposing another.')
    const prompt = (operation.prompt ?? '').trim()
    if (prompt.length > 4000) throw new Error('Keep the image description under 4,000 characters.')
    const size: ImageSize = '1536x1024', area = imagePlacementArea(this.options.getContext(), operation)
    this.cancelFetch()
    this.publish({ requestId: (this.options.makeId ?? uuid)(), prompt, originalPrompt: (operation.text || prompt).slice(0, 3000),
      area, size, bounds: fitImageInArea(area, size), phase: 'review' })
  }
  revise = (patch: Partial<Pick<ImageDraft, 'prompt' | 'size'>>) => {
    const value = this.draft
    if (!this.live() || value?.phase !== 'review') return
    if ((patch.prompt !== undefined && (typeof patch.prompt !== 'string' || patch.prompt.length > 4000))
      || (patch.size !== undefined && !IMAGE_SIZES.includes(patch.size))) throw new Error('Choose a supported format and keep the description under 4,000 characters.')
    const size = patch.size ?? value.size, area = value.area ?? value.bounds
    this.publish({ ...value, ...patch, size, area, bounds: fitImageInArea(area, size), message: undefined })
  }
  placeHere = () => {
    const value = this.draft
    if (!this.live() || value?.phase !== 'review') return
    const area = imagePlacementArea(this.options.getContext(), { type: 'propose_image' })
    this.publish({ ...value, area, bounds: fitImageInArea(area, value.size), message: undefined })
  }
  dismiss = () => {
    if (!this.live() || !['review', 'failed', 'uncertain'].includes(this.draft?.phase ?? '')) return
    this.cancelFetch(); this.publish(null)
  }
  reviewAgain = () => {
    if (!this.live() || !this.draft || !['failed', 'uncertain'].includes(this.draft.phase)) return
    this.cancelFetch()
    this.publish({ ...this.draft, requestId: (this.options.makeId ?? uuid)(), phase: 'review', message: undefined })
  }
  confirm = async () => {
    const value = this.draft
    if (!this.live() || !value || value.phase !== 'review' || !value.prompt.trim()) return
    try { validateImageConfirmation(this.options.getContext(), value.bounds) }
    catch (error) {
      this.publish({ ...value, message: error instanceof Error ? error.message : 'Choose a valid work area before confirming.' })
      return
    }
    // Synchronous phase transition prevents a second checkmark from issuing another POST.
    this.publish({ ...value, prompt: value.prompt.trim(), phase: 'submitting', message: undefined })
    this.failures = 0; this.pollDeadline = this.now() + 20 * 60_000
    await this.fetchJob(true)
  }
  check = async () => {
    if (!this.live() || !this.draft || ['review', 'submitting'].includes(this.draft.phase) || this.inFlight) return
    clearTimeout(this.timer)
    this.failures = 0; this.pollDeadline = this.now() + 20 * 60_000
    await this.fetchJob(false, true)
  }
  private schedule(delay: number) {
    clearTimeout(this.timer)
    if (!this.live() || this.draft?.phase !== 'generating') return
    this.timer = setTimeout(() => { void this.fetchJob(false) }, delay)
  }
  private async fetchJob(post: boolean, manual = false) {
    const value = this.draft
    if (!this.live() || !value || this.inFlight) return
    if (!post && this.now() >= this.pollDeadline) {
      this.publish({ ...value, phase: 'uncertain', message: 'This image is taking longer than expected. Check the same request when ready; no new generation has been sent.' }); return
    }
    const epoch = this.epoch, sequence = ++this.sequence
    const controller = new AbortController(); this.controller = controller; this.inFlight = true
    const current = () => this.live() && !controller.signal.aborted && epoch === this.epoch && sequence === this.sequence && this.draft?.requestId === value.requestId
    let retryDelay = 1500
    try {
      const response = await this.api(post ? '/api/images' : `/api/images/${encodeURIComponent(value.requestId)}`,
        post ? { requestId: value.requestId, prompt: value.prompt.trim(), originalPrompt: value.originalPrompt || value.prompt.trim().slice(0, 3000), size: value.size, confirmed: true } : undefined,
        { signal: controller.signal, timeoutMs: post ? 35_000 : 15_000 })
      if (!current()) return
      const job = checkedJob(response, value.requestId)
      this.failures = 0
      if (job.status === 'completed') {
        if (`${job.result!.width}x${job.result!.height}` !== value.size) throw new ImageResponseError('The image dimensions do not match the confirmed format. No new generation has been sent.')
        const editor = this.options.getEditor()
        if (!editor) {
          this.publish({ ...value, phase: 'uncertain', message: 'The image is ready. Wait for this notebook to open, then check its status to insert it.' }); return
        }
        try {
          insertGeneratedImage(editor, value.requestId, job.result!, value.bounds, value.originalPrompt || value.prompt)
          // Keep the recovery ID until its image is saved, including across a reload.
          await this.options.onInserted()
        } catch (error) {
          if (current()) this.publish({ ...value, phase: 'uncertain', message: `${error instanceof Error ? error.message : 'The image could not be saved.'} Check this same request after resolving the issue; no new generation is needed.` })
          return
        }
        if (current()) this.publish(null)
      } else if (job.status === 'failed') this.publish({ ...value, phase: 'failed', message: job.error?.message || 'This image could not finish. Review the description before confirming a new request.' })
      else this.publish({ ...value, phase: 'generating', message: undefined })
    } catch (error) {
      if (!current()) return
      this.failures++
      const terminal = error instanceof ImageResponseError || (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
      if (post || manual || terminal || this.failures >= 3) {
        const reason = error instanceof Error ? error.message : 'The connection was interrupted.'
        this.publish({ ...value, phase: 'uncertain', message: `${reason} Check this existing request before confirming another image; no automatic generation retry was sent.` })
      } else retryDelay = Math.max(3000 * this.failures, error instanceof ApiRequestError ? error.retryAfterMs ?? 0 : 0)
    } finally {
      if (sequence === this.sequence) { this.inFlight = false; this.controller = undefined }
      if (current() && this.draft?.phase === 'generating') this.schedule(retryDelay)
    }
  }
}
