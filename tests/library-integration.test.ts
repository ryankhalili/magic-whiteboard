import { describe, expect, it, vi } from 'vitest'
import { Editor, type AssetRecord, type TLShape } from '../src/canvas/editor'
import { normalizeSnapshot } from '../src/canvas/migration'
import { createBoardController, focusImageBounds, getPlacementBounds, libraryAssetId, libraryImageSize, libraryQueryFromOperation, spotForOption } from '../src/board/controller'
import { objectLabel } from '../src/board/ObjectInspector'
import { findSpots, NATURAL_SIZES } from '../src/board/placementSpots'
import { detectLibraryIntent } from '../src/library/intent'
import { BOARD_INSTRUCTIONS, boardTools, commandSchema, compactContext, contextInstructions, contextSchema, placementOptionsFor, requestSchema, withPlacementOptions, type CommandRequest } from '../server/board-tools'
import { runBoardCommand, type BoardModelResponse, type CommandRecoveryOptions } from '../server/command-repair'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'
import { readBoardCommand } from '../server/command-response'
import { localRank, type RankRequest, type RankResult } from '../shared/ranking'
import type { BoardContext, BoardOperation, PlacementOption } from '../shared/board'

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
    const objects = controller.getObjects()
    expect(objects.map(o => [o.kind, o.title])).toEqual([
      ['textbook_item', 'Example 3.2 (page 191)'],
      ['textbook_page', 'Calculus Volume 1, file page 30'],
      ['textbook_item', 'Part of page 23, Calculus Volume 1'],
    ])
    expect(objects.every(o => o.text === undefined)).toBe(true)
    expect(objects[1].locked).toBe(true)
    expect(objectLabel(objects[0])).toBe('Book excerpt: Example 3.2 (page 191)')
    expect(objectLabel(objects[1])).toBe('Book page: Calculus Volume 1, file page 30')
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
    expect(properties.action.enum).toEqual(['open_book', 'close_reference', 'store_import', 'board_import'])
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
