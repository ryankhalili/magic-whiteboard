import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { visualizationSchema } from '../shared/visualization'
import { faceLight, meshAxes, meshViewBounds, meshProjection, phaseField, scalarField, scientificMesh, validateScientific } from '../src/math/scientific'
import { Editor } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { magicShapeToSvg, type MagicShape } from '../src/board/MagicShape'
import { PlotGraphic } from '../src/board/PlotGraphic'
import { DEFAULT_SETTINGS, type BoardContext } from '../shared/board'
import { parseProjectFile, projectFileBlob } from '../src/files/boardFiles'
import { renderShapesToSvg } from '../src/files/imageExporter'
import { sourceUpdate } from '../src/board/liveSource'
import { editorToExcalidrawScene, sceneToEditorChanges } from '../src/canvas/excalidrawScene'

const range = { xMin: -2, xMax: 2, yMin: -2, yMax: 2 }
function workspace(editor = new Editor()) {
  const controller = createBoardController(editor, (): BoardContext => ({
    focus: null, pointer: { x: 400, y: 300 }, selectedIds: editor.getSelectedShapeIds(),
    lastCreatedIds: controller.lastCreatedIds, objects: controller.getObjects(), viewport: editor.getViewportPageBounds(),
  }))
  return { editor, controller }
}

describe('scientific expression and parameter boundaries', () => {
  it('creates empty 3D axes without inventing a plane, with validated Z limits', () => {
    const mesh = scientificMesh('0', { type: 'axes', zMin: -4, zMax: 8 }, range)
    expect(mesh.faces).toEqual([])
    expect(mesh.bounds).toEqual({ min: { x: -2, y: -2, z: -4 }, max: { x: 2, y: 2, z: 8 } })
    expect(() => validateScientific('0', { type: 'axes', zMin: 10, zMax: 0 })).toThrow('Z maximum')
    const { controller, editor } = workspace()
    expect(controller.applyOperations([{ type: 'create_plot', expression: '0', visualization: { type: 'axes' }, ...range }]).ok).toBe(true)
    const shape = editor.getCurrentPageShapes()[0] as MagicShape
    const svg = renderToStaticMarkup(createElement('svg', null, createElement(PlotGraphic, { shape })))
    expect(svg).toContain('3D axes')
    expect(svg).toContain('data-plot-layer="axis"')
  })
  it('evaluates a scalar field in both coordinates without changing its sign', () => {
    const field = scalarField('z = x² - 2y + sin(π/2)')
    expect(field.evaluate(3, 7)).toBeCloseTo(-4)
    expect(scalarField('y').evaluate(3, -2)).toBe(-2)
    expect(scalarField('0').evaluate(3, 7)).toBe(0)
  })

  it.each(['import("fs")', 'evaluate("2+2")', 'x.constructor', 'random()', 'factorial(100000)', 'sum(1:1000)', '[x,y]', 'x; y', 'a=1', 'x=(y=4)', 'x>y', 'x?y:0'])('rejects non-scalar or code-like field %s', expression => {
    expect(() => scalarField(expression)).toThrow()
  })

  it('rejects excessive AST work, unsupported fields and invalid parameters', () => {
    expect(() => scalarField('('.repeat(25) + 'x' + ')'.repeat(25))).toThrow()
    expect(() => scalarField('x'.repeat(241))).toThrow()
    expect(() => validateScientific('x', { type: 'phase' })).toThrow(/both/)
    expect(() => validateScientific('x*y=1', { type: 'revolution' })).toThrow(/radius/)
    expect(visualizationSchema.safeParse({ type: 'surface', code: 'alert(1)' }).success).toBe(false)
    for (const bad of [{ type: 'surface', yaw: Infinity }, { type: 'phase', duration: 1e6 }, { type: 'revolution', sweep: 0 }, { type: 'phase', seeds: Array(13).fill({ x: 1, y: 1 }) }]) {
      expect(visualizationSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('sampled surfaces and revolutions', () => {
  it('keeps a tilted plane planar and has a fixed geometry ceiling', () => {
    const mesh = scientificMesh('2*x - 3*y + 1', { type: 'surface' }, range)
    expect(mesh.faces.length).toBeGreaterThan(500)
    expect(mesh.faces.length).toBeLessThanOrEqual(28 * 28)
    for (const p of mesh.faces.flat()) expect(p.z).toBeCloseTo(2 * p.x - 3 * p.y + 1, 10)
  })

  it('omits the missing real half of sqrt(x) and rejects an entirely undefined surface', () => {
    const mesh = scientificMesh('sqrt(x)', { type: 'surface' }, range)
    expect(mesh.faces.length).toBeGreaterThan(0)
    expect(mesh.faces.flat().every(p => p.x >= 0 && Number.isFinite(p.z))).toBe(true)
    expect(() => scientificMesh('sqrt(-1)', { type: 'surface' }, range)).toThrow(/no finite/)
    expect(() => scientificMesh('x', { type: 'surface' }, { ...range, xMin: 3, xMax: -3 })).toThrow()
  })

  it('does not bridge the unsampled pole of a reciprocal surface', () => {
    const mesh = scientificMesh('1/x', { type: 'surface' }, { ...range, xMin: -1, xMax: 2 })
    expect(mesh.faces.length).toBeGreaterThan(0)
    expect(mesh.faces.some(face => Math.min(...face.map(p => p.x)) < 0 && Math.max(...face.map(p => p.x)) > 0)).toBe(false)
  })

  it('revolves a radius function around X and Y with equal physical dimensions', () => {
    const domain = { ...range, xMin: 0, xMax: 2 }
    const aroundX = scientificMesh('x^2 + 1', { type: 'revolution', axis: 'x' }, domain)
    const aroundY = scientificMesh('x^2 + 1', { type: 'revolution', axis: 'y' }, domain)
    for (const p of aroundX.faces.flat()) expect(Math.hypot(p.y, p.z)).toBeCloseTo(p.x ** 2 + 1, 10)
    // For axis Y, expression(x) means radius versus axial coordinate, as the schema documents.
    for (const p of aroundY.faces.flat()) expect(Math.hypot(p.x, p.z)).toBeCloseTo(p.y ** 2 + 1, 10)
    expect(aroundX.bounds.max.x).toBe(2)
    expect(aroundY.bounds.max.y).toBe(2)
  })

  it('respects a partial sweep and closes a full sweep without nonfinite coordinates', () => {
    const half = scientificMesh('2', { type: 'revolution', sweep: 180 }, range)
    expect(half.faces.flat().every(p => p.z >= -1e-12)).toBe(true)
    const full = scientificMesh('2', { type: 'revolution', sweep: 360 }, range)
    expect(full.faces.flat().some(p => p.z < -1)).toBe(true)
    for (const p of full.faces.flat()) expect(Math.hypot(p.y, p.z)).toBeCloseTo(2, 10)
    const project = meshProjection(full, { type: 'revolution', yaw: 72, pitch: -25 }, 480, 360)
    for (const p of full.faces.flat()) expect(Object.values(project(p)).every(Number.isFinite)).toBe(true)
  })

  it('does not join two revolution branches across an unsampled radius pole', () => {
    const mesh = scientificMesh('1/x', { type: 'revolution', axis: 'x' }, { ...range, xMin: -1, xMax: 2 })
    expect(mesh.faces.length).toBeGreaterThan(0)
    expect(mesh.faces.some(face => Math.min(...face.map(p => p.x)) < 0 && Math.max(...face.map(p => p.x)) > 0)).toBe(false)
  })
})

describe('bounded numerical phase portraits', () => {
  it('preserves the harmonic oscillator invariant and reaches the requested short time in both directions', () => {
    const field = phaseField('y', { type: 'phase', secondaryExpression: '-x', seeds: [{ x: 1, y: 0 }], duration: 1 }, range)
    expect(field.paths).toHaveLength(2)
    for (const path of field.paths) for (const p of path) expect(p.x * p.x + p.y * p.y).toBeCloseTo(1, 7)
    expect(field.paths[0].at(-1)!.x).toBeCloseTo(Math.cos(1), 6)
    expect(field.paths[0].at(-1)!.y).toBeCloseTo(Math.sin(1), 6)
    expect(field.paths[1].at(-1)!.y).toBeCloseTo(-Math.sin(1), 6)
  })

  it('stops at the domain and bounds the total seed and step work', () => {
    const field = phaseField('1', { type: 'phase', secondaryExpression: '0', seeds: Array.from({ length: 12 }, (_, i) => ({ x: 0, y: -1 + i / 6 })), duration: 40 }, range)
    expect(field.arrows.length).toBeLessThanOrEqual(130)
    expect(field.paths.length).toBeLessThanOrEqual(24)
    for (const path of field.paths) {
      expect(path.length).toBeLessThanOrEqual(801)
      expect(path.every(p => p.x >= -2 && p.x <= 2 && p.y >= -2 && p.y <= 2)).toBe(true)
    }
  })

  it('handles stationary and undefined fields without invented paths or NaN arrows', () => {
    expect(phaseField('0', { type: 'phase', secondaryExpression: '0' }, range)).toEqual({ arrows: [], paths: [] })
    expect(phaseField('1/0', { type: 'phase', secondaryExpression: '0' }, range)).toEqual({ arrows: [], paths: [] })
    const field = phaseField('10000*y', { type: 'phase', secondaryExpression: '-10000*x', duration: 40 }, range)
    expect(field.paths.every(path => path.length <= 801 && path.every(p => Number.isFinite(p.x + p.y)))).toBe(true)
  })
})

describe('scientific objects through command, backup and export paths', () => {
  it('preserves explicit domains through updates, reports model context and round-trips the editable notebook', async () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface', yaw: 10 }, ...range }])
    expect(made.ok).toBe(true)
    const id = made.ids[0] as MagicShape['id']
    expect(controller.applyOperations([{ type: 'update_object', target: id, visualization: { type: 'surface', pitch: 40 }, xMin: -5, xMax: 5 }]).ok).toBe(true)
    const shape = editor.getShape<MagicShape>(id)!
    expect(shape.props.visualization).toMatchObject({ type: 'surface', yaw: 10, pitch: 40 })
    expect(shape.props).toMatchObject({ yMin: -2, yMax: 2 })
    expect(controller.getObjects()[0]).toMatchObject({ visualization: shape.props.visualization, displayedRange: { xMin: -5, xMax: 5, yMin: -2, yMax: 2 } })
    const project = parseProjectFile(await projectFileBlob(editor, DEFAULT_SETTINGS).text())
    const restored = new Editor(project.snapshot)
    expect(restored.getShape<MagicShape>(id)?.props).toEqual(shape.props)
  })

  it('keeps the last valid object when an unsafe or incompatible edit fails', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'sin(x)*cos(y)', visualization: { type: 'surface' }, ...range }])
    expect(made.ok).toBe(true)
    const id = made.ids[0] as MagicShape['id'], original = editor.getSnapshot()
    for (const operation of [{ type: 'update_object' as const, target: id, expression: 'import("fs")' }, { type: 'update_object' as const, target: id, fitY: true }, { type: 'update_object' as const, target: id, visualization: { type: 'phase' as const } }]) {
      expect(controller.applyOperations([operation]).ok).toBe(false)
      expect(editor.getSnapshot()).toEqual(original)
    }
  })

  it('rejects corrupted scientific metadata before replacing an existing document', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range }])
    const id = made.ids[0] as MagicShape['id'], original = editor.getSnapshot()
    const broken = structuredClone(original)
    const shape = broken.document.store[id] as MagicShape
    shape.props.visualization = { type: 'surface', yaw: NaN }
    expect(() => editor.loadSnapshot(broken)).toThrow()
    expect(editor.getSnapshot()).toEqual(original)
    shape.props.visualization = { type: 'surface' }; shape.props.expression = 'x.constructor'
    expect(() => editor.loadSnapshot(broken)).toThrow()
    expect(editor.getSnapshot()).toEqual(original)
  })

  it('rejects invalid scientific domains during restore before changing the current notebook', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range }])
    const id = made.ids[0] as MagicShape['id'], original = editor.getSnapshot()
    for (const change of [{ xMin: 2, xMax: -2 }, { yMin: 1, yMax: 1 }]) {
      const damaged = structuredClone(original)
      Object.assign((damaged.document.store[id] as MagicShape).props, change)
      expect(() => editor.loadSnapshot(damaged)).toThrow()
      expect(editor.getSnapshot()).toEqual(original)
    }
  })

  it('preserves scientific metadata when the native canvas moves and resizes an object', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface', yaw: 15 }, ...range }])
    const id = made.ids[0] as MagicShape['id'], before = editor.getShape<MagicShape>(id)!
    const scene = editorToExcalidrawScene(editor)
    const moved = scene.elements.map(element => ({ ...element, x: element.x + 50, width: element.width * 1.5 }))
    const changes = sceneToEditorChanges(editor, moved, scene.files)
    editor.updateShapes(changes.updates)
    const after = editor.getShape<MagicShape>(id)!
    expect(after.props.visualization).toEqual(before.props.visualization)
    expect(after.props.expression).toBe('x*y')
    expect(after.x).toBeCloseTo(before.x + 50)
    expect(after.props.w).toBeCloseTo(before.props.w * 1.5)
  })

  it('allows a bivariate manual source edit while retaining invalid drafts off the document', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range }])
    const shape = editor.getShape<MagicShape>(made.ids[0] as MagicShape['id'])!
    expect(sourceUpdate(shape, 'z=sin(x)*cos(y)')).toEqual({ expression: 'sin(x)*cos(y)' })
    expect(() => sourceUpdate(shape, 'sin(x)*')).toThrow()
    expect(shape.props.expression).toBe('x*y')
  })

  it('switches visualization types without retaining incompatible old metadata', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x', visualization: { type: 'revolution', axis: 'y', sweep: 90 }, ...range }])
    const id = made.ids[0] as MagicShape['id']
    expect(controller.applyOperations([{ type: 'update_object', target: id, expression: 'y', visualization: { type: 'phase', secondaryExpression: '-x' } }]).ok).toBe(true)
    expect(editor.getShape<MagicShape>(id)?.props.visualization).toEqual({ type: 'phase', secondaryExpression: '-x' })
  })

  it('respects phase grid and axes controls in the real export path', async () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'y', visualization: { type: 'phase', secondaryExpression: '-x' }, ...range, showGrid: false, showAxes: false }])
    const exported = await renderShapesToSvg(editor, made.ids as MagicShape['id'][])
    expect(exported.svg).toContain('\\frac{dx}{dt}')
    expect(exported.svg).not.toContain('#e5e7eb')
    expect(exported.svg).not.toContain('stroke="#6b7280"')
    expect(exported.svg).toContain('marker-end=')
  })

  it('applies the line width offered by object controls to surface wireframes', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range, strokeWidth: 4.5 }])
    const shape = editor.getShape<MagicShape>(made.ids[0] as MagicShape['id'])!
    const markup = renderToStaticMarkup(createElement('svg', null, createElement(PlotGraphic, { shape })))
    const polygon = markup.match(/<polygon[^>]+stroke-width=[^>]+>/)?.[0]
    expect(polygon).toContain('stroke-width="4.5"')
  })

  it.each(['surface', 'phase', 'revolution', 'axes'] as const)('uses identical live and exported SVG content for %s', async type => {
    const { editor, controller } = workspace()
    const expression = type === 'surface' ? 'x*y' : type === 'phase' ? 'y' : 'sqrt(x)'
    const made = controller.applyOperations([{ type: 'create_plot', expression, visualization: { type, ...(type === 'phase' ? { secondaryExpression: '-x' } : {}) }, ...range }])
    expect(made.ok).toBe(true)
    const shape = editor.getShape<MagicShape>(made.ids[0] as MagicShape['id'])!
    const live = renderToStaticMarkup(createElement(PlotGraphic, { shape }))
    const exported = renderToStaticMarkup(await magicShapeToSvg(shape))
    expect(exported).toContain(live)
    expect(exported).toContain('<style>')
    expect(exported).not.toMatch(/NaN|Infinity|Unable to draw/)
    expect(exported).toContain(type === 'phase' ? '\\frac{dx}{dt}' : 'data-plot-axis=')
    expect(exported).not.toContain('Sampled surface')
    if (type !== 'phase' && type !== 'axes') expect(exported).toContain('<polygon')
    if (type === 'axes') expect(exported).not.toContain('<polygon')
    const fullExport = await renderShapesToSvg(editor, [shape.id])
    expect(fullExport.svg).toContain(exported)
    expect(fullExport.svg).toContain('viewBox=')
  })
})


describe('readable scientific axes and independent display settings', () => {
  it('projects positive X toward the viewer, positive Y right and positive Z up by default', () => {
    const mesh = scientificMesh('x*y', { type: 'surface' }, range)
    const project = meshProjection(mesh, { type: 'surface' }, 480, 360)
    const o = project({ x: 0, y: 0, z: 0 }), x = project({ x: 1, y: 0, z: 0 }), y = project({ x: 0, y: 1, z: 0 }), z = project({ x: 0, y: 0, z: 1 })
    expect(x.depth).toBeGreaterThan(o.depth)
    expect(x.y).toBeGreaterThan(o.y)
    expect(y.x).toBeGreaterThan(o.x)
    expect(z.y).toBeLessThan(o.y)
  })

  it.each(['0', '2', 'sin(sqrt(x^2+y^2))', '1000000+x'])('keeps bounded, finite, separated ticks for %s', expression => {
    const mesh = scientificMesh(expression, { type: 'surface' }, range)
    const project = meshProjection(mesh, { type: 'surface' }, 480, 360)
    const bounds = meshViewBounds(mesh)
    for (const { axis, ticks } of meshAxes(mesh, project)) {
      expect(bounds.min[axis]).toBeLessThan(bounds.max[axis])
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks.length).toBeLessThanOrEqual(10)
      for (const [i, tick] of ticks.entries()) {
        expect(Number.isFinite(tick.value)).toBe(true)
        expect(Object.values(tick.point).every(Number.isFinite)).toBe(true)
        if (i) expect(Math.hypot(tick.point.x - ticks[i - 1].point.x, tick.point.y - ticks[i - 1].point.y)).toBeGreaterThanOrEqual(20)
      }
    }
  })

  it('preserves grid, number and mesh settings through commands, context, undo and file restore', async () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range }])
    const id = made.ids[0] as MagicShape['id']
    expect(controller.applyOperations([{ type: 'update_object', target: id, showAxes: false, showNumbers: true, showGrid: false, visualization: { type: 'surface', showWireframe: false } }]).ok).toBe(true)
    expect(controller.getObjects()[0]).toMatchObject({ showAxes: false, showNumbers: true, showGrid: false, visualization: { showWireframe: false } })
    const exported = await renderShapesToSvg(editor, [id])
    expect(exported.svg).toContain('data-plot-layer="number"')
    expect(exported.svg).not.toContain('data-plot-layer="grid"')
    expect(exported.svg).not.toContain('data-plot-layer="axis"')
    expect(exported.svg.match(/<polygon[^>]+>/)?.[0]).toContain('stroke="none"')
    expect(exported.svg).not.toContain('Sampled surface')
    const project = parseProjectFile(await projectFileBlob(editor, DEFAULT_SETTINGS).text())
    expect(new Editor(project.snapshot).getShape<MagicShape>(id)?.props).toEqual(editor.getShape<MagicShape>(id)?.props)
    editor.undo()
    expect(editor.getShape<MagicShape>(id)?.props.showNumbers).toBeUndefined()
  })

  it('hides numeric ticks without removing 3D axes or the grid', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range, showNumbers: false }])
    const shape = editor.getShape<MagicShape>(made.ids[0] as MagicShape['id'])!
    const svg = renderToStaticMarkup(createElement(PlotGraphic, { shape }))
    expect(svg).not.toContain('data-plot-layer="number"')
    expect(svg).toContain('data-plot-layer="axis"')
    expect(svg).toContain('data-plot-layer="grid"')
  })

  it('rejects corrupt display settings during notebook restore', () => {
    const { editor, controller } = workspace()
    const made = controller.applyOperations([{ type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, ...range }])
    const snapshot = editor.getSnapshot(), broken = structuredClone(snapshot)
    const record = broken.document.store[made.ids[0]] as MagicShape
    Object.assign(record.props, { showNumbers: 'yes' })
    expect(() => editor.loadSnapshot(broken)).toThrow(/display option/)
    expect(editor.getSnapshot()).toEqual(snapshot)
  })
})


describe('surface lighting', () => {
  it('shades different normals, is winding-independent, and stays finite on degenerate faces', () => {
    const mesh = scientificMesh('x*x+y*y', { type: 'surface' }, range)
    const project = meshProjection(mesh, { type: 'surface' }, 480, 360)
    const lights = mesh.faces.map(face => faceLight(face, project))
    expect(Math.max(...lights) - Math.min(...lights)).toBeGreaterThan(.2)
    expect(lights.every(value => Number.isFinite(value) && value >= .28 && value <= .88)).toBe(true)
    expect(faceLight(mesh.faces[80], project)).toBeCloseTo(faceLight([...mesh.faces[80]].reverse(), project), 2)
    expect(faceLight(Array(4).fill({ x: 0, y: 0, z: 0 }), project)).toBe(.5)
  })
})
