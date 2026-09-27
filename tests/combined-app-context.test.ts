import { describe, expect, it } from 'vitest'
import type { BoardContext } from '../shared/board'
import { captureBoardCommandGuard, localContextObjects, modelObjects } from '../src/appLogic'
import { createBoardController } from '../src/board/controller'
import { Editor } from '../src/canvas/editor'
import { prepareTextDictation } from '../src/ai/text-dictation'

describe('PDF integration with local text targeting', () => {
  it('retains precise bounds so literal dictation can extend a text object on fractional canvas coordinates', () => {
    const editor = new Editor()
    const region = { x: 10.25, y: 20.25, w: 300.25, h: 100.25 }
    const base: BoardContext = { dictationMode: 'text', focusMode: 'literal',
      focus: { kind: 'region', bounds: region, targetIds: [] }, pointer: null, selectedIds: [], lastCreatedIds: [],
      viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [] }
    const controller = createBoardController(editor, () => base)
    const created = controller.applyOperations([{ type: 'create_text', text: 'The cell', placement: 'focus' }])
    expect(created.ok).toBe(true)
    const id = created.ids[0], important = new Set([id]), objects = controller.getObjects()
    const context: BoardContext = { ...base, focus: { ...base.focus!, targetIds: [id] }, selectedIds: [id], lastCreatedIds: [id],
      objects: localContextObjects(objects, important, region) }
    expect(context.objects[0].bounds.x).toBeCloseTo(region.x)
    expect(context.objects[0].bounds.y).toBeCloseTo(region.y)
    const result = prepareTextDictation('has a nucleus.', context, context)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.reason)
    expect(controller.applyOperations(result.command.operations).ok).toBe(true)
    expect(controller.getObjects()[0].text).toBe('The cell has a nucleus.')

    // Transport-size rounding would put its left/top outside the exact literal region.
    const rounded = { ...context, objects: modelObjects(objects, important, region) }
    expect(prepareTextDictation('has a nucleus.', rounded, rounded)).toMatchObject({ ok: false, reason: expect.stringContaining('fully inside') })
  })

  it('preserves model ordering and PDF text visibility without mutating original bounds', () => {
    const bounds = { x: 4.125, y: 8.375, w: 300.25, h: 150.75 }
    const source = [
      { id: 'page:offscreen', kind: 'pdf_page', bounds: { ...bounds, x: 5000 }, rotation: 0, text: 'Outside visible region' },
      { id: 'text:chosen', kind: 'text', bounds, rotation: 0, text: 'Chosen note' },
    ]
    const result = localContextObjects(source, new Set(['text:chosen']), { x: 0, y: 0, w: 1200, h: 800 })
    expect(result.map(object => object.id)).toEqual(['text:chosen', 'page:offscreen'])
    expect(result[0].bounds).toEqual(bounds)
    expect(result[0].bounds).not.toBe(bounds)
    expect(result[1].text).toBeUndefined()
    expect(source[0].text).toBe('Outside visible region')
  })
})

describe('delayed library commit guard', () => {
  it.each(['cancelled', 'unmounted', 'not-ready', 'new-notebook', 'new-editor', 'source-changed', 'library-changed', 'still-current'] as const)('handles %s while the page renders', async change => {
    const editor = new Editor()
    const state = { active: true, ready: true, notebookId: 'first', editor, boardKey: 'source-one', libraryKey: 'book:first,match:1' }
    const abort = new AbortController()
    const { isCurrent: current } = captureBoardCommandGuard(() => state, () => !abort.signal.aborted)
    let finish!: () => void
    const rendered = new Promise<void>(resolve => { finish = resolve })
    let committed = false
    const insert = async () => { await rendered; if (current()) committed = true }
    const pending = insert()
    if (change === 'cancelled') abort.abort()
    if (change === 'unmounted') state.active = false
    if (change === 'not-ready') state.ready = false
    if (change === 'new-notebook') state.notebookId = 'second'
    if (change === 'new-editor') state.editor = new Editor()
    if (change === 'source-changed') state.boardKey = 'source-two'
    if (change === 'library-changed') state.libraryKey = 'book:second,match:2'
    finish()
    await pending
    expect(committed).toBe(change === 'still-current')
  })

  it('accepts its own open-book change without accepting a different board or cancelled instruction', () => {
    const state = { active: true, ready: true, notebookId: 'first', editor: new Editor(), boardKey: 'original', libraryKey: 'closed' }
    const abort = new AbortController()
    const guard = captureBoardCommandGuard(() => state, () => !abort.signal.aborted)
    expect(guard.isCurrent()).toBe(true)
    state.libraryKey = 'opened-by-instruction'
    guard.acceptLibraryChange()
    expect(guard.isCurrent()).toBe(true)
    state.boardKey = 'manually-edited'
    guard.acceptLibraryChange()
    expect(guard.isCurrent()).toBe(false)
    state.boardKey = 'original'
    abort.abort()
    guard.acceptLibraryChange()
    expect(guard.isCurrent()).toBe(false)
  })
})
