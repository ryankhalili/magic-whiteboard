import { describe, expect, it } from 'vitest'
import { Editor, type TLDrawShape } from '../src/canvas/editor'
import { CanvasInteractions, framePoint, resizeFrame, selectionFrame, type CanvasPointer } from '../src/canvas/interactions'
import { inkOutlinePath } from '../src/canvas/ink'
import { legacyText, shapeOpacity } from '../src/canvas/content'

const p = (x: number, y: number, extra: Partial<CanvasPointer> = {}): CanvasPointer => ({ id: 1, x, y, pointerType: 'mouse', button: 0, ...extra })
function setup() { const editor = new Editor(); editor.setViewportScreenBounds({ x: 0, y: 0, w: 1000, h: 700 }); return { editor, input: new CanvasInteractions(editor) } }
function plot(editor: Editor, id = 'shape:plot', extra = {}) { editor.createShape({ id, type: 'magic', x: 100, y: 100, props: { w: 200, h: 100 }, ...extra }); editor.markHistoryStoppingPoint('Plot created'); return id }

describe('application-owned canvas input', () => {
  it('records pen pressure, normalizes negative local points, and undoes the entire stroke once', () => {
    const { editor, input } = setup()
    editor.setCurrentTool('draw')
    input.pointerDown(p(100, 100, { pointerType: 'pen', pressure: .25 }))
    input.pointerMove(p(80, 120, { pointerType: 'pen', pressure: .8 }))
    input.pointerMove(p(50, 90, { pointerType: 'pen', pressure: .7 }))
    input.pointerUp(p(50, 90, { pointerType: 'pen', pressure: 0 }))
    const shape = editor.getCurrentPageShapes()[0] as TLDrawShape
    expect(shape.x).toBe(50); expect(shape.y).toBe(90)
    expect(shape.props.points).toHaveLength(3)
    expect(shape.props.points[1].pressure).toBe(.8)
    expect(shape.props.points.every(point => point.x >= 0 && point.y >= 0)).toBe(true)
    editor.undo(); expect(editor.getCurrentPageShapes()).toHaveLength(0)
    editor.redo(); expect(editor.getCurrentPageShapes()).toHaveLength(1)
  })
  it('keeps a single tap as visible ink and cancellation leaves no mark', () => {
    const { editor, input } = setup(); editor.setCurrentTool('draw')
    input.pointerDown(p(10, 10)); input.pointerUp(p(10, 10))
    expect(inkOutlinePath((editor.getCurrentPageShapes()[0] as TLDrawShape).props.points, 3.5)).toContain('a')
    input.pointerDown(p(20, 20)); input.pointerMove(p(40, 40)); input.cancel()
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
  })
  it('commits an in-flight stroke before a voice edit, so later cancellation cannot undo the command', () => {
    const { editor, input } = setup(); editor.setInteractionCompleter(() => input.complete()); editor.setCurrentTool('draw')
    input.pointerDown(p(100, 100)); input.pointerMove(p(50, 120))
    editor.completeInteraction()
    const ink = editor.getCurrentPageShapes()[0]
    expect(ink).toMatchObject({ x: 50, y: 100 })
    plot(editor, 'shape:voice-result')
    input.pointerMove(p(300, 300)); input.cancel()
    expect(editor.getShape('shape:voice-result')).toBeDefined()
    expect(editor.getShape(ink.id)).toEqual(ink)
    editor.undo(); expect(editor.getShape('shape:voice-result')).toBeUndefined(); expect(editor.getShape(ink.id)).toBeDefined()
    editor.undo(); expect(editor.getShape(ink.id)).toBeUndefined()
  })
  it('prevents late drag samples from overwriting a following voice transform or undo', () => {
    const { editor, input } = setup(); const id = plot(editor); editor.setInteractionCompleter(() => input.complete())
    input.pointerDown(p(150, 150)); input.pointerMove(p(180, 180))
    editor.completeInteraction(); editor.markHistoryStoppingPoint('Voice move')
    editor.updateShape({ id, type: 'magic', x: 500, y: 300 }); editor.markHistoryStoppingPoint('After voice move')
    input.pointerMove(p(250, 250)); input.pointerUp(p(250, 250)); input.cancel()
    expect(editor.getShape(id)).toMatchObject({ x: 500, y: 300 })
    editor.undo(); expect(editor.getShape(id)).toMatchObject({ x: 130, y: 130 })
    editor.undo(); expect(editor.getShape(id)).toMatchObject({ x: 100, y: 100 })
  })
  it('moves a selected object in page coordinates at non-unit zoom, with one undo step', () => {
    const { editor, input } = setup(); const id = plot(editor)
    editor.setCamera({ x: 20, y: -10, z: 2 })
    input.pointerDown(p(300, 220)); input.pointerMove(p(360, 260)); input.pointerMove(p(380, 280)); input.pointerUp(p(380, 280))
    expect(editor.getShape(id)).toMatchObject({ x: 140, y: 130 })
    editor.undo(); expect(editor.getShape(id)).toMatchObject({ x: 100, y: 100 })
    editor.undo(); expect(editor.getShape(id)).toBeUndefined()
  })
  it('shift toggles selection and a marquee excludes locked homework images', () => {
    const { editor, input } = setup(); const id = plot(editor)
    editor.createShape({ id: 'shape:background', type: 'image', x: 400, y: 100, isLocked: true, props: { w: 100, h: 100 } })
    input.pointerDown(p(120, 120)); input.pointerUp(p(120, 120)); expect(editor.getSelectedShapeIds()).toEqual([id])
    input.pointerDown(p(120, 120, { shift: true })); input.pointerUp(p(120, 120)); expect(editor.getSelectedShapeIds()).toEqual([])
    input.pointerDown(p(50, 50)); input.pointerMove(p(600, 300)); input.pointerUp(p(600, 300))
    expect(editor.getSelectedShapeIds()).toEqual([id])
  })
  it('a click in empty space inside a curved stroke’s bounding box does not select the stroke', () => {
    const { editor, input } = setup()
    editor.createShape({ id: 'shape:ink', type: 'draw', x: 100, y: 100, props: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], color: 'black', size: 'm' } })
    input.pointerDown(p(130, 170)); input.pointerUp(p(130, 170))
    expect(editor.getSelectedShapeIds()).toEqual([])
  })
  it('eraser removes intersected unlocked content and protects the background', () => {
    const { editor, input } = setup(); const id = plot(editor)
    editor.createShape({ id: 'shape:background', type: 'image', x: 0, y: 0, isLocked: true, props: { w: 700, h: 600 } })
    editor.markHistoryStoppingPoint('Before erasing'); editor.setCurrentTool('eraser')
    input.pointerDown(p(50, 150)); input.pointerMove(p(350, 150)); input.pointerUp(p(350, 150))
    expect(editor.getShape(id)).toBeUndefined(); expect(editor.getShape('shape:background')).toBeDefined()
    editor.undo(); expect(editor.getShape(id)).toBeDefined()
  })
  it('resizes a rotated object while keeping its opposite corner fixed', () => {
    const { editor, input } = setup(); const id = plot(editor, 'shape:rotated', { rotation: Math.PI / 2 })
    editor.select(id)
    const frame = selectionFrame(editor)!, start = framePoint(frame, { x: frame.w, y: frame.h }), end = framePoint(frame, { x: 300, y: 150 })
    input.pointerDown(p(start.x, start.y, { handle: 'se' })); input.pointerMove(p(end.x, end.y)); input.pointerUp(p(end.x, end.y))
    expect(editor.getShape(id)).toMatchObject({ x: 100, y: 100, rotation: Math.PI / 2, props: { w: 300, h: 150 } })
  })
  it('rotates around the selection center and Shift snaps in fifteen-degree steps', () => {
    const { editor, input } = setup(); const id = plot(editor); editor.select(id)
    input.pointerDown(p(200, 50, { handle: 'rotate' })); input.pointerMove(p(300, 150, { shift: true })); input.pointerUp(p(300, 150, { shift: true }))
    const shape = editor.getShape(id)!
    expect(shape.rotation).toBeCloseTo(Math.PI / 2)
    const center = editor.getShapePageTransform(shape).applyToPoint({ x: 100, y: 50 })
    expect(center.x).toBeCloseTo(200); expect(center.y).toBeCloseTo(150)
    editor.undo(); expect(editor.getShape(id)?.rotation).toBe(0)
  })
  it('cancels the first finger stroke when a second finger starts zooming', () => {
    const { editor, input } = setup(); editor.setCurrentTool('draw')
    input.pointerDown(p(100, 100, { pointerType: 'touch' })); input.pointerMove(p(110, 100, { pointerType: 'touch' }))
    input.pointerDown(p(210, 100, { id: 2, pointerType: 'touch' }))
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    input.pointerMove(p(310, 100, { id: 2, pointerType: 'touch' }))
    expect(editor.getZoomLevel()).toBeCloseTo(2)
    input.pointerUp(p(310, 100, { id: 2, pointerType: 'touch' })); input.pointerUp(p(110, 100, { pointerType: 'touch' }))
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })
  it('ignores palm touches during pen input and prioritizes a pen over an accidental finger stroke', () => {
    const { editor, input } = setup(); editor.setCurrentTool('draw')
    input.pointerDown(p(50, 50, { pointerType: 'touch' }))
    input.pointerDown(p(100, 100, { id: 2, pointerType: 'pen' }))
    expect(input.pointerDown(p(300, 300, { id: 3, pointerType: 'touch' }))).toBe(false)
    input.pointerMove(p(200, 100, { id: 2, pointerType: 'pen' })); input.pointerUp(p(200, 100, { id: 2, pointerType: 'pen' }))
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(editor.getZoomLevel()).toBe(1)
  })
  it('keeps the same page point under the pointer while wheel zooming', () => {
    const { editor, input } = setup(); editor.setViewportScreenBounds({ x: 30, y: 70, w: 1000, h: 700 }); editor.setCamera({ x: 25, y: -45, z: 1.3 })
    const screen = { x: 470, y: 340 }, before = editor.screenToPage(screen)
    input.wheel({ ...screen, deltaX: 0, deltaY: -80, zoom: true })
    const after = editor.screenToPage(screen)
    expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y)
    expect(editor.getZoomLevel()).toBeGreaterThan(1.3)
  })
  it('pans without editing content or consuming a document undo step', () => {
    const { editor, input } = setup(); const id = plot(editor); editor.setCurrentTool('hand')
    input.pointerDown(p(100, 100)); input.pointerMove(p(150, 140)); input.pointerUp(p(150, 140))
    expect(editor.getCamera()).toMatchObject({ x: 50, y: 40 })
    expect(editor.getShape(id)).toMatchObject({ x: 100, y: 100 })
    editor.undo(); expect(editor.getShape(id)).toBeUndefined()
  })
  it('double-click edits compatible content but never a locked object', () => {
    const { editor, input } = setup(); const id = plot(editor)
    input.doubleClick({ x: 150, y: 150 }); expect(editor.getEditingShapeId()).toBe(id)
    editor.setEditingShape(null); editor.updateShape({ id, type: 'magic', isLocked: true })
    input.doubleClick({ x: 150, y: 150 }); expect(editor.getEditingShapeId()).toBeNull()
  })
})

describe('canvas geometry and pressure rendering', () => {
  it('preserves legacy rich text paragraphs and inherited group opacity', () => {
    expect(legacyText({ richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ text: 'Hello' }, { type: 'hardBreak' }, { text: 'world' }] }, { type: 'paragraph', content: [{ text: 'Again' }] }] } })).toBe('Hello\nworld\nAgain')
    const { editor } = setup()
    editor.createShape({ id: 'shape:group', type: 'group', opacity: .4 })
    editor.createShape({ id: 'shape:text', type: 'text', parentId: 'shape:group', opacity: .5, props: { text: 'Hello' } })
    expect(shapeOpacity(editor, editor.getShape('shape:text')!)).toBeCloseTo(.2)
  })
  it('clamps resize handles before inversion and Shift preserves the aspect ratio', () => {
    const frame = { x: 0, y: 0, w: 200, h: 100, rotation: 0 }
    expect(resizeFrame(frame, 'nw', { x: 250, y: 140 })).toEqual({ x: 188, y: 88, w: 12, h: 12 })
    const rect = resizeFrame(frame, 'se', { x: 260, y: 180 }, true)
    expect(rect.w / rect.h).toBe(2)
  })
  it('produces bounded finite SVG paths with pressure variation, including a tap', () => {
    const points = [{ x: 0, y: 0, pressure: .1 }, { x: 20, y: 10, pressure: .9 }, { x: 40, y: 0, pressure: .2 }]
    const outline = inkOutlinePath(points, 4)
    expect(outline).toMatch(/^M.*Z$/)
    expect(outline).not.toMatch(/NaN|Infinity|undefined/)
    expect(outline).not.toBe(inkOutlinePath(points.map(point => ({ ...point, pressure: .5 })), 4))
    expect(inkOutlinePath([], 4)).toBe('')
    expect(inkOutlinePath([points[0]], 4)).toMatch(/^M.*Z$/)
  })
})
