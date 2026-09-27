import { describe, expect, it } from 'vitest'
import { Editor, type TLShapeId } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { editorToExcalidrawScene, eraserProtectedIds, sceneToEditorChanges } from '../src/canvas/excalidrawScene'
import { CanvasInteractions } from '../src/canvas/interactions'
import type { BoardContext, BoardOperation, Bounds } from '../shared/board'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const context: BoardContext = { focus: null, focusMode: 'reference', pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [] }

function pageOp(label: string, bounds: Bounds = { x: 0, y: 0, w: 700, h: 906 }): BoardOperation {
  return { type: 'create_image', image: { src: PNG, w: 1800, h: 2330, mimeType: 'image/png', name: `Calc, page ${label}` }, bounds, locked: true,
    meta: { assetKey: `page-${label}`, library: { bookId: 'b', title: 'Calc', pageIndex: 30, pageLabel: label, kind: 'page' } } }
}
function cropOp(bounds: Bounds): BoardOperation {
  return { type: 'create_image', image: { src: PNG, w: 1200, h: 400, mimeType: 'image/png', name: 'Example 3.12' }, bounds, locked: false,
    meta: { assetKey: 'crop', library: { bookId: 'b', title: 'Calc', pageIndex: 30, pageLabel: '23', kind: 'crop' } } }
}
function board() {
  const editor = new Editor()
  const controller = createBoardController(editor, () => ({ ...context, selectedIds: editor.getSelectedShapeIds() }))
  return { editor, controller }
}
const order = (editor: Editor) => editor.getCurrentPageShapesSorted().map(shape => shape.id)
const ink = (editor: Editor, id: string, x: number, y: number) => editor.createShape({ id: `shape:${id}` as TLShapeId, type: 'draw', props: { points: [{ x, y }, { x: x + 80, y: y + 10 }], color: 'blue', size: 'm' } })

describe('board results', () => {
  it('carry a short answer, never the whole board', () => {
    const { editor, controller } = board()
    for (let i = 0; i < 50; i++) ink(editor, `ink${i}`, i * 10, 0)
    const created = controller.applyOperations([{ type: 'create_math', latex: 'x^2' }])
    expect(created).toEqual({ ok: true, message: 'Whiteboard updated.', ids: [expect.any(String)] })
    expect(controller.applyOperations([{ type: 'undo' }])).toEqual({ ok: true, message: 'Undone.', ids: [] })
    expect(JSON.stringify(controller.applyOperations([{ type: 'redo' }])).length).toBeLessThan(100)
  })
})

describe('a textbook page and an edit in one request', () => {
  it('inserts the page and applies the scale, move or layer in the same batch', () => {
    const { editor, controller } = board()
    ink(editor, 'work', 900, 100)
    const result = controller.applyOperations([pageOp('23'), { type: 'transform_object', target: 'last', scale: .8 }, { type: 'transform_object', dx: -40 }])
    expect(result.ok).toBe(true)
    const page = editor.getShape(result.ids[0] as TLShapeId)!
    expect(page).toMatchObject({ type: 'image', isLocked: true, props: { w: 560 } })
    expect(page.props.h).toBeCloseTo(906 * .8)
    expect(page.x).toBeCloseTo(70 - 40)
    // still paper: not selected and under the ink
    expect(editor.getSelectedShapeIds()).toEqual([])
    expect(order(editor)).toEqual([page.id, 'shape:work'])
    // a front layer request never raises a locked page above content
    const front = controller.applyOperations([pageOp('24', { x: 0, y: 1000, w: 700, h: 906 }), { type: 'update_object', target: 'last', layer: 'front' }])
    expect(front.ok).toBe(true)
    expect(order(editor).at(-1)).toBe('shape:work')
    // the lock still protects pages inserted earlier
    expect(controller.applyOperations([{ type: 'transform_object', target: page.id, dx: 10 }])).toMatchObject({ ok: false, message: 'That object is locked. Unlock it before changing it.' })
  })
})

describe('removing a textbook page', () => {
  it('works by command and from the inspector, but other locked objects stay protected', () => {
    const { editor, controller } = board()
    const [page] = controller.applyOperations([pageOp('23')]).ids
    ink(editor, 'work', 100, 100)
    editor.run(() => editor.createShape({ id: 'shape:bg', type: 'geo', isLocked: true, props: { w: 100, h: 100 } }), { ignoreShapeLock: true })
    expect(controller.applyOperations([{ type: 'delete_objects', ids: ['shape:bg'] }])).toMatchObject({ ok: false, message: 'That object is locked. Unlock it before changing it.' })
    expect(controller.applyOperations([{ type: 'delete_objects', ids: [page] }]).ok).toBe(true)
    expect(editor.getShape(page as TLShapeId)).toBeUndefined()
    expect(editor.getShape('shape:bg')).toBeDefined()
    expect(editor.getShape('shape:work')).toBeDefined()
    editor.undo()
    expect(editor.getShape(page as TLShapeId)).toMatchObject({ isLocked: true })
  })
})

describe('layers keep textbook pages at the back', () => {
  it('sends content back behind other content but in front of the pages', () => {
    const { editor, controller } = board()
    ink(editor, 'first', 100, 100)
    const pages = controller.applyOperations([pageOp('23'), pageOp('24', { x: 0, y: 1000, w: 700, h: 906 })]).ids
    const math = controller.applyOperations([{ type: 'create_math', latex: 'x' }]).ids[0]
    expect(controller.applyOperations([{ type: 'update_object', target: math, layer: 'back' }]).ok).toBe(true)
    expect(order(editor)).toEqual([...pages, math, 'shape:first'])
  })

  it('keeps native send to back above locked pages too', () => {
    const { editor, controller } = board()
    ink(editor, 'first', 100, 100)
    const pages = controller.applyOperations([pageOp('23'), pageOp('24', { x: 0, y: 1000, w: 700, h: 906 })]).ids
    ink(editor, 'second', 100, 300)
    expect(order(editor)).toEqual([...pages, 'shape:first', 'shape:second'])
    // Excalidraw's own send to back puts the stroke first in its element list
    const elements = editorToExcalidrawScene(editor).elements
    const moved = [elements.find(element => element.id === 'shape:first')!, ...elements.filter(element => element.id !== 'shape:first')]
    const changes = sceneToEditorChanges(editor, moved)
    editor.run(() => editor.updateShapes(changes.updates))
    expect(order(editor)).toEqual([...pages, 'shape:first', 'shape:second'])
  })
})

describe('the eraser', () => {
  it('never removes textbook crops or pages it passes over', () => {
    const { editor, controller } = board()
    const [crop] = controller.applyOperations([cropOp({ x: 0, y: 0, w: 600, h: 200 })]).ids
    const [page] = controller.applyOperations([pageOp('23', { x: 0, y: 400, w: 700, h: 906 })]).ids
    ink(editor, 'underline', 20, 100)
    expect(eraserProtectedIds(editor, ['shape:underline', crop, page])).toEqual([crop, page])
    // what Excalidraw reports after one eraser swipe over the underline
    const scene = editorToExcalidrawScene(editor).elements.filter(element => element.id !== 'shape:underline' && element.id !== crop)
    const changes = sceneToEditorChanges(editor, scene)
    expect(changes.deletes.sort()).toEqual([crop, 'shape:underline'].sort())
    const kept = new Set(eraserProtectedIds(editor, changes.deletes))
    editor.run(() => editor.deleteShapes(changes.deletes.filter(id => !kept.has(id)) as TLShapeId[]))
    expect(editor.getShape('shape:underline')).toBeUndefined()
    expect(editor.getShape(crop as TLShapeId)).toBeDefined()
    // the scene pushed back to Excalidraw has the crop again
    expect(editorToExcalidrawScene(editor, scene).elements.map(element => element.id)).toContain(crop)
  })

  it('also spares them on the built in canvas', () => {
    const { editor, controller } = board()
    const [crop] = controller.applyOperations([cropOp({ x: 0, y: 0, w: 600, h: 200 })]).ids
    ink(editor, 'mark', 280, 100)
    editor.selectNone()
    const canvas = new CanvasInteractions(editor)
    editor.setCurrentTool('eraser')
    canvas.pointerDown({ id: 1, x: 250, y: 60, pointerType: 'mouse', button: 0 })
    canvas.pointerMove({ id: 1, x: 350, y: 140, pointerType: 'mouse', button: 0 })
    canvas.pointerUp({ id: 1, x: 350, y: 140, pointerType: 'mouse', button: 0 })
    expect(editor.getShape('shape:mark')).toBeUndefined()
    expect(editor.getShape(crop as TLShapeId)).toBeDefined()
  })
})
