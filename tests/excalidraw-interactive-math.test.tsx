import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement, ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types'
import { Editor } from '../src/canvas/editor'
import { editorToExcalidrawScene, sceneToEditorChanges } from '../src/canvas/excalidrawScene'
import { createBoardController } from '../src/board/controller'
import { renderShapesToSvg } from '../src/files/imageExporter'
import type { TLShape } from '../src/canvas/types'
import { polygonInteriorAngles } from '../shared/geometry'

function setup() {
  const editor = new Editor()
  editor.createAssets([{ id: 'asset:test', typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,abc', mimeType: 'image/png', w: 800, h: 600 } }])
  editor.createShape({ id: 'shape:image', type: 'image', x: 40, y: 50, rotation: Math.PI / 2, props: { assetId: 'asset:test', w: 400, h: 300 } })
  const controller = createBoardController(editor, () => ({ focus: null, pointer: null, selectedIds: [], viewport: { x: 0, y: 0, w: 1000, h: 800 }, objects: [], lastCreatedIds: [] }))
  const image = () => editor.getShape<TLShape<'image'>>('shape:image')!
  const native = () => editorToExcalidrawScene(editor).elements.find(element => element.id === image().id) as ExcalidrawImageElement
  const ingest = (elements: ExcalidrawElement[]) => {
    const changes = sceneToEditorChanges(editor, elements)
    editor.run(() => { editor.createShapes(changes.creates); editor.updateShapes(changes.updates) })
  }
  return { editor, controller, image, native, ingest }
}

describe('interactive math with Excalidraw', () => {
  it('keeps the same crop through native resize, rotated reset, export, reload and undo', async () => {
    const { editor, controller, image, native, ingest } = setup()
    expect(controller.applyOperations([{ type: 'update_object', target: image().id, crop: { x: .25, y: .1, w: .5, h: .8 } }]).ok).toBe(true)
    expect(native().crop).toEqual({ x: 200, y: 60, width: 400, height: 480, naturalWidth: 800, naturalHeight: 600 })
    const resized = { ...native(), width: 300, height: 360 }
    ingest([resized])
    expect(image().props.crop).toEqual({ x: .25, y: .1, w: .5, h: .8 })
    expect(native().crop).toEqual(resized.crop)
    const saved = new Editor(editor.getSnapshot())
    expect(editorToExcalidrawScene(saved).elements[0]).toMatchObject({ width: 300, height: 360, crop: resized.crop })
    const exported = await renderShapesToSvg(saved, [image().id])
    expect(exported.svg).toContain('viewBox="0.25 0.1 0.5 0.8"')
    const beforeReset = structuredClone(image())
    expect(controller.applyOperations([{ type: 'update_object', target: image().id, crop: { x: 0, y: 0, w: 1, h: 1 } }]).ok).toBe(true)
    expect(native().crop).toBeNull()
    expect(image().props).toMatchObject({ w: 600, h: 450 })
    editor.undo(); expect(image()).toEqual(beforeReset)
    editor.redo(); expect(native().crop).toBeNull()
  })

  it('imports native cropping and reset into portable data without a feedback loop', () => {
    const { editor, image, native, ingest } = setup()
    const cropped = { ...native(), crop: { x: 200, y: 60, width: 400, height: 480, naturalWidth: 800, naturalHeight: 600 }, width: 200, height: 240 }
    ingest([cropped])
    expect(image().props.crop).toEqual({ x: .25, y: .1, w: .5, h: .8 })
    expect(sceneToEditorChanges(editor, [native()]).updates).toEqual([])
    ingest([{ ...native(), crop: null, width: 400, height: 300 }])
    expect(image().props.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(native().crop).toBeNull()
  })

  it('migrates earlier Excalidraw crops and exports flipped images consistently', async () => {
    const { editor, image } = setup()
    editor.updateShape({ id: image().id, type: 'image', props: { excalidrawCrop: { x: 200, y: 60, width: 400, height: 480, naturalWidth: 800, naturalHeight: 600 }, excalidrawScale: [-1, 1] } })
    const restored = new Editor(editor.getSnapshot())
    expect(restored.getShape<TLShape<'image'>>(image().id)?.props.crop).toEqual({ x: .25, y: .1, w: .5, h: .8 })
    const exported = await renderShapesToSvg(restored, [image().id])
    expect(exported.svg).toContain('scale(-1 1)')
    expect(exported.svg).toContain('viewBox="0.25 0.1 0.5 0.8"')
  })

  it('preserves implicit equations, angle constraints and styles after native duplication and resizing', () => {
    const { editor, controller, ingest } = setup()
    const result = controller.applyOperations([
      { type: 'create_plot', expression: 'x^2+y^2=9', showGrid: false, strokeWidth: 4 },
      { type: 'create_geometry', geometry: 'polygon', angles: [91, 91, 90, 88], fill: '#ff0000', fillOpacity: .3 },
    ])
    expect(result.ok).toBe(true)
    const scene = editorToExcalidrawScene(editor)
    const polygon = scene.elements.at(-1)!
    ingest([...scene.elements, { ...polygon, id: 'duplicated-polygon', width: 600, height: 100 }])
    const restored = new Editor(editor.getSnapshot())
    const copy = restored.getShape<TLShape<'magic'>>('duplicated-polygon')!
    expect(copy.props).toMatchObject({ w: 600, h: 100, angles: [91, 91, 90, 88], fill: '#ff0000', fillOpacity: .3 })
    polygonInteriorAngles(copy.props.vertices!).forEach((angle, i) => expect(angle).toBeCloseTo(copy.props.angles![i], 6))
    expect(restored.getCurrentPageShapes().find(shape => shape.type === 'magic' && shape.props.kind === 'plot')?.props).toMatchObject({ expression: 'x^2+y^2=9', showGrid: false, strokeWidth: 4 })
  })
})
