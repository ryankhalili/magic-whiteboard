import { describe, expect, it } from 'vitest'
import type { Editor, TLShape } from '../src/canvas/editor'
import type { BoardContext } from '../shared/board'
import { autoYRange, samplePlot, validateDomain, validateExpression } from '../src/board/expression'
import { createBoardController, getPlacementBounds, resolveTargetIds } from '../src/board/controller'
import { getAxisMode, getPlotLayout } from '../src/board/plotLayout'
import { shapePageBounds } from '../src/board/spatial'

const baseContext = (): BoardContext => ({
  focus: null, pointer: { x: 500, y: 400 }, selectedIds: [], lastCreatedIds: [],
  viewport: { x: 0, y: 0, w: 1000, h: 800 }, objects: [],
})

describe('safe scalar math', () => {
  it('normalizes common notation and evaluates actual functions', () => {
    const equation = validateExpression('y = x² + 3')
    expect(equation.expression).toBe('x^2 + 3')
    expect(equation.evaluate(2)).toBe(7)
    expect(validateExpression('2x + sin(pi / 2)').evaluate(3)).toBeCloseTo(7)
    expect(validateExpression('log(x, 10)').evaluate(100)).toBeCloseTo(2)
  })
  it.each(['x = 42', 'import("fs")', 'evaluate("2+2")', '[1, 2]', 'x.constructor', 'random()', 'factorial(100000)', 'sum(1:1000)', 'constructor(1)', 'x; 4'])('rejects code-like or unbounded input %s', input => {
    expect(() => validateExpression(input)).toThrow()
  })
  it('rejects invalid domains and limits expression size', () => {
    expect(() => validateDomain(10, 0)).toThrow()
    expect(() => validateDomain(0, Infinity)).toThrow()
    expect(() => validateDomain(0, 1, 3, 2)).toThrow()
    expect(() => validateExpression('x+'.repeat(300))).toThrow()
  })
  it('supports two complete sine oscillations and a useful vertical range', () => {
    const sine = validateExpression('sin(x)'), [lo, hi] = autoYRange('sin(x)', 0, 4 * Math.PI)
    expect(sine.evaluate(Math.PI / 2)).toBeCloseTo(1)
    expect(sine.evaluate(5 * Math.PI / 2)).toBeCloseTo(1)
    expect(sine.evaluate(4 * Math.PI)).toBeCloseTo(0)
    expect(lo).toBeLessThan(-1)
    expect(hi).toBeGreaterThan(1)
    expect(samplePlot('sin(x)', 0, 4 * Math.PI, lo, hi, 400, 200)).toHaveLength(1)
  })
  it('breaks curves at an asymptote instead of joining opposite infinities', () => {
    expect(samplePlot('1/x', -2, 2, -5, 5, 400, 200).length).toBeGreaterThanOrEqual(2)
    expect(samplePlot('sqrt(x)', -2, 2, -1, 2, 400, 200).join('')).not.toContain('NaN')
  })
})

describe('spatial targeting', () => {
  it('uses selection then explicit focus then remembered object, never a random object', () => {
    const context = baseContext(); context.selectedIds = ['graph']; context.lastCreatedIds = ['text']
    expect(resolveTargetIds({ type: 'update_object' }, context, ['graph', 'text'])).toEqual(['graph'])
    expect(resolveTargetIds({ type: 'update_object', target: 'last' }, context, ['graph', 'text'])).toEqual(['text'])
    context.selectedIds = []; context.lastCreatedIds = []
    expect(() => resolveTargetIds({ type: 'update_object' }, context, ['graph'])).toThrow(/Select/)
    expect(() => resolveTargetIds({ type: 'update_object', target: 'missing' }, context, ['graph'])).toThrow(/no longer/)
  })
  it('uses regions as center references without inheriting a narrow aspect ratio', () => {
    const context = baseContext(); context.focus = { kind: 'region', targetIds: [], bounds: { x: 40, y: 60, w: 500, h: 280 } }
    expect(getPlacementBounds({ type: 'create_plot' }, context, 'plot')).toEqual({ x: 70, y: 40, w: 440, h: 320 })
    context.focus.bounds = { x: 100, y: 200, w: 40, h: 700 }
    expect(getPlacementBounds({ type: 'create_plot' }, context, 'plot')).toEqual({ x: -100, y: 390, w: 440, h: 320 })
    const b = getPlacementBounds({ type: 'create_plot', placement: 'pointer' }, context, 'plot')
    expect(b.x + b.w / 2).toBe(500)
    expect(b.y + b.h / 2).toBe(400)
  })
  it('respects explicit reference bounds and only fits a region when literal', () => {
    const context = baseContext(); context.focus = { kind: 'region', targetIds: [], bounds: { x: 40, y: 60, w: 500, h: 280 } }
    const bounds = { x: -900, y: -900, w: 300, h: 200 }
    expect(getPlacementBounds({ type: 'create_plot', bounds }, context, 'plot')).toEqual(bounds)
    context.focusMode = 'literal'
    expect(getPlacementBounds({ type: 'create_plot' }, context, 'plot')).toEqual(context.focus.bounds)
    expect(() => getPlacementBounds({ type: 'create_plot', bounds }, context, 'plot')).toThrow(/outside/)
    context.focus.bounds.w = 40
    expect(() => getPlacementBounds({ type: 'create_plot' }, context, 'plot')).toThrow(/too small/)
  })
})

function fixture() {
  const shapes = new Map<string, TLShape>(), context = baseContext(), history: string[] = []
  const fake = {
    getCurrentPageId: () => 'page:test', getCurrentPageShapes: () => [...shapes.values()], getCurrentPageShapesSorted: () => [...shapes.values()],
    getShape: (id: string) => shapes.get(id),
    getShapePageBounds: (s: TLShape) => shapePageBounds(fake as unknown as Editor, s),
    isShapeOrAncestorLocked: (s: TLShape) => s.isLocked,
    markHistoryStoppingPoint: (name: string) => { history.push(name); return name },
    run: (fn: () => void) => fn(),
    createShapes: (items: TLShape[]) => items.forEach(s => shapes.set(s.id, { ...s, isLocked: false })),
    updateShapes: (items: TLShape[]) => items.forEach(s => shapes.set(s.id, { ...shapes.get(s.id)!, ...s })),
    deleteShapes: (ids: string[]) => ids.forEach(id => shapes.delete(id)),
    select: (...ids: string[]) => { context.selectedIds = ids },
    bailToMark: () => {},
  }
  const controller = createBoardController(fake as unknown as Editor, () => context)
  return { shapes, context, history, controller }
}

describe('board actions', () => {
  it('edits a graph in place across conversational followups', () => {
    const { controller, shapes } = fixture()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'sin(x)' }])
    expect(made.ok).toBe(true)
    const id = made.ids[0]
    expect(controller.applyOperations([{ type: 'update_object', expression: 'x^2+3' }]).ok).toBe(true)
    expect(controller.applyOperations([{ type: 'update_object', xMin: 0, xMax: 10 }]).ok).toBe(true)
    expect(shapes.size).toBe(1)
    expect(controller.getObjects()[0]).toMatchObject({ id, expression: 'x^2+3', xMin: 0, xMax: 10 })
    expect(controller.getObjects()[0].yMax).toBeGreaterThan(100)
  })
  it('summarizes only the content belonging to the object kind', () => {
    const { controller } = fixture()
    controller.applyOperations([{ type: 'create_math', latex: '\\int_2^5 \\sin(x)\\,dx' }])
    const math = controller.getObjects()[0]
    expect(math.latex).toContain('\\int')
    expect(math.expression).toBeUndefined()
    expect(math.text).toBeUndefined()
  })
  it('validates a complete batch before performing any mutation', () => {
    const { controller, shapes, history } = fixture()
    const result = controller.applyOperations([
      { type: 'create_text', text: 'This should not be committed' },
      { type: 'create_plot', expression: 'import("evil")' },
    ])
    expect(result.ok).toBe(false)
    expect(shapes.size).toBe(0)
    expect(history).toHaveLength(0)
  })
  it('centers rotations and pointer moves, and makes one history boundary per batch', () => {
    const { controller, shapes, history } = fixture()
    const result = controller.applyOperations([{ type: 'create_geometry', geometry: 'triangle', bounds: { x: 0, y: 0, w: 200, h: 100 } }])
    history.length = 0
    expect(controller.applyOperations([{ type: 'transform_object', rotateBy: 90, placement: 'pointer' }]).ok).toBe(true)
    const shape = shapes.get(result.ids[0])!
    expect(shape.rotation).toBeCloseTo(Math.PI / 2)
    expect(shape.x - 50).toBeCloseTo(500)
    expect(shape.y + 100).toBeCloseTo(400)
    expect(history).toEqual(['magic-command', 'after-magic-command'])
  })
  it('fails safely when deleting or updating a locked background', () => {
    const { controller, shapes } = fixture()
    const { ids } = controller.applyOperations([{ type: 'create_text', text: 'Locked' }])
    shapes.get(ids[0])!.isLocked = true
    expect(controller.applyOperations([{ type: 'delete_objects' }]).ok).toBe(false)
    expect(shapes.size).toBe(1)
  })
  it('moves a multiple-object selection without collapsing its relative layout', () => {
    const { controller, shapes } = fixture()
    const result = controller.applyOperations([
      { type: 'create_text', text: 'A', bounds: { x: 0, y: 0, w: 100, h: 100 } },
      { type: 'create_text', text: 'B', bounds: { x: 200, y: 100, w: 100, h: 100 } },
    ])
    expect(controller.applyOperations([{ type: 'transform_object', ids: result.ids, placement: 'pointer' }]).ok).toBe(true)
    const a = shapes.get(result.ids[0])!, b = shapes.get(result.ids[1])!
    expect(b.x - a.x).toBe(200)
    expect(b.y - a.y).toBe(100)
    expect((a.x + b.x + 100) / 2).toBe(500)
    expect((a.y + b.y + 100) / 2).toBe(400)
  })
  it('allows blank text/math objects for direct typing, with black defaults', () => {
    const { controller } = fixture()
    const result = controller.applyOperations([{ type: 'create_math', latex: '' }, { type: 'create_text', text: '' }])
    expect(result.ok).toBe(true)
    expect(controller.getObjects().map(o => o.color)).toEqual(['#111111', '#111111'])
  })
  it('edits individual math characters in place and rejects invalid resulting LaTeX', () => {
    const { controller, shapes } = fixture()
    const result = controller.applyOperations([{ type: 'create_math', latex: '\\int_2^5 x\\,dx' }])
    const id = result.ids[0]
    expect(controller.applyOperations([{ type: 'edit_content', target: id, field: 'latex', find: '5', replace: '7' }]).ok).toBe(true)
    expect(controller.getObjects()[0].latex).toBe('\\int_2^7 x\\,dx')
    expect(controller.applyOperations([{ type: 'edit_content', target: id, field: 'latex', replacement: '\\frac{' }]).ok).toBe(false)
    expect(shapes.size).toBe(1)
    expect(controller.getObjects()[0].latex).toBe('\\int_2^7 x\\,dx')
  })
  it('validates graph character edits and keeps the graph ID', () => {
    const { controller } = fixture()
    const { ids } = controller.applyOperations([{ type: 'create_plot', expression: 'x^2 + 2' }])
    expect(controller.applyOperations([{ type: 'edit_content', target: ids[0], field: 'expression', start: 6, end: 7, replacement: '3' }]).ok).toBe(true)
    expect(controller.getObjects()[0]).toMatchObject({ id: ids[0], expression: 'x^2 + 3' })
    expect(controller.applyOperations([{ type: 'edit_content', target: ids[0], field: 'expression', replacement: '; import("bad")' }]).ok).toBe(false)
  })
  it('keeps explicit fitFocus resizing available in reference mode', () => {
    const { controller, context } = fixture()
    controller.applyOperations([{ type: 'create_plot', expression: 'x' }])
    context.focus = { kind: 'region', bounds: { x: 20, y: 30, w: 700, h: 240 }, targetIds: [] }
    expect(controller.applyOperations([{ type: 'transform_object', fitFocus: true }]).ok).toBe(true)
    expect(controller.getObjects()[0].bounds).toEqual(context.focus.bounds)
  })
  it('creates equal-axis plots but preserves the auto-axis appearance of legacy plots', () => {
    const { controller, shapes } = fixture()
    const { ids } = controller.applyOperations([{ type: 'create_plot', expression: 'x', xMin: 0, xMax: 10 }])
    const before = controller.getObjects()[0]
    expect(before.axisMode).toBe('equal')
    expect(before.displayedRange).toMatchObject({ xMin: 0, xMax: 10 })
    const shape = shapes.get(ids[0])!
    shape.meta = {}
    expect(controller.getObjects()[0].axisMode).toBe('auto')
    expect(controller.applyOperations([{ type: 'update_object', axisMode: 'equal' }]).ok).toBe(true)
    expect(controller.getObjects()[0]).toMatchObject({ id: ids[0], bounds: before.bounds, axisMode: 'equal' })
    expect(shapes.size).toBe(1)
  })
  it('rejects literal creates and explicit bounds that escape, without partial changes', () => {
    const { controller, context, shapes, history } = fixture()
    context.focusMode = 'literal'
    context.focus = { kind: 'region', bounds: { x: 0, y: 0, w: 500, h: 300 }, targetIds: [] }
    const result = controller.applyOperations([
      { type: 'create_text', text: 'Inside', bounds: { x: 10, y: 10, w: 100, h: 80 } },
      { type: 'create_plot', bounds: { x: 400, y: 100, w: 200, h: 180 } },
    ])
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toMatch(/outside/)
    expect(shapes.size).toBe(0)
    expect(history).toHaveLength(0)
    context.focus.bounds.w = 25
    expect(controller.applyOperations([{ type: 'create_plot' }]).message).toMatch(/too small/)
  })
  it('restricts literal targeting, moves, resizing, and rotation using final rotated bounds', () => {
    const { controller, context } = fixture()
    const { ids } = controller.applyOperations([
      { type: 'create_geometry', bounds: { x: 10, y: 10, w: 180, h: 100 } },
      { type: 'create_text', text: 'Unrelated', bounds: { x: 400, y: 400, w: 100, h: 100 } },
    ])
    context.focusMode = 'literal'
    context.focus = { kind: 'region', bounds: { x: 0, y: 0, w: 220, h: 120 }, targetIds: [ids[0]] }
    expect(controller.applyOperations([{ type: 'delete_objects', target: ids[1] }]).message).toMatch(/outside/)
    expect(controller.applyOperations([{ type: 'transform_object', target: ids[0], dx: 40 }]).ok).toBe(false)
    expect(controller.applyOperations([{ type: 'transform_object', target: ids[0], scale: 2 }]).ok).toBe(false)
    expect(controller.applyOperations([{ type: 'transform_object', target: ids[0], rotateBy: 90 }]).ok).toBe(false)
    expect(controller.applyOperations([{ type: 'transform_object', target: ids[0], dx: 15 }]).ok).toBe(true)
    expect(controller.getObjects()).toHaveLength(2)
    expect(controller.getObjects()[0].bounds).toEqual({ x: 25, y: 10, w: 180, h: 100 })
  })
  it('records literal layout bounds and clears them on a reference update', () => {
    const { controller, context, shapes } = fixture()
    context.focusMode = 'literal'
    context.focus = { kind: 'region', bounds: { x: 0, y: 0, w: 400, h: 180 }, targetIds: [] }
    const { ids, ok } = controller.applyOperations([{ type: 'create_math', latex: 'x' }])
    expect(ok).toBe(true)
    expect(shapes.get(ids[0])!.meta.literalBounds).toEqual(context.focus.bounds)
    context.focusMode = 'reference'
    expect(controller.applyOperations([{ type: 'update_object', latex: 'y' }]).ok).toBe(true)
    expect(shapes.get(ids[0])!.meta.literalBounds).toBeUndefined()
  })
})

describe('plot coordinate scaling', () => {
  it.each([{ w: 440, h: 320 }, { w: 800, h: 180 }, { w: 240, h: 700 }])('makes y=x 45 degrees after resize to $w × $h', size => {
    const layout = getPlotLayout({ ...size, xMin: -10, xMax: 10, yMin: -100, yMax: 100 }, 'equal')
    expect(layout.X(1) - layout.X(0)).toBeCloseTo(layout.Y(0) - layout.Y(1), 10)
    expect(layout.range.xMin).toBe(-10)
    expect(layout.range.xMax).toBe(10)
    const paths = samplePlot('x', layout.range.xMin, layout.range.xMax, layout.range.yMin, layout.range.yMax, layout.width, layout.height)
    const points = [...paths.join('').matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(m => [Number(m[1]), Number(m[2])])
    const first = points[0], last = points[points.length - 1]
    expect((last[1] - first[1]) / (last[0] - first[0])).toBeCloseTo(-1, 3)
  })
  it('retains stored ranges in auto mode and treats missing metadata as legacy auto', () => {
    const props = { w: 440, h: 320, xMin: -2, xMax: 5, yMin: -100, yMax: 300 }
    const layout = getPlotLayout(props, 'auto')
    expect(layout.range).toEqual({ xMin: -2, xMax: 5, yMin: -100, yMax: 300 })
    expect(getAxisMode()).toBe('auto')
    expect(getAxisMode({ axisMode: 'equal' })).toBe('equal')
  })
})
