import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement, ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { Editor } from './editor'
import { disconnectedInkBounds, isDisconnectedInk } from './disconnectedInk'
import { editorToExcalidrawScene, sceneToEditorChanges, LIVE_CONTENT_FILE_ID } from './excalidrawScene'
import type { DrawProps, TLShape } from './types'
import { renderShapesToSvg } from '../files/imageExporter'
import { inkOutlinePath } from './ink'
import { getStrokeWidth } from './geometry'

function setup() {
  const editor = new Editor()
  const segments: NonNullable<DrawProps['segments']> = [
    { type: 'free', points: [{ x: -25, y: 10, z: .2 }, { x: -5, y: 35, z: .8 }] },
    { type: 'free', points: [{ x: 90, y: 70, pressure: .6 }, { x: 130, y: 90, pressure: .4 }] },
  ]
  editor.createShape({ id: 'shape:disconnected', type: 'draw', x: 250, y: 120, rotation: .35, props: { points: segments.flatMap(segment => segment.points), segments, color: '#2563eb', size: 'm' } })
  editor.markHistoryStoppingPoint('Initial legacy ink')
  const shape = () => editor.getShape<TLShape<'draw'>>('shape:disconnected')!
  const element = () => editorToExcalidrawScene(editor).elements[0] as ExcalidrawImageElement
  const apply = (elements: ExcalidrawElement[]) => {
    const changes = sceneToEditorChanges(editor, elements)
    editor.run(() => { editor.createShapes(changes.creates); editor.updateShapes(changes.updates); editor.deleteShapes(changes.deletes) })
    return changes
  }
  return { editor, shape, element, apply }
}

describe('disconnected legacy ink through Excalidraw', () => {
  it('uses one source-backed image instead of joining separate paths into freedraw', () => {
    const { editor, shape, element } = setup()
    const before = structuredClone(shape()), bounds = disconnectedInkBounds(before)
    expect(isDisconnectedInk(before)).toBe(true)
    expect(element()).toMatchObject({ type: 'image', fileId: LIVE_CONTENT_FILE_ID, width: bounds.w, height: bounds.h, customData: { magicWhiteboard: { shape: before, offset: { x: bounds.x, y: bounds.y } } } })
    const file = { id: 'render:ink', mimeType: 'image/png', dataURL: 'data:image/png;base64,aW5r', created: 1 } as BinaryFileData
    const scene = editorToExcalidrawScene(editor, [], new Map([[before.id, file]]))
    expect(scene.elements[0]).toMatchObject({ type: 'image', fileId: file.id })
    expect(sceneToEditorChanges(editor, scene.elements, scene.files)).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
    expect(shape()).toEqual(before)
    expect(editorToExcalidrawScene(editor, scene.elements, new Map([[before.id, file]])).elements[0]).toBe(scene.elements[0])
  })

  it('keeps exact segments, pressure, origin and one undo step through native movement and rotation', () => {
    const { editor, shape, element, apply } = setup()
    const before = structuredClone(shape()), native = element()
    const moved = { ...native, x: native.x + 50, y: native.y - 15, angle: native.angle + .7 }
    apply([moved]); editor.markHistoryStoppingPoint('After native gesture')
    expect(shape().props).toEqual(before.props)
    expect(shape().rotation).toBeCloseTo(before.rotation + .7)
    const proxy = element()
    expect(proxy.x).toBeCloseTo(moved.x); expect(proxy.y).toBeCloseTo(moved.y)
    expect(proxy.width).toBe(moved.width); expect(proxy.height).toBe(moved.height)
    expect(sceneToEditorChanges(editor, [proxy]).updates).toEqual([])
    const after = structuredClone(shape())
    editor.undo(); expect(shape()).toEqual(before)
    editor.redo(); expect(shape()).toEqual(after)
  })

  it('scales independent segments and retains their source through repeated events, save and export', async () => {
    const { editor, shape, element, apply } = setup()
    const before = structuredClone(shape()), native = element()
    const resized = { ...native, width: native.width * 1.8, height: native.height * 1.4 }
    apply([resized])
    expect(shape().props.segments).toHaveLength(2)
    expect(shape().props.segments!.map(segment => segment.points.map(point => point.pressure ?? point.z))).toEqual([[.2, .8], [.6, .4]])
    expect(shape().props.points).toEqual(shape().props.segments!.flatMap(segment => segment.points))
    expect(disconnectedInkBounds(shape()).w).toBeCloseTo(resized.width)
    expect(disconnectedInkBounds(shape()).h).toBeCloseTo(resized.height)
    expect(sceneToEditorChanges(editor, [resized]).updates).toEqual([])
    editor.markHistoryStoppingPoint('After resize')
    const after = structuredClone(shape())
    editor.undo(); expect(shape()).toEqual(before)
    editor.redo(); expect(shape()).toEqual(after)
    const restored = new Editor(editor.getSnapshot()), stored = restored.getShape<TLShape<'draw'>>(before.id)!
    const canonicalSegments = (shape: TLShape<'draw'>) => shape.props.segments!.map(segment => ({ ...segment, points: segment.points.map(({ x, y, pressure, z }) => ({ x, y, z: pressure ?? z })) }))
    expect(canonicalSegments(stored)).toEqual(canonicalSegments(after))
    const exported = await renderShapesToSvg(restored, [stored.id])
    expect((exported.svg.match(/<path /g) ?? []).length).toBe(2)
    for (const segment of stored.props.segments!) expect(exported.svg).toContain(inkOutlinePath(segment.points, getStrokeWidth(stored.props)))
    expect(exported.svg).not.toContain(inkOutlinePath(stored.props.points, getStrokeWidth(stored.props)))
  })

  it('bakes a native flip once and keeps duplicates as editable segmented ink', () => {
    const { editor, shape, element, apply } = setup()
    const before = structuredClone(shape()), native = element()
    const flipped = { ...native, scale: [-1, 1] as [number, number] }
    apply([flipped])
    const flippedShape = structuredClone(shape())
    expect(flippedShape.props.segments![0].points[0].x).toBeGreaterThan(flippedShape.props.segments![1].points[1].x)
    expect(sceneToEditorChanges(editor, [flipped]).updates).toEqual([])
    expect(element().scale).toEqual([1, 1])
    const updated = element(), duplicate = { ...updated, id: 'copy', x: updated.x + 300 }
    apply([updated, duplicate])
    expect(editor.getShape<TLShape<'draw'>>('copy')?.props.segments).toEqual(flippedShape.props.segments)
    expect(editor.getShape('copy')?.type).toBe('draw')
    expect(shape().props.segments).not.toEqual(before.props.segments)
  })

  it('leaves newly drawn and single-segment strokes as native freedraw elements', () => {
    const { editor, shape } = setup()
    const segment = shape().props.segments![0]
    editor.createShape({ id: 'single-segment', type: 'draw', props: { points: segment.points, segments: [segment], color: 'black', size: 's' } })
    editor.createShape({ id: 'modern-stroke', type: 'draw', props: { points: segment.points, color: 'black', size: 's' } })
    const scene = editorToExcalidrawScene(editor)
    expect(scene.elements.find(element => element.id === 'single-segment')?.type).toBe('freedraw')
    expect(scene.elements.find(element => element.id === 'modern-stroke')?.type).toBe('freedraw')
  })
})
