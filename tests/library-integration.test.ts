import { describe, expect, it, vi } from 'vitest'
import { Editor, type AssetRecord, type TLShape } from '../src/canvas/editor'
import { normalizeSnapshot } from '../src/canvas/migration'
import { createBoardController, focusImageBounds, getPlacementBounds, libraryAssetId, libraryImageSize, libraryItemKey, libraryQueryFromOperation, spotForOption } from '../src/board/controller'
import { objectLabel } from '../src/board/ObjectInspector'
import { findSpots, guessContentSize, NATURAL_SIZES } from '../src/board/placementSpots'
import { detectLibraryIntent } from '../src/library/intent'
import { BOARD_INSTRUCTIONS, boardTools, commandSchema, compactContext, contextInstructions, contextSchema, placementOptionsFor, requestSchema, withPlacementOptions, type CommandRequest } from '../server/board-tools'
import { runBoardCommand, type BoardModelResponse, type CommandRecoveryOptions } from '../server/command-repair'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { readBoardCommand } from '../server/command-response'
import { localRank, type RankRequest, type RankResult } from '../shared/ranking'
import { parseBoardCommand } from '../shared/tool-command'
import { createBoundsFor, createInsertLock, inspectorZone, manualOverride, matchWithReindex, reindexTarget, revealShift } from '../src/library/insertLayout'
import type { BoardContext, BoardObject, BoardOperation, Bounds, PlacementOption } from '../shared/board'
import { readFileSync } from 'node:fs'
import { addedBounds, asksForPanelPage, boardOnly, commandAllowance, createSpeechStart, freeSpots, instructionTooLong, isPairingError, localHistoryCommand, MAX_INSTRUCTION, modelLibrary, modelObjects, onSheet, wantsPlacement } from '../src/appLogic'
import { ApiRequestError } from '../src/ai/commands'
import { contextFingerprint } from '../src/ai/voice-recovery'
import { PAGE_BOUNDS } from '../src/files/boardFiles'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA=='
const BOOK = 'sha256:' + 'a'.repeat(64)

const baseContext = (extra: Partial<BoardContext> = {}): BoardContext => ({
  focus: null, pointer: { x: 500, y: 400 }, selectedIds: [], lastCreatedIds: [],
  viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [], ...extra,
})
function setup(extra: Partial<BoardContext> = {}) {
  const editor = new Editor()
  const context = baseContext(extra)
  const controller = createBoardController(editor, () => ({ ...context, selectedIds: editor.getSelectedShapeIds() }))
  return { editor, controller, context }
}
const assets = (editor: Editor) => editor.store.allRecords().filter((record): record is AssetRecord => record.typeName === 'asset')
const shapes = (editor: Editor) => editor.getCurrentPageShapes() as TLShape[]

function pageOp(index = 30, label: string | null = '23', bounds = { x: 100, y: 80, w: 700, h: 906 }): BoardOperation {
  return {
    type: 'create_image', image: { src: JPEG, w: 1391, h: 1800, mimeType: 'image/jpeg', name: `Calculus Volume 1, page ${label}` }, bounds, locked: true,
    meta: { assetKey: `${BOOK}#${index}:page`, library: { bookId: BOOK, title: 'Calculus Volume 1', pageIndex: index, pageLabel: label, kind: 'page' } },
  }
}
function itemOp(bounds = { x: 100, y: 80, w: 640, h: 180 }): BoardOperation {
  return {
    type: 'create_image', image: { src: PNG, w: 1400, h: 394, mimeType: 'image/png', name: 'Example 3.2, Calculus Volume 1' }, bounds,
    meta: { assetKey: `${BOOK}#199:example:3.2:item`, library: { bookId: BOOK, title: 'Calculus Volume 1', pageIndex: 199, pageLabel: '191', kind: 'item', itemKind: 'example', itemLabel: '3.2', anchorId: `${BOOK}#199:example:3.2` } },
  }
}

describe('create_image in the board controller', () => {
  it('adds a whole page as a locked image with its asset, without selecting it', () => {
    const { editor, controller } = setup()
    const result = controller.applyOperations([pageOp()])
    expect(result.ok, result.message).toBe(true)
    const [shape] = shapes(editor)
    expect(shape).toMatchObject({ type: 'image', isLocked: true, x: 100, y: 80, meta: { marginaliaBackground: false } })
    if (shape.type !== 'image') throw new Error('expected an image')
    expect(shape.props).toMatchObject({ w: 700, h: 906, assetId: libraryAssetId(`${BOOK}#30:page`) })
    expect(editor.getAsset(shape.props.assetId)?.props).toMatchObject({ src: JPEG, w: 1391, h: 1800, mimeType: 'image/jpeg' })
    expect(result.ids).toEqual([shape.id])
    expect(editor.getSelectedShapeIds()).toEqual([])
    expect(controller.lastCreatedIds).toEqual([shape.id])
  })
  it('reuses the same asset when the same page is inserted again', () => {
    const { editor, controller } = setup()
    expect(controller.applyOperations([pageOp()]).ok).toBe(true)
    expect(controller.applyOperations([pageOp(30, '23', { x: 900, y: 80, w: 700, h: 906 })]).ok).toBe(true)
    expect(controller.applyOperations([pageOp(31, '24', { x: 1700, y: 80, w: 700, h: 906 })]).ok).toBe(true)
    const ids = shapes(editor).map(shape => shape.type === 'image' ? shape.props.assetId : null)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
    expect(assets(editor)).toHaveLength(2)
    // two inserts of one page in a single batch share one asset too
    const other = setup()
    expect(other.controller.applyOperations([pageOp(), pageOp(30, '23', { x: 900, y: 80, w: 700, h: 906 })]).ok).toBe(true)
    expect(assets(other.editor)).toHaveLength(1)
    expect(shapes(other.editor)).toHaveLength(2)
  })
  it('gives images without an asset key their own asset', () => {
    const { editor, controller } = setup()
    const op = { ...pageOp(), meta: {} }
    expect(controller.applyOperations([op]).ok).toBe(true)
    expect(controller.applyOperations([op]).ok).toBe(true)
    expect(assets(editor)).toHaveLength(2)
  })
  it('selects an inserted problem and reports book items to the model', () => {
    const { editor, controller } = setup()
    const result = controller.applyOperations([itemOp()])
    expect(result.ok, result.message).toBe(true)
    expect(editor.getSelectedShapeIds()).toEqual(result.ids)
    expect(controller.applyOperations([pageOp(29, null, { x: 900, y: 80, w: 700, h: 906 })]).ok).toBe(true)
    const crop: BoardOperation = { ...itemOp({ x: 100, y: 1100, w: 300, h: 120 }), meta: { assetKey: `${BOOK}#30:crop:0.1,0.1,0.5,0.2`, library: { bookId: BOOK, title: 'Calculus Volume 1', pageIndex: 30, pageLabel: '23', kind: 'crop' } } }
    expect(controller.applyOperations([crop]).ok).toBe(true)
    // the locked page goes under everything, like paper, so it comes first
    const objects = controller.getObjects()
    expect(objects.map(o => [o.kind, o.title])).toEqual([
      ['textbook_page', 'Calculus Volume 1, file page 30'],
      ['textbook_item', 'Example 3.2 (page 191)'],
      ['textbook_item', 'Part of page 23, Calculus Volume 1'],
    ])
    expect(objects.every(o => o.text === undefined)).toBe(true)
    expect(objects[0].locked).toBe(true)
    expect(objectLabel(objects[1])).toBe('Book excerpt: Example 3.2 (page 191)')
    expect(objectLabel(objects[0])).toBe('Book page: Calculus Volume 1, file page 30')
  })
  it('reports imported worksheet pages as pdf_page with their text', () => {
    const { editor, controller } = setup()
    editor.createAssets([{ id: 'asset:sheet', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
    editor.run(() => editor.createShape({ type: 'image', x: 0, y: 0, isLocked: true, props: { assetId: 'asset:sheet', w: 612, h: 792 },
      meta: { marginaliaBackground: true, pdf: { doc: 'd1', name: 'Quiz', page: 1, pages: 2, at: 1, source: null, width: 612, height: 792, text: '1. Solve x + 2 = 5' } } }), { ignoreShapeLock: true })
    const [object] = controller.getObjects()
    expect(object).toMatchObject({ kind: 'pdf_page', title: 'Worksheet page 1 of 2: Quiz', text: '1. Solve x + 2 = 5' })
    expect(objectLabel(object)).toBe('PDF page: Worksheet page 1 of 2: Quiz')
  })
  it('undoes a page insert in one step and reloads the notebook with the book link intact', () => {
    const { editor, controller } = setup()
    expect(controller.applyOperations([pageOp()]).ok).toBe(true)
    const restored = new Editor(normalizeSnapshot(editor.getSnapshot()))
    const [shape] = shapes(restored)
    expect(shape.meta.library).toMatchObject({ kind: 'page', pageLabel: '23' })
    expect(shape.isLocked).toBe(true)
    expect(controller.applyOperations([{ type: 'undo' }]).ok).toBe(true)
    expect(shapes(editor)).toHaveLength(0)
  })
  it.each([
    ['a remote image', { ...pageOp(), image: { ...pageOp().image!, src: 'https://example.com/page.png' } }, /PNG or JPEG/],
    ['an svg', { ...pageOp(), image: { ...pageOp().image!, src: 'data:image/svg+xml;base64,PHN2Zz4=' } }, /PNG or JPEG/],
    ['a zero size', { ...pageOp(), image: { ...pageOp().image!, w: 0 } }, /invalid size/],
    ['no bounds', { ...pageOp(), bounds: undefined }, /place on the board/],
    ['tiny bounds', { ...pageOp(), bounds: { x: 0, y: 0, w: 8, h: 8 } }, /16 to 10,000/],
  ])('rejects %s and changes nothing', (_name, op, message) => {
    const { editor, controller } = setup()
    const result = controller.applyOperations([op as BoardOperation])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(message)
    expect(shapes(editor)).toHaveLength(0)
    expect(assets(editor)).toHaveLength(0)
  })
  it('keeps a batch atomic when a later operation fails', () => {
    const { editor, controller } = setup()
    const result = controller.applyOperations([pageOp(), { type: 'create_text', text: 'Solve', fontSize: 900 }])
    expect(result.ok).toBe(false)
    expect(shapes(editor)).toHaveLength(0)
    expect(assets(editor)).toHaveLength(0)
  })
  it('keeps an image inside a literal region', () => {
    const { controller } = setup({ focusMode: 'literal', focus: { kind: 'region', bounds: { x: 0, y: 0, w: 400, h: 400 }, targetIds: [] } })
    const outside = controller.applyOperations([itemOp({ x: 300, y: 0, w: 640, h: 180 })])
    expect(outside.ok).toBe(false)
    expect(outside.message).toMatch(/outside/)
    expect(controller.applyOperations([itemOp({ x: 0, y: 0, w: 400, h: 112 })]).ok).toBe(true)
  })
  it('never accepts library references directly', () => {
    const { controller } = setup()
    for (const type of ['insert_library', 'library_action'] as const) {
      const result = controller.applyOperations([{ type, page: '22' }])
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/not supported/)
    }
  })
})

const OPTIONS: PlacementOption[] = [
  { id: 'A', bounds: { x: 700, y: 100, w: 440, h: 320 }, note: 'right of the graph' },
  { id: 'B', bounds: { x: 100, y: 500, w: 440, h: 320 }, note: 'below the graph' },
  { id: 'C', bounds: { x: 700, y: 500, w: 440, h: 320 } },
]

describe('placementOption in getPlacementBounds', () => {
  it('centers the natural size in the chosen option', () => {
    const context = baseContext({ placementOptions: OPTIONS })
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'A' }, context, 'plot')).toEqual({ x: 700, y: 100, w: 440, h: 320 })
    expect(getPlacementBounds({ type: 'create_math', placementOption: 'B' }, context, 'math')).toEqual({ x: 130, y: 587.5, w: 380, h: 145 })
  })
  it('falls back to the usual placement when the option is missing or a focus exists', () => {
    const viewportCenter = { x: 600 - 220, y: 400 - 160, w: 440, h: 320 }
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'C' }, baseContext(), 'plot')).toEqual(viewportCenter)
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'B' }, baseContext({ placementOptions: [OPTIONS[0]] }), 'plot')).toEqual(viewportCenter)
    const focus = { kind: 'region' as const, bounds: { x: 0, y: 0, w: 200, h: 200 }, targetIds: [] }
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'A' }, baseContext({ focus, placementOptions: OPTIONS }), 'plot')).toEqual({ x: -120, y: -60, w: 440, h: 320 })
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'A', placement: 'pointer' }, baseContext({ placementOptions: OPTIONS }), 'plot')).toEqual({ x: 280, y: 240, w: 440, h: 320 })
  })
  it('explicit bounds still win over an option', () => {
    const bounds = { x: 5, y: 6, w: 300, h: 200 }
    expect(getPlacementBounds({ type: 'create_plot', placementOption: 'A', bounds }, baseContext({ placementOptions: OPTIONS }), 'plot')).toEqual(bounds)
  })
  it('places objects that share an option side by side through the controller', () => {
    const { editor, controller } = setup({ placementOptions: OPTIONS })
    const result = controller.applyOperations([{ type: 'create_plot', expression: 'x^2', placementOption: 'A' }, { type: 'create_math', latex: 'x^2', placementOption: 'A' }])
    expect(result.ok, result.message).toBe(true)
    const [plot, math] = result.ids.map(id => editor.getShapePageBounds(id)!)
    expect({ x: plot.x, y: plot.y, w: plot.w, h: plot.h }).toEqual({ x: 700, y: 100, w: 440, h: 320 })
    expect(math.x).toBeCloseTo(plot.x + plot.w + 24)
  })
})

describe('library image placement helpers', () => {
  it('sizes pages at 700 wide and problems at most 640 wide with work space below', () => {
    expect(libraryImageSize({ w: 1391, h: 1800 }, 'page')).toEqual({ w: 700, h: 700 * 1800 / 1391, workBelow: 0 })
    const item = libraryImageSize({ w: 1400, h: 394 }, 'item')
    expect(item.w).toBe(640)
    expect(item.h).toBeCloseTo(640 * 394 / 1400)
    expect(item.workBelow).toBe(260)
    const tall = libraryImageSize({ w: 1400, h: 1400 }, 'crop')
    expect(tall.workBelow).toBeCloseTo(1.2 * 640)
    expect(libraryImageSize({ w: 300, h: 60 }, 'item')).toMatchObject({ w: 150, h: 30 })
    const thin = libraryImageSize({ w: 1400, h: 10 }, 'item')
    expect(thin.h).toBeGreaterThanOrEqual(16)
    expect(libraryImageSize({ w: 0, h: 0 }, 'page').w).toBe(700)
  })
  it('puts images at the focus: top left in reference mode, fitted in literal mode', () => {
    const size = { w: 640, h: 200 }
    const region = { kind: 'region' as const, bounds: { x: 50, y: 60, w: 320, h: 300 }, targetIds: [] }
    expect(focusImageBounds(size, baseContext())).toBeNull()
    expect(focusImageBounds(size, baseContext({ focus: region }))).toEqual({ x: 50, y: 60, w: 640, h: 200 })
    expect(focusImageBounds(size, baseContext({ focus: { kind: 'point', bounds: { x: 7, y: 8, w: 0, h: 0 }, targetIds: [] } }))).toEqual({ x: 7, y: 8, w: 640, h: 200 })
    expect(focusImageBounds(size, baseContext({ focus: region, focusMode: 'literal' }))).toEqual({ x: 50, y: 60, w: 320, h: 100 })
    expect(() => focusImageBounds(size, baseContext({ focusMode: 'literal' }))).toThrow(/Circle an area/)
  })
  it('maps a model option to the nearest free spot for the real image size', () => {
    const spots = findSpots({ viewport: { x: 0, y: 0, w: 1400, h: 900 }, obstacles: [{ x: 100, y: 100, w: 400, h: 300 }], size: { w: 640, h: 180 }, workBelow: 260 })
    expect(spots.length).toBeGreaterThan(1)
    const target = spots[1].bounds
    expect(spotForOption({ id: 'B', bounds: { ...target, x: target.x + 10, w: 440, h: 320 } }, spots, { w: 640, h: 180 })).toEqual({ x: target.x, y: target.y, w: 640, h: 180 })
    expect(spotForOption({ id: 'A', bounds: { x: 5, y: 6, w: 440, h: 320 } }, [], { w: 640, h: 180 })).toEqual({ x: 5, y: 6, w: 640, h: 180 })
  })
  it('natural sizes stay in step with the controller', () => {
    for (const kind of ['plot', 'math', 'geometry', 'text'] as const) {
      const b = getPlacementBounds({ type: `create_${kind}` as BoardOperation['type'], placement: 'auto' }, baseContext(), kind)
      expect({ w: b.w, h: b.h }).toEqual(NATURAL_SIZES[kind])
    }
  })
})

describe('insert_library references and the local fast path', () => {
  it('turns model references into library queries', () => {
    expect(libraryQueryFromOperation({ type: 'insert_library', page: '22' })).toEqual({ kind: 'page', label: '22', raw: 'page 22' })
    expect(libraryQueryFromOperation({ type: 'insert_library', page: 'p. 023' })).toMatchObject({ kind: 'page', label: '23' })
    expect(libraryQueryFromOperation({ type: 'insert_library', page: 'XII', book: 'Calculus Volume 1' })).toMatchObject({ kind: 'page', label: 'xii', book: 'Calculus Volume 1' })
    expect(libraryQueryFromOperation({ type: 'insert_library', page: 'twenty two' })).toBeNull()
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'problem 3.2' })).toMatchObject({ kind: 'item', label: '3.2' })
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'problem 3.2' })).not.toHaveProperty('itemKind')
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'example 3.12' })).toMatchObject({ kind: 'item', label: '3.12', itemKind: 'example' })
    expect(libraryQueryFromOperation({ type: 'insert_library', item: '3.2' })).toMatchObject({ kind: 'item', label: '3.2' })
    expect(libraryQueryFromOperation({ type: 'insert_library', item: '#48' })).toMatchObject({ kind: 'item', label: '48' })
    expect(libraryQueryFromOperation({ type: 'insert_library', query: 'chain rule example', book: 'Calculus' })).toMatchObject({ kind: 'topic', book: 'Calculus' })
    expect(libraryQueryFromOperation({ type: 'insert_library' })).toBeNull()
  })
  it('keeps a section or chapter the model put beside the item', () => {
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'exercise 48 in section 5.1' })).toMatchObject({ kind: 'item', label: '48', itemKind: 'exercise', section: '5.1' })
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'exercise 48', query: 'in section 5.1' })).toMatchObject({ kind: 'item', label: '48', itemKind: 'exercise', section: '5.1' })
    expect(libraryQueryFromOperation({ type: 'insert_library', item: 'exercise 48', query: 'from chapter 5' })).toMatchObject({ kind: 'item', label: '48', chapter: '5' })
    // a query that names no place changes nothing
    const plain = libraryQueryFromOperation({ type: 'insert_library', item: 'exercise 48', query: 'the one about limits' })
    expect(plain).toMatchObject({ kind: 'item', label: '48', itemKind: 'exercise' })
    expect(plain).not.toHaveProperty('section')
    expect(plain).not.toHaveProperty('chapter')
  })
  it('gives an item drawn by a newer index its own image', () => {
    const id = `${BOOK}#226:theorem:3.4`
    expect(libraryItemKey(id)).toBe(`${id}:item`)
    expect(libraryItemKey(id, 1)).toBe(`${id}:item`)
    expect(libraryAssetId(libraryItemKey(id, 2))).not.toBe(libraryAssetId(libraryItemKey(id)))
  })
  it('handles clear phrasings locally and gives the same query the model path would', () => {
    const state = { importPending: false, hasBooks: true }
    const page = detectLibraryIntent('page 23', state)
    expect(page).toMatchObject({ action: 'insert', query: { kind: 'page', label: '23' } })
    const item = detectLibraryIntent('problem 3.2', state)
    expect(item).toMatchObject({ action: 'insert', query: { kind: 'item', label: '3.2' } })
    if (item?.action === 'insert') expect(item.query).toMatchObject(libraryQueryFromOperation({ type: 'insert_library', item: 'problem 3.2' })!)
    expect(detectLibraryIntent('store it', { importPending: true, hasBooks: false })).toEqual({ action: 'route_import', to: 'library' })
    expect(detectLibraryIntent('put it on the board', { importPending: true, hasBooks: true })).toEqual({ action: 'route_import', to: 'board' })
    // everything else still goes to the model
    expect(detectLibraryIntent('plot y = x^2', state)).toBeNull()
    expect(detectLibraryIntent('page 23', { importPending: false, hasBooks: false })).toBeNull()
  })
})

describe('board tools for library operations', () => {
  it('accepts insert_library and library_action references', () => {
    const command = commandSchema.parse({ message: '', operations: [
      { type: 'insert_library', page: '22' },
      { type: 'insert_library', item: 'problem 3.2', book: 'Calculus Volume 1', placementOption: 'B' },
      { type: 'insert_library', query: 'chain rule example' },
      ...(['open_book', 'close_reference', 'store_import', 'board_import'] as const).map(action => ({ type: 'library_action', action, book: 'Calculus' })),
    ] })
    expect(command.operations.map(op => op.type)).toEqual(['insert_library', 'insert_library', 'insert_library', 'library_action', 'library_action', 'library_action', 'library_action'])
    expect(command.operations[1]).toMatchObject({ item: 'problem 3.2', placementOption: 'B' })
  })
  it('rejects images from the model and unknown library values', () => {
    const image = { type: 'create_image', image: { src: PNG, w: 1, h: 1, mimeType: 'image/png', name: 'x' }, bounds: { x: 0, y: 0, w: 100, h: 100 } }
    expect(commandSchema.safeParse({ message: '', operations: [image] }).success).toBe(false)
    expect(commandSchema.safeParse({ message: '', operations: [{ type: 'library_action', action: 'delete_book' }] }).success).toBe(false)
    expect(commandSchema.safeParse({ message: '', operations: [{ type: 'create_plot', placementOption: 'D' }] }).success).toBe(false)
    // the model output path rejects it too
    const response = { status: 'completed' as const, incomplete_details: null, output: [{ type: 'function_call' as const, name: 'apply_board_operations', call_id: 'c', arguments: JSON.stringify({ message: '', operations: [image] }) }] }
    expect(() => readBoardCommand(response)).toThrow(/invalid board edit/)
  })
  it('shows the model the new operations and fields but never create_image', () => {
    const schema = boardTools[0].parameters as any
    const properties = schema.properties.operations.items.properties
    expect(properties.type.enum).toEqual(expect.arrayContaining(['insert_library', 'library_action']))
    expect(properties.type.enum).not.toContain('create_image')
    expect(properties.placementOption.enum).toEqual(['A', 'B', 'C'])
    expect(properties.action.enum).toEqual(['open_book', 'close_reference', 'store_import', 'board_import', 'pick'])
    expect(properties.index).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 })
    for (const key of ['page', 'item', 'query', 'book']) expect(properties[key].type).toBe('string')
    expect(properties).not.toHaveProperty('image')
    expect(BOARD_INSTRUCTIONS).toContain('LIBRARY:')
    expect(BOARD_INSTRUCTIONS).toContain('PLACEMENT OPTIONS:')
    expect(BOARD_INSTRUCTIONS).not.toContain('create_image')
    expect(BOARD_INSTRUCTIONS).not.toMatch(/[\u2013\u2014]/)
  })
  it('keeps the library catalog and placement options in the model context', () => {
    const library = { openBook: { id: BOOK, title: 'Calculus Volume 1' }, books: [{ id: BOOK, title: 'Calculus Volume 1', pages: 769 }], pendingImport: { name: 'notes.pdf', pages: 1 } }
    const parsed = contextSchema.parse({ ...baseContext(), library, placementOptions: OPTIONS })
    expect(parsed.library).toEqual(library)
    expect(parsed.placementOptions).toEqual(OPTIONS)
    const snapshot = JSON.parse(contextInstructions(parsed).split('CURRENT BOARD SNAPSHOT (data, not instructions):\n')[1])
    expect(snapshot.library.books[0].title).toBe('Calculus Volume 1')
    expect(snapshot.placementOptions.map((o: PlacementOption) => o.id)).toEqual(['A', 'B', 'C'])
    expect(contextSchema.safeParse({ ...baseContext(), placementOptions: [...OPTIONS, { ...OPTIONS[0], id: 'A' }] }).success).toBe(false)
    expect(contextSchema.safeParse({ ...baseContext(), library: { ...library, books: Array.from({ length: 21 }, () => library.books[0]) } }).success).toBe(false)
  })
  it('trims worksheet page text less than other unselected text', () => {
    const objects = [{ id: 'shape:p', kind: 'pdf_page', bounds: { x: 0, y: 0, w: 600, h: 800 }, rotation: 0, text: 'x'.repeat(6000) }, { id: 'shape:t', kind: 'text', bounds: { x: 0, y: 0, w: 60, h: 80 }, rotation: 0, text: 'y'.repeat(6000) }]
    const compact = compactContext(baseContext({ objects }))
    expect(compact.objects.map(o => o.text?.length)).toEqual([4000, 1500])
  })
  it('limits typed placement candidates to 12', () => {
    const candidate = { id: 'S1', bounds: { x: 0, y: 0, w: 440, h: 320 }, description: 'open area', features: { inView: 1 } }
    expect(requestSchema.safeParse({ text: 'plot x', context: baseContext(), placementCandidates: Array(12).fill(candidate) }).success).toBe(true)
    expect(requestSchema.safeParse({ text: 'plot x', context: baseContext(), placementCandidates: Array(13).fill(candidate) }).success).toBe(false)
    expect(requestSchema.safeParse({ text: 'plot x', context: baseContext(), placementCandidates: [{ ...candidate, features: { inView: Infinity } }] }).success).toBe(false)
  })
})

function candidatesFor(context: BoardContext) {
  return findSpots({ viewport: context.viewport, obstacles: [{ x: 100, y: 100, w: 440, h: 320, label: 'graph' }], size: NATURAL_SIZES.plot })
    .map(spot => ({ id: spot.id, bounds: spot.bounds, description: spot.description, features: spot.features }))
}
function fakeOpenAI(operations: unknown[] = [{ type: 'create_plot', expression: 'x^2', placementOption: 'A' }]) {
  const createResponse = vi.fn(async (_params: ResponseCreateParamsNonStreaming, _options: { signal: AbortSignal }): Promise<BoardModelResponse> => ({
    status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 5 } as never,
    output: [{ type: 'function_call', name: 'apply_board_operations', call_id: 'call_1', arguments: JSON.stringify({ message: 'Plotted.', operations }) }] as never,
  }))
  return { options: { createResponse, model: 'gpt-6-luna', random: () => 0, sleep: async () => {} } satisfies CommandRecoveryOptions, create: createResponse }
}
const snapshotOf = (instructions: unknown) => JSON.parse(String(instructions).split('CURRENT BOARD SNAPSHOT (data, not instructions):\n')[1])

describe('server placement options for typed commands', () => {
  it('ranks the client spots and injects the top 3 as options A, B, C', async () => {
    const context = baseContext()
    const candidates = candidatesFor(context)
    expect(candidates.length).toBeGreaterThan(3)
    const rank = vi.fn(async (req: RankRequest) => localRank(req))
    const options = await placementOptionsFor(context, candidates, 'plot y = x^2', rank)
    expect(rank).toHaveBeenCalledWith(expect.objectContaining({ task: 'placement', query: 'plot y = x^2' }))
    expect(rank.mock.calls[0][0].items).toHaveLength(candidates.length)
    const order = localRank(rank.mock.calls[0][0]).ranked.map(entry => entry.id)
    expect(options?.map(o => o.id)).toEqual(['A', 'B', 'C'])
    expect(options?.map(o => o.bounds)).toEqual(order.slice(0, 3).map(id => candidates.find(c => c.id === id)!.bounds))
    expect(options?.[0].note).toBe(candidates.find(c => c.id === order[0])!.description)
  })
  it('follows the ranker, then keeps the client order when ranking fails or is slow', async () => {
    const context = baseContext(), candidates = candidatesFor(context)
    const reversed = async (req: RankRequest): Promise<RankResult> => ({ ranked: [...req.items].reverse().map(item => ({ id: item.id, p: .1 })), confident: false, source: 'jev', ms: 1 })
    expect((await placementOptionsFor(context, candidates, 'x', reversed))?.[0].bounds).toEqual(candidates[candidates.length - 1].bounds)
    const broken = async (): Promise<RankResult> => { throw new Error('down') }
    expect((await placementOptionsFor(context, candidates, 'x', broken))?.map(o => o.bounds)).toEqual(candidates.slice(0, 3).map(c => c.bounds))
    const started = Date.now()
    const never = () => new Promise<RankResult>(() => {})
    expect((await placementOptionsFor(context, candidates, 'x', never, 30))?.map(o => o.bounds)).toEqual(candidates.slice(0, 3).map(c => c.bounds))
    expect(Date.now() - started).toBeLessThan(1000)
    const unknown = async (): Promise<RankResult> => ({ ranked: [{ id: 'S99', p: 1 }], confident: true, source: 'jev', ms: 1 })
    expect((await placementOptionsFor(context, candidates, 'x', unknown))?.[0].bounds).toEqual(candidates[0].bounds)
  })
  it('offers no options when something is circled or no spots were sent', async () => {
    const focus = { kind: 'region' as const, bounds: { x: 0, y: 0, w: 100, h: 100 }, targetIds: [] }
    const rank = vi.fn(async (req: RankRequest) => localRank(req))
    expect(await placementOptionsFor(baseContext({ focus }), candidatesFor(baseContext()), 'x', rank)).toBeUndefined()
    expect(await placementOptionsFor(baseContext(), [], 'x', rank)).toBeUndefined()
    expect(await placementOptionsFor(baseContext(), undefined, 'x', rank)).toBeUndefined()
    expect(rank).not.toHaveBeenCalled()
  })
  it('sends the options inside the same OpenAI request and returns them to the client', async () => {
    const { options, create } = fakeOpenAI()
    const context = baseContext()
    const data: CommandRequest = requestSchema.parse({ text: 'plot y = x^2', context, placementCandidates: candidatesFor(context) })
    const { input, placementOptions } = await withPlacementOptions(data, async req => localRank(req))
    const command = await runBoardCommand(input, options)
    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0][0]
    expect(body).toMatchObject({ model: 'gpt-6-luna', tool_choice: { type: 'function', name: 'apply_board_operations' }, parallel_tool_calls: false, store: false })
    expect(body.input).toEqual([{ role: 'user', content: 'plot y = x^2' }])
    const snapshot = snapshotOf(body.instructions)
    expect(snapshot.placementOptions).toEqual(placementOptions)
    expect(snapshot.placementOptions.map((o: PlacementOption) => o.id)).toEqual(['A', 'B', 'C'])
    expect(snapshot).not.toHaveProperty('placementCandidates')
    expect(command.operations[0].placementOption).toBe('A')
    // the client applies the model's pick with the same options
    const b = getPlacementBounds(command.operations[0], { ...context, placementOptions }, 'plot')
    expect(b).toEqual({ ...placementOptions![0].bounds, w: 440, h: 320 })
  })
  it('drops stale client options when it has nothing to rank', async () => {
    const { options, create } = fakeOpenAI()
    const rank = vi.fn(async (req: RankRequest) => localRank(req))
    const data: CommandRequest = requestSchema.parse({ text: 'write hello', context: { ...baseContext(), placementOptions: OPTIONS } })
    const { input, placementOptions } = await withPlacementOptions(data, rank)
    await runBoardCommand(input, options)
    expect(placementOptions).toBeUndefined()
    expect(rank).not.toHaveBeenCalled()
    expect(snapshotOf(create.mock.calls[0][0].instructions)).not.toHaveProperty('placementOptions')
  })
  it('passes history and a screenshot through unchanged', async () => {
    const { options, create } = fakeOpenAI()
    const image = 'data:image/png;base64,iVBORw0KGgo='
    const data: CommandRequest = requestSchema.parse({ text: 'read this', context: baseContext(), history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], image })
    await runBoardCommand((await withPlacementOptions(data)).input, options)
    expect(create.mock.calls[0][0].input).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'input_text', text: 'read this' }, { type: 'input_image', image_url: image, detail: 'low' }] },
    ])
  })
})

const overlapping = (a: Bounds, b: Bounds) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('picking a highlighted match', () => {
  it('lets the model pick badge 1 to 3 with library_action pick', () => {
    const command = commandSchema.parse({ message: '', operations: [{ type: 'library_action', action: 'pick', index: 2 }] })
    expect(command.operations[0]).toMatchObject({ type: 'library_action', action: 'pick', index: 2 })
    // the voice path parses strictly, so index must be a known field
    expect(parseBoardCommand({ message: '', operations: [{ type: 'library_action', action: 'pick', index: 3 }] }).operations[0].index).toBe(3)
    for (const index of [0, 4, 1.5]) expect(commandSchema.safeParse({ message: '', operations: [{ type: 'library_action', action: 'pick', index }] }).success).toBe(false)
    expect(BOARD_INSTRUCTIONS).toContain('library.highlights')
    expect(BOARD_INSTRUCTIONS).toContain('"action":"pick","index":2')
  })
  it('gives the model the highlighted titles only, at most 3', () => {
    const library = { openBook: { id: BOOK, title: 'Calculus Volume 1' }, books: [{ id: BOOK, title: 'Calculus Volume 1', pages: 769 }], highlights: ['Example 3.2, p. 192', 'Checkpoint 3.2, p. 194', 'Whole page, p. 191'] }
    const parsed = contextSchema.parse({ ...baseContext(), library })
    expect(parsed.library?.highlights).toEqual(library.highlights)
    expect(JSON.parse(contextInstructions(parsed).split('CURRENT BOARD SNAPSHOT (data, not instructions):\n')[1]).library.highlights).toEqual(library.highlights)
    expect(contextSchema.safeParse({ ...baseContext(), library: { ...library, highlights: [...library.highlights, 'Fourth'] } }).success).toBe(false)
    expect(contextSchema.safeParse({ ...baseContext(), library: { ...library, highlights: ['x'.repeat(161)] } }).success).toBe(false)
  })
  it('turns "number 2" into a pick only while matches are highlighted', () => {
    const state = { importPending: false, hasBooks: true, bookTitles: ['Calculus Volume 1'] }
    expect(detectLibraryIntent('number 2', { ...state, highlightCount: 3 })).toEqual({ action: 'pick', index: 2 })
    expect(detectLibraryIntent('the second one', { ...state, highlightCount: 3 })).toEqual({ action: 'pick', index: 2 })
    expect(detectLibraryIntent('2', { ...state, highlightCount: 2 })).toEqual({ action: 'pick', index: 2 })
    expect(detectLibraryIntent('option 3', { ...state, highlightCount: 2 })?.action).not.toBe('pick')
    expect(detectLibraryIntent('number 2', { ...state, highlightCount: 0 })?.action).not.toBe('pick')
  })
})

describe('placing inserts next to new objects in the same request', () => {
  // the typed flow from the review: options for a bookish prompt, then "write Warm up and put problem 3.2 under it"
  const options: PlacementOption[] = [{ id: 'A', bounds: { x: 314, y: 56, w: 640, h: 360 } }, { id: 'B', bounds: { x: 314, y: 480, w: 640, h: 360 } }, { id: 'C', bounds: { x: 980, y: 56, w: 640, h: 360 } }]
  const image = { src: PNG, w: 1400, h: 400, mimeType: 'image/png' as const, name: 'Problem 3.2' }
  const place = (context: BoardContext, extra: Bounds[]) => {
    const size = libraryImageSize(image, 'item')
    const spots = findSpots({ viewport: context.viewport, obstacles: extra, size, workBelow: size.workBelow })
    return spotForOption(options[0], spots, size)
  }
  const imageOp = (bounds: Bounds): BoardOperation => ({ ...itemOp(bounds), image })
  it('keeps an insert clear of a create listed before it', () => {
    const { editor, controller, context } = setup({ placementOptions: options })
    const text: BoardOperation = { type: 'create_text', text: 'Warm up', placementOption: 'A' }
    const before = createBoundsFor(text, context)!
    expect(before).toEqual(getPlacementBounds(text, context, 'text'))
    const result = controller.applyOperations([text, imageOp(place(context, [before]))])
    expect(result.ok, result.message).toBe(true)
    const [a, b] = shapes(editor).map(shape => editor.getShapePageBounds(shape.id)!)
    expect(overlapping(a, b)).toBe(false)
  })
  it('overlapped before, when the create was ignored', () => {
    const { editor, controller, context } = setup({ placementOptions: options })
    expect(controller.applyOperations([{ type: 'create_text', text: 'Warm up', placementOption: 'A' }, imageOp(place(context, []))]).ok).toBe(true)
    const [a, b] = shapes(editor).map(shape => editor.getShapePageBounds(shape.id)!)
    expect(overlapping(a, b)).toBe(true)
  })
  it('lets the board move a create listed after an insert aside', () => {
    const { editor, controller, context } = setup({ placementOptions: options })
    const bounds = place(context, [])
    const text: BoardOperation = { type: 'create_text', text: 'Warm up', placementOption: 'A' }
    expect(controller.applyOperations([imageOp(bounds), text]).ok).toBe(true)
    const [a, b] = shapes(editor).map(shape => editor.getShapePageBounds(shape.id)!)
    expect(overlapping(a, b)).toBe(false)
    // and the prediction for it follows the board
    const predicted = createBoundsFor(text, context, [bounds])!
    expect({ x: Math.round(predicted.x), y: Math.round(predicted.y) }).toEqual({ x: Math.round(b.x), y: Math.round(b.y) })
  })
  it('predicts option A for a create without one and nothing for other operations', () => {
    const context = baseContext({ placementOptions: options })
    expect(createBoundsFor({ type: 'create_plot', expression: 'x' }, context)).toEqual(getPlacementBounds({ type: 'create_plot', placementOption: 'A' }, context, 'plot'))
    expect(createBoundsFor({ type: 'create_plot', expression: 'x', placement: 'auto' }, context)).toEqual(getPlacementBounds({ type: 'create_plot', placementOption: 'A' }, context, 'plot'))
    expect(createBoundsFor({ type: 'update_object', target: 'shape:x' }, context)).toBeNull()
    expect(createBoundsFor({ type: 'insert_library', page: '22' }, context)).toBeNull()
    expect(createBoundsFor({ type: 'create_plot', expression: 'x' }, baseContext({ focusMode: 'literal' }))).toBeNull()
  })
})

describe('reference panel inserts in Literal mode', () => {
  it('place like reference mode when nothing is circled, and stay inside a circled area', () => {
    const literal = baseContext({ focusMode: 'literal' })
    const { controller } = setup({ focusMode: 'literal' })
    expect(controller.applyOperations([itemOp()]).message).toMatch(/Circle an area/)
    const override = manualOverride(literal)
    expect(override).toEqual({ focusMode: 'reference' })
    const editor = new Editor()
    const manual = createBoardController(editor, () => ({ ...literal, ...override }))
    expect(manual.applyOperations([itemOp()]).ok).toBe(true)
    expect(focusImageBounds({ w: 640, h: 180 }, { ...literal, ...override })).toBeNull()
    const region = { kind: 'region' as const, bounds: { x: 0, y: 0, w: 400, h: 400 }, targetIds: [] }
    expect(manualOverride(baseContext({ focusMode: 'literal', focus: region }))).toBeNull()
    expect(manualOverride(baseContext())).toBeNull()
  })
})

describe('one insert at a time', () => {
  it('runs inserts in turn, reports when busy and frees itself after a failure', async () => {
    const changes: boolean[] = [], order: string[] = []
    const lock = createInsertLock(held => changes.push(held))
    let finish = () => {}
    const first = lock.run(async () => { order.push('typed start'); await new Promise<void>(resolve => { finish = resolve }); order.push('typed end'); return 1 })
    const second = lock.run(async () => { order.push('voice'); return 2 })
    await Promise.resolve()
    expect(lock.held()).toBe(true)
    expect(order).toEqual(['typed start'])
    finish()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(order).toEqual(['typed start', 'typed end', 'voice'])
    expect(lock.held()).toBe(false)
    await expect(lock.run(async () => { throw new Error('page failed') })).rejects.toThrow('page failed')
    expect(lock.held()).toBe(false)
    expect(changes).toEqual([true, false, true, false, true, false])
  })
})

describe('books that need a fresh index', () => {
  const match = { query: { kind: 'page' as const, label: '23', raw: 'page 23' }, book: {} as never, ranked: [], confident: true, source: 'exact' as const }
  it('updates the book once, then looks again', async () => {
    const lookup = vi.fn().mockResolvedValueOnce({ error: 'This book needs a quick update. Opening it now.', code: 'reindex', bookId: BOOK }).mockResolvedValueOnce(match)
    const reindex = vi.fn(async () => {})
    expect(await matchWithReindex(lookup, reindex)).toBe(match)
    expect(reindex).toHaveBeenCalledTimes(1)
    expect(reindex).toHaveBeenCalledWith(BOOK)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
  it('stops after one try and passes other answers through', async () => {
    const again = { error: 'x', code: 'reindex', bookId: BOOK }
    expect(await matchWithReindex(async () => again, async () => {})).toEqual({ error: 'This book could not be updated. Import it again.' })
    const reindex = vi.fn(async () => {})
    const missing = { error: 'No book called "physics" in your library.', books: [] }
    expect(await matchWithReindex(async () => missing, reindex)).toBe(missing)
    expect(reindex).not.toHaveBeenCalled()
    await expect(matchWithReindex(async () => again, async () => { throw new Error('This book is no longer in the library. Import it again.') })).rejects.toThrow(/no longer/)
    expect(reindexTarget({ error: 'x', code: 'other', bookId: BOOK })).toBeNull()
    expect(reindexTarget(match)).toBeNull()
  })
})

describe('keeping inserts in view and out from under panels', () => {
  const area = { left: 84, top: 120, right: 1424, bottom: 860 }
  it('leaves a visible insert where it is', () => {
    expect(revealShift({ left: 300, top: 200, right: 700, bottom: 400 }, area)).toBeNull()
    expect(revealShift({ left: 300, top: 200, right: 700, bottom: 400 }, area, [{ left: 800, top: 100, right: 1000, bottom: 900 }])).toBeNull()
  })
  it('glides the shortest way to show an insert that is off screen', () => {
    expect(revealShift({ left: 1300, top: 200, right: 1700, bottom: 400 }, area)).toEqual({ dx: -276, dy: 0 })
    expect(revealShift({ left: 300, top: 900, right: 700, bottom: 1100 }, area)).toEqual({ dx: 0, dy: -240 })
  })
  it('moves an insert out from under the reference panel', () => {
    const panel = { left: 80, top: 144, right: 460, bottom: 704 }
    expect(revealShift({ left: 200, top: 300, right: 600, bottom: 450 }, area, [panel])).toEqual({ dx: 276, dy: 0 })
  })
  it('covers where the inspector opens rather than the reference panel when nothing is clear', () => {
    // an iPad: reference panel on the left, inspector zone on the right, a problem wider than the gap
    const ipad = { left: 84, top: 120, right: 1008, bottom: 728 }
    const panel = { left: 80, top: 136, right: 460, bottom: 634 }, zone = inspectorZone({ left: 0, top: 64, right: 1024, bottom: 768 }, 1024)
    const shift = revealShift({ left: 100, top: 300, right: 600, bottom: 478 }, ipad, [panel, zone])!
    const left = 100 + shift.dx
    expect(left).toBeGreaterThanOrEqual(panel.right)
    expect(left + 500).toBeLessThanOrEqual(ipad.right)
    expect(left + 500).toBeGreaterThan(zone.left)
  })
  it('shows the top of an insert taller than the screen', () => {
    expect(revealShift({ left: 300, top: 500, right: 700, bottom: 1700 }, area)).toEqual({ dx: 0, dy: -380 })
  })
  it('knows where the inspector opens, so selected inserts avoid it', () => {
    const stage = { left: 0, top: 64, right: 1440, bottom: 900 }
    const zone = inspectorZone(stage, 1440)
    expect(zone).toEqual({ left: 1144, top: 128, right: 1422, bottom: 128 + 836 - 210, soft: true })
    expect(inspectorZone(stage, 700)).toMatchObject({ right: 1430, top: 121, left: 1430 - 242, bottom: 121 + 836 - 220 })
    const avoid = { x: zone.left, y: zone.top - 64, w: zone.right - zone.left, h: zone.bottom - zone.top }
    const spots = findSpots({ viewport: { x: 0, y: 0, w: 1440, h: 836 }, obstacles: [{ x: 100, y: 60, w: 700, h: 500 }], size: { w: 640, h: 183 }, workBelow: 260, avoid: [avoid] })
    expect(spots.length).toBeGreaterThan(0)
    for (const spot of spots) expect(overlapping(spot.bounds, avoid)).toBe(false)
  })
})

describe('typed requests the board answers itself', () => {
  it('runs undo and redo locally, with no model call', () => {
    for (const text of ['undo', 'Undo.', ' redo ', 'undo that', 'please undo', 'redo please', 'Undo the last change!']) expect(localHistoryCommand(text), text).toBe(/redo/i.test(text) ? 'redo' : 'undo')
    for (const text of ['undo and make it red', 'undo the last two changes', 'undone', 'why undo?', 'plot y = x^2']) expect(localHistoryCommand(text), text).toBeNull()
  })
  it('refuses a paste the server would reject with one plain message, and nothing else fails', () => {
    const paste = 'Write this word problem on the board: ' + 'A ladder 10 m long rests against a vertical wall. '.repeat(60)
    expect(paste.trim().length).toBe(3037)
    expect(instructionTooLong(paste)).toBe('That instruction is 3,037 characters long. Shorten it to 3,000 or fewer and send it again.')
    expect(instructionTooLong('x'.repeat(MAX_INSTRUCTION))).toBeNull()
    expect(instructionTooLong(`  ${'x'.repeat(MAX_INSTRUCTION)}  `)).toBeNull()
    // the same limit as the server, so a refused paste never reaches the history of later commands
    const context = baseContext()
    expect(requestSchema.safeParse({ text: 'x'.repeat(MAX_INSTRUCTION), context }).success).toBe(true)
    expect(requestSchema.safeParse({ text: 'x'.repeat(MAX_INSTRUCTION + 1), context }).success).toBe(false)
  })
  it('knows "this page" and "the page I\'m looking at" mean the page in the reference panel', () => {
    for (const text of ['this page', 'Put this page on the board.', 'insert the page I\u2019m looking at', 'show the page I have open', 'add the page I am on here', 'can you put the current page on the board please', 'the page I\'m on', 'give me this page']) expect(asksForPanelPage(text), text).toBe(true)
    for (const text of ['clean up this page', 'what is on this page?', 'put page 5 on the board', 'this page has a typo', 'page i', 'the page before this one']) expect(asksForPanelPage(text), text).toBe(false)
  })
  it('skips placement ranking for an edit of the selection that creates nothing', () => {
    const selected = { focus: null, selectedIds: ['shape:graph'] }
    for (const text of ['make it red', 'make the graph red', 'move it right a bit', 'delete it', 'change the plot to y = x^3', 'rotate this 90 degrees']) expect(wantsPlacement(text, selected), text).toBe(false)
    for (const text of ['write its derivative next to it', 'plot the derivative', 'add a label under it', 'graph y = 2x', 'make a table of values', 'solve it', 'show the tangent line']) expect(wantsPlacement(text, selected), text).toBe(true)
    // follow up questions right after a create, with the new graph still selected, place their answers beside it
    for (const text of ['find the derivative', "what's the derivative?", 'factor it', 'simplify it', 'find the roots', 'what are the roots?', 'evaluate it at x = 2', 'compute the integral', 'rewrite it in vertex form', 'complete the square', 'find the vertex', 'now do the second derivative', 'give me the tangent line at x = 1', 'what is f(2)?']) expect(wantsPlacement(text, selected), text).toBe(true)
    expect(wantsPlacement('make it red', { focus: null, selectedIds: [] })).toBe(true)
    expect(wantsPlacement('plot y = x', { focus: { kind: 'point', bounds: { x: 0, y: 0, w: 0, h: 0 }, targetIds: [] }, selectedIds: [] })).toBe(false)
  })
})

describe('what the model sees', () => {
  const view = { x: 0, y: 0, w: 1400, h: 900 }
  const lesson = (): BoardObject[] => [
    { id: 'shape:page1', kind: 'textbook_page', bounds: { x: 0, y: 0, w: 700, h: 906 }, rotation: 0, locked: true, title: 'Calculus Volume 1, page 23' },
    { id: 'shape:page2', kind: 'textbook_page', bounds: { x: 0, y: 950, w: 700, h: 906 }, rotation: 0, locked: true, title: 'Calculus Volume 1, page 24' },
    ...[1, 2, 3].map((n): BoardObject => ({ id: `shape:problem${n}`, kind: 'textbook_item', bounds: { x: 760, y: n * 300, w: 640, h: 180.4 }, rotation: 0, title: `Exercise ${n}` })),
    { id: 'shape:graph', kind: 'plot', bounds: { x: 760.2, y: 1300.7, w: 440, h: 320 }, rotation: 0, expression: 'x^2-4*x+3' },
    { id: 'shape:derivative', kind: 'math', bounds: { x: 1220, y: 1300, w: 300, h: 100 }, rotation: 0, latex: "f'(x)=2x-4" },
    // the teacher then works the problem by hand: every pen stroke is its own shape
    ...Array.from({ length: 40 }, (_, i): BoardObject => ({ id: `shape:ink${i}`, kind: 'draw', bounds: { x: 760 + (i % 4) * 60.37, y: 1650 + Math.floor(i / 4) * 45.61, w: 50.2, h: 20.9 }, rotation: 0, color: 'black' })),
  ]
  it('keeps the graph and the problems in the snapshot under a page of handwriting', () => {
    const objects = modelObjects(lesson(), new Set(), view)
    const snapshot = compactContext(contextSchema.parse(baseContext({ objects })) as BoardContext).objects
    expect(snapshot).toHaveLength(35)
    const ids = snapshot.map(o => o.id)
    for (const id of ['shape:graph', 'shape:derivative', 'shape:problem1', 'shape:problem2', 'shape:problem3', 'shape:page1', 'shape:page2']) expect(ids, id).toContain(id)
    // loose ink goes last, newest first among the rest
    expect(snapshot.slice(0, 7).every(o => o.kind !== 'draw')).toBe(true)
    // whole board units, never less than 1
    for (const o of objects) expect(Object.values(o.bounds).every(v => Number.isInteger(v)) && o.bounds.w >= 1 && o.bounds.h >= 1, o.id).toBe(true)
    expect(objects.find(o => o.id === 'shape:graph')!.bounds).toEqual({ x: 760, y: 1301, w: 440, h: 320 })
  })
  it('keeps circled or selected ink first, so cleaning up handwriting still has its ids', () => {
    const objects = modelObjects(lesson(), new Set(['shape:ink3', 'shape:ink4']), view)
    expect(objects.slice(0, 2).map(o => o.id)).toEqual(['shape:ink3', 'shape:ink4'])
  })
  it('sends worksheet text only for pages in view', () => {
    const pages: BoardObject[] = [
      { id: 'shape:w1', kind: 'pdf_page', bounds: { x: 0, y: 0, w: 794, h: 1123 }, rotation: 0, text: 'Problem 1' },
      { id: 'shape:w2', kind: 'pdf_page', bounds: { x: 0, y: 5000, w: 794, h: 1123 }, rotation: 0, text: 'Problem 9' },
    ]
    const objects = modelObjects(pages, new Set(), view)
    expect(objects.map(o => [o.id, o.text])).toEqual([['shape:w1', 'Problem 1'], ['shape:w2', undefined]])
  })
  const shelf = [
    { id: BOOK, title: 'Calculus Volume 1', fileName: 'calc.pdf', pageCount: 769, labels: Array.from({ length: 769 }, (_, i) => i < 7 ? null : String(i - 7)) },
    { id: 'sha256:' + 'b'.repeat(64), title: '', fileName: 'algebra.pdf', pageCount: 300 },
  ]
  it('sends book titles and page counts, not ids', () => {
    const library = modelLibrary({ books: shelf, open: null, pending: null, highlights: [], panelPageIndex: null })!
    expect(library.books).toEqual([{ title: 'Calculus Volume 1', pages: 769 }, { title: 'algebra.pdf', pages: 300 }])
    expect(JSON.stringify(library)).not.toContain('sha256')
    expect(contextSchema.parse(baseContext({ library: library as BoardContext['library'] })).library?.books).toEqual(library.books)
    expect(modelLibrary({ books: [], open: null, pending: null, highlights: [], panelPageIndex: null })).toBeUndefined()
  })
  it('tells the model which page the reference panel shows', () => {
    const open = shelf[0]
    const library = modelLibrary({ books: shelf, open, pending: null, highlights: [], panelPageIndex: 241 })!
    expect(library.panelPage).toEqual({ label: '234', pageIndex: 241 })
    expect(modelLibrary({ books: shelf, open, pending: null, highlights: [], panelPageIndex: 3 })!.panelPage).toEqual({ label: null, pageIndex: 3 })
    expect(modelLibrary({ books: shelf, open, pending: null, highlights: [], panelPageIndex: 5000 })!.panelPage).toBeUndefined()
    expect(modelLibrary({ books: shelf, open: null, pending: null, highlights: [], panelPageIndex: 241 })!.panelPage).toBeUndefined()
    expect(library.openBook).toEqual({ title: 'Calculus Volume 1' })
    expect(JSON.stringify(library)).not.toContain('sha256')
    const parsed = contextSchema.parse(baseContext({ library: library as BoardContext['library'] }))
    expect(parsed.library?.panelPage).toEqual({ label: '234', pageIndex: 241 })
    expect(parsed.library?.openBook).toEqual({ title: 'Calculus Volume 1' })
  })
})

describe('a typed reply and the view', () => {
  it('stays valid when only the pointer, a gesture or the view moved, and not when the board changed', () => {
    const editor = new Editor()
    const controller = createBoardController(editor, () => baseContext())
    const [id] = controller.applyOperations([{ type: 'create_math', latex: 'x^2', bounds: { x: 100, y: 100, w: 200, h: 80 } }]).ids
    const context = (extra: Partial<BoardContext> = {}) => ({ ...baseContext(), objects: controller.getObjects(), selectedIds: editor.getSelectedShapeIds() as string[], ...extra })
    const key = (c: BoardContext) => contextFingerprint(boardOnly(c))
    const before = key(context({ pointer: { x: 400, y: 300 } }))
    expect(key(context({ pointer: { x: 401, y: 300 } }))).toBe(before)
    expect(key(context({ pointer: { x: 400, y: 300 }, viewport: { x: 0, y: 40, w: 1200, h: 800 } }))).toBe(before)
    expect(key(context({ pointer: null, gesture: { active: true, bounds: { x: 0, y: 0, w: 5, h: 5 }, start: { x: 0, y: 0 }, current: { x: 5, y: 5 } } }))).toBe(before)
    expect(key(context({ selectedIds: [] }))).not.toBe(before)
    expect(controller.applyOperations([{ type: 'transform_object', target: id, dx: 30 }]).ok).toBe(true)
    expect(key(context({ pointer: { x: 400, y: 300 } }))).not.toBe(before)
  })
})

describe('new content comes into view', () => {
  it('glides to a typed equation placed below the view while the teacher reads a textbook page up close', async () => {
    const editor = new Editor()
    editor.setViewportScreenBounds({ x: 0, y: 56, w: 1440, h: 844 })
    let options: PlacementOption[] | undefined
    const context = (): BoardContext => { const vp = editor.getViewportPageBounds(); return baseContext({ pointer: null, viewport: { x: vp.x, y: vp.y, w: vp.w, h: vp.h }, ...(options ? { placementOptions: options } : {}) }) }
    const controller = createBoardController(editor, context)
    controller.applyOperations([pageOp(30, '23', { x: 0, y: 0, w: 700, h: 906 })])
    editor.setCamera({ x: -(350 - 1440 / 1.6 / 2), y: -(300 - 844 / 1.6 / 2), z: 1.6 })
    const vp = editor.getViewportPageBounds(), text = 'write the derivative of x^2'
    const spots = freeSpots({ viewport: { x: vp.x, y: vp.y, w: vp.w, h: vp.h }, zoom: 1.6, objects: controller.getObjects(), size: guessContentSize(text), workBelow: 0 })
    options = await placementOptionsFor(context(), spots.map(s => ({ id: s.id, bounds: s.bounds, description: s.description, features: s.features })), text, async request => localRank(request))
    const before = editor.getCurrentPageShapeIds()
    const result = controller.applyOperations([{ type: 'create_math', latex: '2x', placementOption: 'A' }])
    expect(result.ok, result.message).toBe(true)
    const added = addedBounds(editor, before, result.ids)!
    const a = editor.pageToScreen(added), c = editor.pageToScreen({ x: added.x + added.w, y: added.y + added.h })
    const item = { left: a.x, top: a.y, right: c.x, bottom: c.y }
    // the stage below the 56 px header, less the tool rail, board options and footer, as in App.revealInserted
    const area = { left: 84, top: 112, right: 1424, bottom: 860 }
    const hidden = item.left < area.left || item.top < area.top || item.right > area.right || item.bottom > area.bottom
    expect(hidden).toBe(true)
    const shift = revealShift(item, area)!
    expect(shift).not.toBeNull()
    expect(item.left + shift.dx).toBeGreaterThanOrEqual(area.left)
    expect(item.right + shift.dx).toBeLessThanOrEqual(area.right)
    expect(item.top + shift.dy).toBeGreaterThanOrEqual(area.top)
    expect(item.bottom + shift.dy).toBeLessThanOrEqual(area.bottom)
  })
  it('reveals only what the command added, and nothing for an edit', () => {
    const { editor, controller } = setup()
    controller.applyOperations([{ type: 'create_math', latex: 'x', bounds: { x: 0, y: 0, w: 100, h: 50 } }])
    const before = editor.getCurrentPageShapeIds()
    const edit = controller.applyOperations([{ type: 'update_object', target: 'last', color: '#dc2626' }])
    expect(addedBounds(editor, before, edit.ids)).toBeNull()
    const both = controller.applyOperations([{ type: 'create_text', text: 'a', bounds: { x: 500, y: 600, w: 200, h: 60 } }, { type: 'create_text', text: 'b', bounds: { x: 900, y: 700, w: 100, h: 60 } }])
    expect(addedBounds(editor, before, both.ids)).toMatchObject({ x: 500, y: 600, w: 500 })
  })
})

describe('A4 page mode placement', () => {
  const inside = (b: Bounds) => onSheet(b, PAGE_BOUNDS)
  function sheetBoard(stageW: number, stageH: number, background: boolean) {
    const editor = new Editor()
    editor.setViewportScreenBounds({ x: 0, y: 56, w: stageW, h: stageH })
    // App.changeMode('page'): the A4 page fitted in view
    editor.zoomToBounds({ x: -100, y: -70, w: 994, h: 1313 })
    if (background) editor.run(() => {
      editor.createAssets([{ id: 'asset:bg', typeName: 'asset', type: 'image', meta: {}, props: { name: 'hw', src: PNG, w: 1, h: 1, mimeType: 'image/png', isAnimated: false } }])
      editor.createShape({ id: 'shape:bg', type: 'image', x: 0, y: 0, isLocked: true, props: { assetId: 'asset:bg', w: 794, h: 1123 }, meta: { marginaliaBackground: true } })
    }, { ignoreShapeLock: true })
    const controller = createBoardController(editor, () => baseContext())
    const vp = editor.getViewportPageBounds()
    const spots = (size: { w: number; h: number }, workBelow = 0) => freeSpots({
      viewport: { x: vp.x, y: vp.y, w: vp.w, h: vp.h }, zoom: editor.getZoomLevel(), objects: controller.getObjects(), size, workBelow,
      sheet: PAGE_BOUNDS, isBackground: id => editor.getShape(id as TLShape['id'])?.meta.marginaliaBackground === true,
    })
    return { editor, controller, spots }
  }
  it('puts typed content and library items on the sheet, over a homework background', () => {
    for (const [w, h] of [[1440, 844], [1180, 764]]) for (const background of [true, false]) {
      const { spots } = sheetBoard(w, h, background)
      for (const text of ['write the quadratic formula', 'plot y = x^2']) {
        const found = spots(guessContentSize(text))
        expect(found.length, `${w} ${background} ${text}`).toBeGreaterThan(0)
        for (const spot of found) expect(inside(spot.bounds), JSON.stringify(spot.bounds)).toBe(true)
      }
      const item = libraryImageSize({ w: 1400, h: 420 }, 'item')
      const top = spots(item, item.workBelow)[0]
      expect(top && inside(top.bounds)).toBe(true)
    }
  })
  it('keeps clear of writing on the sheet, but not of the background itself', () => {
    const { controller, spots } = sheetBoard(1440, 844, true)
    controller.applyOperations([{ type: 'create_text', text: 'name', bounds: { x: 40, y: 40, w: 700, h: 300 } }])
    const found = spots(guessContentSize('write the quadratic formula'))
    expect(found.length).toBeGreaterThan(0)
    for (const spot of found) expect(inside(spot.bounds) && !overlapping(spot.bounds, { x: 40, y: 40, w: 700, h: 300 })).toBe(true)
  })
  it('uses the whole sheet when none of it is in view, and nothing when it is full', () => {
    const size = guessContentSize('plot y = x^2')
    const far = freeSpots({ viewport: { x: 5000, y: 5000, w: 1440, h: 844 }, zoom: 1, objects: [], size, workBelow: 0, sheet: PAGE_BOUNDS })
    expect(far.length).toBeGreaterThan(0)
    for (const spot of far) expect(inside(spot.bounds)).toBe(true)
    const full: BoardObject[] = [{ id: 'shape:full', kind: 'text', bounds: { ...PAGE_BOUNDS }, rotation: 0 }]
    expect(freeSpots({ viewport: { x: -100, y: -70, w: 994, h: 1313 }, zoom: .6, objects: full, size, workBelow: 0, sheet: PAGE_BOUNDS })).toEqual([])
  })
  it('leaves the infinite canvas as it was', () => {
    const size = guessContentSize('plot y = x^2'), viewport = { x: 0, y: 0, w: 1440, h: 844 }
    const objects: BoardObject[] = [{ id: 'shape:bg', kind: 'image', bounds: { x: 0, y: 0, w: 794, h: 1123 }, rotation: 0 }]
    expect(freeSpots({ viewport, zoom: 1, objects, size, workBelow: 0, isBackground: () => true })).toEqual(findSpots({ viewport, obstacles: [{ x: 0, y: 0, w: 794, h: 1123, label: 'image' }], size, workBelow: 0, max: 12, near: null, avoid: [], insets: { left: 84, top: 56, right: 16, bottom: 40 } }))
  })
})

describe('pairing, allowance and voice turns', () => {
  it('recognizes a lapsed pairing from typing, voice and image errors', () => {
    expect(isPairingError(new ApiRequestError('Pair this device using the six-digit code shown on the laptop.', 401, 'pairing_required'))).toBe(true)
    expect(isPairingError(new ApiRequestError('Unauthorized', 401))).toBe(true)
    expect(isPairingError('Pair this device using the six-digit code shown on the laptop.')).toBe(true)
    expect(isPairingError('Pair this device using the six-digit code shown on the laptop. Check this existing request before confirming another image; no automatic generation retry was sent.')).toBe(true)
    for (const other of [new ApiRequestError('The configured command allowance has been reached.', 429, 'local_command_limit'), new Error('fetch failed'), 'Voice could not reconnect.', null, undefined]) expect(isPairingError(other)).toBe(false)
  })
  it('counts the typed commands left and warns from 90 percent', () => {
    expect(commandAllowance({ limits: { commandLimit: 200 }, usage: { commands: 179 } })).toEqual({ used: 179, limit: 200, left: 21, low: false })
    expect(commandAllowance({ limits: { commandLimit: 200 }, usage: { commands: 180 } })).toMatchObject({ left: 20, low: true })
    expect(commandAllowance({ limits: { commandLimit: 200 }, usage: { commands: 250 } })).toMatchObject({ left: 0, low: true })
    // an unpaired iPad gets no usage, so nothing is shown
    expect(commandAllowance({ limits: { commandLimit: 200 } })).toBeNull()
    expect(commandAllowance(null)).toBeNull()
  })
  it('finds the start of each utterance from the microphone level, once per sentence', () => {
    const start = createSpeechStart()
    let t = 0, starts = 0
    const feed = (level: number, ms: number) => { for (const end = t + ms; t < end; t += 50) if (start(level, t)) starts++ }
    // ten minutes of pen work in a quiet room: no speech, so no ranking at all
    feed(.01, 600_000)
    expect(starts).toBe(0)
    // three sentences; a short breath inside one of them is still the same sentence
    feed(.4, 1500); feed(.01, 2000); feed(.3, 800); feed(.02, 300); feed(.3, 900); feed(.01, 3000); feed(.5, 1200); feed(0, 1000)
    expect(starts).toBe(3)
  })
})

describe('where the inspector opens', () => {
  it('measures it from an element with the inspector\'s own position rules', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(',').map(s => s.trim()), body: m[2] }))
    const geometry = rules.filter(r => r.selectors.includes('.object-inspector') && /(^|;)\s*(top|right|width|max-height)\s*:/.test(r.body))
    expect(geometry.length).toBeGreaterThanOrEqual(4)
    for (const rule of geometry) expect(rule.selectors, rule.body).toContain('.inspector-zone')
    const zone = rules.find(r => r.selectors.length === 1 && r.selectors[0] === '.inspector-zone')!
    expect(zone.body).toMatch(/visibility:hidden/)
    expect(zone.body).toMatch(/pointer-events:none/)
  })
})
