import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageGenerationClient, readImageDraft, type ImageDraft } from './imageGenerationClient'
import { ApiRequestError } from '../ai/commands'
import { Editor } from '../canvas/editor'
import type { BoardContext } from '../../shared/board'
import { generatedPng } from '../../tests/fixtures/generated-image'

const context: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const image = generatedPng(1536, 1024)
const jobId = 'request-test-0001'
const result = (status = 'completed') => ({ requestId: jobId, status, size: '1536x1024', result: status === 'completed' ? image : undefined })
const saved: ImageDraft = { requestId: jobId, prompt: 'A leaf diagram', originalPrompt: 'Draw a leaf', size: '1536x1024', bounds: { x: 10, y: 20, w: 300, h: 200 }, phase: 'generating' }
function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const clients: ImageGenerationClient[] = []
function setup(overrides: Partial<ConstructorParameters<typeof ImageGenerationClient>[0]> = {}) {
  const store = overrides.storage ?? storage(), editor = new Editor(), api = vi.fn().mockResolvedValue(result())
  const inserted = vi.fn()
  const client = new ImageGenerationClient({ notebookId: 'notebook-a', getEditor: () => editor, getContext: () => context,
    onInserted: inserted, storage: store, api, makeId: () => jobId, ...overrides })
  clients.push(client); client.start()
  return { client, editor, api, store, inserted }
}
const propose = (client: ImageGenerationClient) => client.propose({ type: 'propose_image', prompt: saved.prompt, text: saved.originalPrompt })
beforeEach(() => vi.useFakeTimers())
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.useRealTimers() })

describe('notebook-scoped image client', () => {
  it('sends nothing before confirmation and sends only one POST for repeated checkmarks', async () => {
    const pending = deferred<unknown>(), { client, api, editor } = setup()
    api.mockReturnValue(pending.promise)
    propose(client)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api).not.toHaveBeenCalled()
    const first = client.confirm(); await client.confirm(); await client.check()
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0]).toBe('/api/images')
    expect(api.mock.calls[0][1]).toMatchObject({ confirmed: true, originalPrompt: saved.originalPrompt })
    pending.resolve(result()); await first
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(client.getSnapshot()).toBeNull()
  })

  it.each(['submitting', 'generating'] as const)('resumes a reloaded %s request with GET only', async phase => {
    const store = storage(); store.setItem('magic-whiteboard:image-job:notebook-a', JSON.stringify({ ...saved, phase }))
    const { client, api, editor } = setup({ storage: store })
    await vi.advanceTimersByTimeAsync(501)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0]).toBe(`/api/images/${jobId}`)
    expect(api.mock.calls[0][1]).toBeUndefined()
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(client.getSnapshot()).toBeNull()
  })

  it('keeps a lost POST response recoverable and checks the same ID without another POST', async () => {
    const { client, api, editor } = setup()
    api.mockRejectedValueOnce(new TypeError('Network interruption')).mockResolvedValueOnce(result())
    propose(client); await client.confirm()
    expect(client.getSnapshot()?.phase).toBe('uncertain')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api).toHaveBeenCalledTimes(1)
    await client.check()
    expect(api.mock.calls.map(call => call[1] === undefined ? 'GET' : 'POST')).toEqual(['POST', 'GET'])
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
  })

  it('ignores late responses after unmount and keeps the recovery draft for reopening', async () => {
    const pending = deferred<unknown>(), { client, api, editor, store, inserted } = setup()
    api.mockReturnValue(pending.promise)
    propose(client); const operation = client.confirm(); client.stop()
    pending.resolve(result()); await operation
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    expect(inserted).not.toHaveBeenCalled()
    expect(store.getItem(client.storageKey)).toContain(jobId)
    expect(api.mock.calls[0][2].signal.aborted).toBe(true)
  })

  it('rejects a response when the notebook changes even before the old effect cleanup', async () => {
    const pending = deferred<unknown>(), newEditor = new Editor()
    let currentNotebook = 'notebook-a'
    const { client, api, editor, store } = setup({ isCurrent: () => currentNotebook === 'notebook-a', getEditor: () => newEditor })
    api.mockReturnValue(pending.promise)
    propose(client); const operation = client.confirm(); currentNotebook = 'notebook-b'
    pending.resolve(result()); await operation
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    expect(newEditor.getCurrentPageShapes()).toHaveLength(0)
    expect(store.getItem('magic-whiteboard:image-job:notebook-b')).toBeNull()
  })

  it('resumes through GET after an effect restart and ignores the earlier POST completion', async () => {
    const pending = deferred<unknown>(), { client, api, editor } = setup()
    api.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result())
    propose(client); const first = client.confirm()
    client.stop(); client.start()
    await vi.advanceTimersByTimeAsync(501)
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    pending.resolve(result()); await first
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(api.mock.calls.map(call => call[1] === undefined ? 'GET' : 'POST')).toEqual(['POST', 'GET'])
  })

  it('keeps the recovery ID until checkpoint success and retries a failed checkpoint without duplicate insertion', async () => {
    const checkpoint = deferred<void>(), onInserted = vi.fn().mockReturnValueOnce(checkpoint.promise).mockResolvedValueOnce(undefined)
    const { client, editor, store, api } = setup({ onInserted })
    propose(client); const first = client.confirm()
    await Promise.resolve(); await Promise.resolve()
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(store.getItem(client.storageKey)).toContain(jobId)
    checkpoint.reject(new Error('Disk is full')); await first
    expect(client.getSnapshot()?.phase).toBe('uncertain')
    await client.check()
    expect(api).toHaveBeenCalledTimes(2)
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(onInserted).toHaveBeenCalledTimes(2)
    expect(store.getItem(client.storageKey)).toBeNull()
    editor.undo(); expect(editor.getCurrentPageShapes()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })

  it('does not insert into an editor whose notebook snapshot is not ready', async () => {
    let ready = false
    const editor = new Editor(), { client } = setup({ getEditor: () => ready ? editor : null })
    propose(client); await client.confirm()
    expect(client.getSnapshot()?.phase).toBe('uncertain')
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    ready = true; await client.check()
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
  })

  it.each([401, 403, 404])('stops automatic polling immediately on HTTP %s', async status => {
    const store = storage(); store.setItem('magic-whiteboard:image-job:notebook-a', JSON.stringify(saved))
    const { client, api } = setup({ storage: store })
    api.mockRejectedValue(new ApiRequestError('Existing request unavailable', status))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(api).toHaveBeenCalledTimes(1)
    expect(client.getSnapshot()?.phase).toBe('uncertain')
  })

  it('bounds transient polling failures and never repeats generation', async () => {
    const store = storage(); store.setItem('magic-whiteboard:image-job:notebook-a', JSON.stringify(saved))
    const { client, api } = setup({ storage: store })
    api.mockRejectedValue(new TypeError('offline'))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(api).toHaveBeenCalledTimes(3)
    expect(api.mock.calls.every(call => call[1] === undefined)).toBe(true)
    expect(client.getSnapshot()?.phase).toBe('uncertain')
  })

  it('stops unending successful queued statuses after the overall polling window', async () => {
    const store = storage(); store.setItem('magic-whiteboard:image-job:notebook-a', JSON.stringify(saved))
    const { client, api } = setup({ storage: store })
    api.mockResolvedValue(result('queued'))
    await vi.advanceTimersByTimeAsync(21 * 60_000)
    const count = api.mock.calls.length
    expect(client.getSnapshot()?.phase).toBe('uncertain')
    expect(count).toBeLessThanOrEqual(801)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api).toHaveBeenCalledTimes(count)
  })

  it('rejects mismatched or malformed completed statuses without inserting or polling again', async () => {
    for (const response of [{ ...result(), requestId: 'other-request' }, result('mystery'), { ...result(), result: undefined }, { ...result(), result: { ...image, dataUrl: 'data:image/png;base64,AA==' } }]) {
      const { client, api, editor } = setup()
      api.mockResolvedValue(response)
      propose(client); await client.confirm()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(client.getSnapshot()?.phase).toBe('uncertain')
      expect(editor.getCurrentPageShapes()).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores an in-flight status response after explicitly reviewing a new request', async () => {
    const pending = deferred<unknown>(), { client, api, editor } = setup()
    api.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise)
    propose(client); await client.confirm()
    const checking = client.check(); client.reviewAgain()
    pending.resolve(result()); await checking
    expect(client.getSnapshot()?.phase).toBe('review')
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })

  it('preserves the containing area through repeated image-format changes', () => {
    const { client } = setup()
    propose(client)
    const original = client.getSnapshot()!.bounds
    client.revise({ size: '1024x1024' }); client.revise({ size: '1024x1536' }); client.revise({ size: '1536x1024' })
    expect(client.getSnapshot()!.bounds).toEqual(original)
  })

  it('rechecks Literal mode before spending, while preserving placement approved before later focus changes', async () => {
    let currentContext: BoardContext = { ...context, focusMode: 'reference' }
    const pending = deferred<unknown>(), { client, api, editor } = setup({ getContext: () => currentContext })
    propose(client)
    const approvedBounds = { ...client.getSnapshot()!.bounds }
    currentContext = { ...currentContext, focusMode: 'literal' }
    await client.confirm()
    expect(api).not.toHaveBeenCalled()
    expect(client.getSnapshot()).toMatchObject({ phase: 'review', message: expect.stringContaining('Circle an area') })

    currentContext = { ...currentContext, focus: { kind: 'region', targetIds: [], bounds: { ...approvedBounds, x: approvedBounds.x + 50 } } }
    await client.confirm()
    expect(api).not.toHaveBeenCalled()
    expect(client.getSnapshot()).toMatchObject({ phase: 'review', message: expect.stringContaining('inside the current Literal') })

    currentContext = { ...currentContext, focus: { kind: 'region', targetIds: [], bounds: approvedBounds } }
    api.mockReturnValueOnce(pending.promise)
    const confirmation = client.confirm()
    expect(api).toHaveBeenCalledTimes(1)
    currentContext = { ...currentContext, focus: null }
    pending.resolve(result()); await confirmation
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    const inserted = editor.getCurrentPageShapes()[0]
    expect(inserted).toMatchObject({ x: approvedBounds.x, y: approvedBounds.y, props: { w: approvedBounds.w, h: approvedBounds.h } })
    expect(client.getSnapshot()).toBeNull()
  })

  it('rejects malformed stored drafts and never reads a different notebook draft', () => {
    const store = storage(), key = 'magic-whiteboard:image-job:notebook-a'
    for (const patch of [{ bounds: { ...saved.bounds, w: -1 } }, { bounds: { ...saved.bounds, x: 1e12 } }, { originalPrompt: {} }, { requestId: '../unsafe' }, { prompt: 'x'.repeat(4001) }]) {
      store.setItem(key, JSON.stringify({ ...saved, ...patch }))
      expect(readImageDraft(store, key)).toBeNull()
    }
    store.setItem(key, JSON.stringify(saved))
    expect(setup({ notebookId: 'notebook-b', storage: store }).client.getSnapshot()).toBeNull()
  })
})
