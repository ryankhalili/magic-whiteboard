import { describe, expect, it } from 'vitest'
import { Editor, Matrix2d, createShapeId, type TLShape } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import type { BoardContext } from '../shared/board'

function textShape(editor: Editor, id = createShapeId()) {
  editor.createShape({ id, type: 'magic', x: 10, y: 20, props: { kind: 'text', text: 'first', w: 100, h: 80 } })
  return id
}

describe('owned scene model', () => {
  it('applies one complete command in one undo step and restores the same IDs on redo', () => {
    const editor = new Editor()
    const context: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1000, h: 800 } }
    const controller = createBoardController(editor, () => ({ ...context, selectedIds: editor.getSelectedShapeIds() }))
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'sin(x)' }, { type: 'create_math', latex: 'x^2' }])
    expect(made.ok).toBe(true)
    expect(editor.getCurrentPageShapes()).toHaveLength(2)
    editor.undo(); expect(editor.getCurrentPageShapes()).toHaveLength(0)
    editor.redo(); expect(editor.getCurrentPageShapes().map(s => s.id)).toEqual(made.ids)
    expect(controller.applyOperations([{ type: 'update_object', target: made.ids[0], expression: 'x^2+3' }]).ok).toBe(true)
    editor.undo(); expect(editor.getShape<TLShape<'magic'>>(made.ids[0])!.props.expression).toBe('sin(x)')
    editor.redo(); expect(editor.getShape<TLShape<'magic'>>(made.ids[0])!.props.expression).toBe('x^2+3')
  })
  it('rolls back all mutations and preserves redo when a transaction throws', () => {
    const editor = new Editor(), id = textShape(editor)
    editor.markHistoryStoppingPoint('initial'); editor.undo()
    expect(() => editor.run(() => {
      textShape(editor, 'shape:partial')
      editor.createShape({ type: 'magic', x: Infinity })
    })).toThrow(/finite/)
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    editor.redo(); expect(editor.getShape(id)).toBeDefined()
  })
  it('squashes live pointer changes and cancels a gesture without adding an undo step', () => {
    const editor = new Editor(), id = textShape(editor)
    editor.markHistoryStoppingPoint('created')
    const mark = editor.markHistoryStoppingPoint('follow')
    editor.updateShape({ id, type: 'magic', x: 40 }); editor.markHistoryStoppingPoint('instruction')
    editor.updateShape({ id, type: 'magic', x: 80 }); editor.updateShape({ id, type: 'magic', x: 140 })
    editor.squashToMark(mark); editor.markHistoryStoppingPoint('placed')
    editor.undo(); expect(editor.getShape(id)!.x).toBe(10)
    editor.redo(); expect(editor.getShape(id)!.x).toBe(140)
    const cancelled = editor.markHistoryStoppingPoint('cancel')
    editor.updateShape({ id, type: 'magic', x: 999 }); editor.bailToMark(cancelled)
    expect(editor.getShape(id)!.x).toBe(140)
    editor.undo(); expect(editor.getShape(id)!.x).toBe(10)
  })
  it('finishes a native gesture before a voice edit without reentrant completion', () => {
    const editor = new Editor(), id = textShape(editor)
    editor.markHistoryStoppingPoint('created')
    editor.updateShape({ id, type: 'magic', x: 40 })
    let completions = 0
    editor.setInteractionCompleter(() => {
      completions++
      editor.completeInteraction()
      editor.markHistoryStoppingPoint('Finish drag')
    })
    editor.completeInteraction()
    editor.updateShape({ id, type: 'magic', props: { text: 'voice edit' } }); editor.markHistoryStoppingPoint('Voice command')
    expect(completions).toBe(1)
    editor.undo(); expect(editor.getShape<TLShape<'magic'>>(id)!.props.text).toBe('first'); expect(editor.getShape(id)!.x).toBe(40)
    editor.undo(); expect(editor.getShape(id)!.x).toBe(10)
    editor.setInteractionCompleter(null); editor.completeInteraction(); expect(completions).toBe(1)
  })
  it('separates document notifications from selection and camera changes', () => {
    const editor = new Editor(); let all = 0, documents = 0
    editor.subscribe(() => all++); editor.subscribe(() => documents++, 'document')
    editor.run(() => { textShape(editor); textShape(editor) })
    expect([all, documents]).toEqual([1, 1])
    editor.select(editor.getCurrentPageShapes()[0].id); editor.setCamera({ x: 40, y: 20, z: 2 })
    expect([all, documents]).toEqual([3, 1])
  })
  it('keeps pointer-history squashing correct after the bounded undo history fills', () => {
    const editor = new Editor(), id = textShape(editor)
    for (let x = 0; x < 120; x++) { editor.markHistoryStoppingPoint('before'); editor.updateShape({ id, type: 'magic', x }); editor.markHistoryStoppingPoint('after') }
    const mark = editor.markHistoryStoppingPoint('follow')
    editor.updateShape({ id, type: 'magic', x: 200 }); editor.markHistoryStoppingPoint('instruction')
    editor.updateShape({ id, type: 'magic', x: 300 }); editor.squashToMark(mark); editor.markHistoryStoppingPoint('placed')
    editor.undo(); expect(editor.getShape(id)!.x).toBe(119)
    editor.undo(); expect(editor.getShape(id)!.x).toBe(118)
    editor.redo(); editor.redo(); expect(editor.getShape(id)!.x).toBe(300)
  })
  it('preserves properties, metadata removal, snapshot isolation, and notebook identity', () => {
    const editor = new Editor(), id = textShape(editor)
    editor.updateShape({ id, type: 'magic', meta: { literalBounds: { x: 0, y: 0, w: 200, h: 200 }, axisMode: 'equal' } })
    editor.updateShape({ id, type: 'magic', props: { text: 'second' }, meta: { axisMode: 'equal' } })
    const shape = editor.getShape<TLShape<'magic'>>(id)!
    expect(shape.props.w).toBe(100); expect(shape.meta.literalBounds).toBeUndefined()
    editor.setCamera({ x: 120, y: -30, z: .8 }); editor.select(id)
    const saved = editor.getSnapshot()
    editor.updateShape({ id, type: 'magic', props: { text: 'third' } })
    const restored = new Editor(saved)
    expect(restored.getShape<TLShape<'magic'>>(id)!.props.text).toBe('second')
    expect(restored.getShape(id)!.meta).toEqual({ axisMode: 'equal' })
    expect(restored.getCamera()).toEqual({ x: 120, y: -30, z: .8 }); expect(restored.getSelectedShapeIds()).toEqual([id])
    expect(() => restored.loadSnapshot({ document: { store: { invalid: { id: 'invalid', typeName: 'shape', type: 'iframe' } } } })).toThrow()
    expect(restored.getShape(id)).toBeDefined()
  })
  it('enforces object and ancestor locks, with explicit background removal override', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:group', type: 'group', isLocked: true })
    editor.createShape({ id: 'shape:child', type: 'magic', parentId: 'shape:group', props: { kind: 'text' } })
    expect(editor.isShapeOrAncestorLocked('shape:child')).toBe(true)
    editor.updateShape({ id: 'shape:child', type: 'magic', x: 99 }); editor.deleteShapes(['shape:child'])
    expect(editor.getShape('shape:child')!.x).toBe(0)
    editor.updateShape({ id: 'shape:child', type: 'magic', isLocked: false, x: 99 })
    expect(editor.getShape('shape:child')!.x).toBe(0)
    editor.run(() => editor.deleteShapes(['shape:group']), { ignoreShapeLock: true })
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })
  it('does not remove a locked background through deletion of its unlocked group', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:group', type: 'group' })
    editor.createShape({ id: 'shape:background', type: 'magic', parentId: 'shape:group', isLocked: true })
    editor.deleteShapes(['shape:group'])
    expect(editor.getShape('shape:group')).toBeDefined(); expect(editor.getShape('shape:background')).toBeDefined()
  })
  it('keeps layout housekeeping out of the undo stack', () => {
    const editor = new Editor(), id = textShape(editor)
    editor.markHistoryStoppingPoint('created')
    editor.run(() => editor.updateShape({ id, type: 'magic', props: { w: 160 } }), { history: 'ignore' })
    editor.undo(); expect(editor.getShape(id)).toBeUndefined()
    editor.redo(); expect(editor.getShape<TLShape<'magic'>>(id)!.props.w).toBe(160)
  })
})

describe('owned coordinates and hit testing', () => {
  it('converts viewport, zoom, and page coordinates without drifting the zoom center', () => {
    const editor = new Editor()
    editor.setViewportScreenBounds({ x: 120, y: 64, w: 1000, h: 700 }); editor.setCamera({ x: -80, y: 20, z: 2 })
    expect(editor.pageToScreen({ x: 100, y: 200 })).toEqual({ x: 160, y: 504 })
    expect(editor.screenToPage({ x: 160, y: 504 })).toEqual({ x: 100, y: 200 })
    const center = editor.getViewportPageBounds().center
    editor.zoomIn(); expect(editor.getViewportPageBounds().center.x).toBeCloseTo(center.x); expect(editor.getViewportPageBounds().center.y).toBeCloseTo(center.y)
  })
  it('composes nested rotated groups and inverts parent transforms', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:group', type: 'group', x: 100, y: 200, rotation: Math.PI / 2 })
    editor.createShape({ id: 'shape:child', type: 'magic', parentId: 'shape:group', x: 20, y: 10, props: { w: 80, h: 40 } })
    const child = editor.getShape('shape:child')!
    const bounds = editor.getShapePageBounds(child)!
    expect(bounds.x).toBeCloseTo(50); expect(bounds.y).toBeCloseTo(220)
    expect(bounds.w).toBeCloseTo(40); expect(bounds.h).toBeCloseTo(80)
    const local = editor.getPointInParentSpace(child, { x: 90, y: 220 })
    expect(local.x).toBeCloseTo(20); expect(local.y).toBeCloseTo(10)
    expect(editor.getShapeAtPoint({ x: 70, y: 250 })?.id).toBe(child.id)
  })
  it('selects ink by stroke distance instead of the whole rectangular interior', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:ink', type: 'draw', props: { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], color: 'black', size: 'm' } })
    expect(editor.getShapeAtPoint({ x: 50, y: 53 }, { margin: 3 })?.id).toBe('shape:ink')
    expect(editor.getShapeAtPoint({ x: 90, y: 10 }, { margin: 3 })).toBeUndefined()
  })
  it('does not hit or erase the empty gap between independent legacy ink segments', () => {
    const editor = new Editor()
    const a = [{ x: 0, y: 0 }, { x: 20, y: 0 }], b = [{ x: 100, y: 0 }, { x: 120, y: 0 }]
    editor.createShape({ id: 'shape:ink', type: 'draw', props: { points: [...a, ...b], segments: [{ points: a }, { points: b }], color: 'black', size: 'm' } })
    expect(editor.getShapeAtPoint({ x: 10, y: 0 }, { margin: 3 })?.id).toBe('shape:ink')
    expect(editor.getShapeAtPoint({ x: 110, y: 0 }, { margin: 3 })?.id).toBe('shape:ink')
    expect(editor.getShapeAtPoint({ x: 60, y: 0 }, { margin: 8 })).toBeUndefined()
  })
  it('uses ordering for overlapping objects and returns true rotated bounds', () => {
    const editor = new Editor(), a = textShape(editor, 'shape:a'), b = textShape(editor, 'shape:b')
    expect(editor.getShapeAtPoint({ x: 30, y: 40 })?.id).toBe(b)
    editor.sendToBack([b]); expect(editor.getShapeAtPoint({ x: 30, y: 40 })?.id).toBe(a)
    editor.updateShape({ id: a, type: 'magic', x: 0, y: 0, rotation: Math.PI / 4, props: { w: 100, h: 100 } })
    expect(editor.getShapePageBounds(a)!.w).toBeCloseTo(Math.sqrt(2) * 100)
  })
  it('round-trips an affine transform', () => {
    const matrix = Matrix2d.From(31, -48, .73).multiply(Matrix2d.From(-12, 100, -.24)), point = { x: 29, y: -74 }
    const result = matrix.clone().invert().applyToPoint(matrix.applyToPoint(point))
    expect(result.x).toBeCloseTo(point.x); expect(result.y).toBeCloseTo(point.y)
  })
})
