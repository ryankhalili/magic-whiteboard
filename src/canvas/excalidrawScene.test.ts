import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { Editor } from './editor'
import { editorToExcalidrawScene, getShapeForExcalidrawElement, LIVE_CONTENT_FILE_ID, sceneToEditorChanges } from './excalidrawScene'
import type { TLShape } from './types'

function apply(editor: Editor, elements: readonly ExcalidrawElement[]) {
  const changes = sceneToEditorChanges(editor, elements)
  editor.run(() => {
    editor.createAssets(changes.assets); editor.deleteShapes(changes.deletes)
    editor.createShapes(changes.creates); editor.updateShapes(changes.updates)
  })
  return changes
}

function renderedPoint(element: ExcalidrawElement, point: { x: number; y: number }) {
  let cx = element.width / 2, cy = element.height / 2
  if (element.type === 'freedraw') {
    const xs = element.points.map(p => p[0]), ys = element.points.map(p => p[1])
    cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2
  }
  const x = point.x - cx, y = point.y - cy
  return { x: element.x + cx + x * Math.cos(element.angle) - y * Math.sin(element.angle), y: element.y + cy + x * Math.sin(element.angle) + y * Math.cos(element.angle) }
}

describe('Excalidraw scene adapter', () => {
  it('preserves nested rotation pivots, parent opacity and existing shape metadata without dirtying history', () => {
    const editor = new Editor()
    editor.createShapes([
      { id: 'shape:outer', type: 'group', x: 70, y: 40, rotation: .4, opacity: .8 },
      { id: 'shape:inner', type: 'group', parentId: 'shape:outer', x: 50, y: -20, rotation: -.7, opacity: .6 },
      { id: 'shape:math', type: 'magic', parentId: 'shape:inner', x: 25, y: 15, rotation: .9, opacity: .5, meta: { application: 'preserved' }, props: { w: 200, h: 80, kind: 'math', latex: 'x^2' } },
    ])
    const shape = editor.getShape('shape:math')!, scene = editorToExcalidrawScene(editor)
    expect(scene.elements).toHaveLength(1)
    const element = scene.elements[0]
    expect(element.groupIds).toEqual(['shape:inner', 'shape:outer'])
    expect(element.opacity).toBeCloseTo(24)
    for (const point of [{ x: 0, y: 0 }, { x: 200, y: 80 }]) {
      const expected = editor.getShapePageTransform(shape).applyToPoint(point), actual = renderedPoint(element, point)
      expect(actual.x).toBeCloseTo(expected.x, 10); expect(actual.y).toBeCloseTo(expected.y, 10)
    }
    expect(sceneToEditorChanges(editor, scene.elements)).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
    expect(editorToExcalidrawScene(editor, scene.elements).elements[0]).toBe(element)
    expect(getShapeForExcalidrawElement(editor, element)?.meta).toEqual(shape.meta)
  })

  it('converts native group movement and resizing back into the correct parent space', () => {
    const editor = new Editor()
    editor.createShapes([
      { id: 'shape:group', type: 'group', x: 110, y: 90, rotation: .6, opacity: .5 },
      { id: 'shape:plot', type: 'magic', parentId: 'shape:group', x: 35, y: 20, rotation: -.2, props: { w: 200, h: 100, expression: 'cos(x)' } },
    ])
    const original = editorToExcalidrawScene(editor).elements[0]
    const moved = { ...original, x: original.x + 30, y: original.y - 40, width: 350, height: 160, angle: .9 as ExcalidrawElement['angle'] }
    apply(editor, [moved])
    const shape = editor.getShape<TLShape<'magic'>>('shape:plot')!
    expect(shape.parentId).toBe('shape:group'); expect(shape.opacity).toBe(1)
    expect(shape.rotation).toBeCloseTo(.3); expect(shape.props).toMatchObject({ w: 350, h: 160, expression: 'cos(x)' })
    const after = editorToExcalidrawScene(editor).elements[0]
    expect(after.x).toBeCloseTo(moved.x); expect(after.y).toBeCloseTo(moved.y); expect(after.angle).toBeCloseTo(moved.angle)
    expect(sceneToEditorChanges(editor, [after]).updates).toEqual([])
  })

  it('preserves native ink pressure and points when the stroke extends left and above its first sample', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:ink', type: 'draw', x: 30, y: 50, rotation: .8, props: { points: [{ x: 12, y: 23, z: .1 }, { x: -40, y: -50, z: .9 }, { x: 20, y: 10, pressure: .7 }], color: 'blue', size: 'l', w: 65, h: 80 } })
    const shape = editor.getShape<TLShape<'draw'>>('shape:ink')!
    const element = editorToExcalidrawScene(editor).elements[0] as ExcalidrawFreeDrawElement
    expect(element.points).toEqual([[0, 0], [-52, -73], [8, -13]])
    expect(element.pressures).toEqual([.1, .9, .7]); expect(element.simulatePressure).toBe(false)
    for (const [index, point] of shape.props.points.entries()) {
      const expected = editor.getShapePageTransform(shape).applyToPoint(point)
      const actual = renderedPoint(element, { x: element.points[index][0], y: element.points[index][1] })
      expect(actual.x).toBeCloseTo(expected.x, 10); expect(actual.y).toBeCloseTo(expected.y, 10)
    }
    expect(sceneToEditorChanges(editor, [element]).updates).toEqual([])
    apply(editor, [{ ...element, x: element.x + 20, y: element.y - 15 }])
    const moved = editor.getShape<TLShape<'draw'>>('shape:ink')!
    expect(moved.x).toBeCloseTo(shape.x + 20); expect(moved.y).toBeCloseTo(shape.y - 15)
    expect(moved.props.points).toEqual(shape.props.points)
  })

  it('duplicates editable magic objects with their source while creating a distinct page object', () => {
    const editor = new Editor()
    editor.createShapes([
      { id: 'shape:group', type: 'group', x: 50, y: 80, rotation: .4 },
      { id: 'shape:math', type: 'magic', parentId: 'shape:group', x: 20, y: 25, props: { kind: 'math', latex: '\\frac{x}{2}' } },
    ])
    const original = editorToExcalidrawScene(editor).elements[0]
    const duplicate = { ...original, id: 'duplicated-id', x: original.x + 70, groupIds: ['new-native-group'] }
    apply(editor, [original, duplicate])
    const shape = editor.getShape<TLShape<'magic'>>('duplicated-id')!
    expect(shape.parentId).toBe(editor.getCurrentPageId()); expect(shape.props.latex).toBe('\\frac{x}{2}')
    expect(shape.meta.excalidrawGroupIds).toEqual(['new-native-group'])
    const copy = editorToExcalidrawScene(new Editor(editor.getSnapshot())).elements.find(element => element.id === shape.id)!
    expect(copy.x).toBeCloseTo(duplicate.x); expect(copy.y).toBeCloseTo(duplicate.y)
    expect(copy.groupIds).toEqual(['new-native-group'])
  })

  it('ungroups legacy leaves without changing their world appearance', () => {
    const editor = new Editor()
    editor.createShapes([{ id: 'shape:group', type: 'group', x: 90, y: 60, rotation: .3 }, { id: 'shape:child', type: 'magic', parentId: 'shape:group', x: 10, y: 20 }])
    const element = editorToExcalidrawScene(editor).elements[0]
    apply(editor, [{ ...element, groupIds: [] }])
    expect(editor.getShape('shape:child')?.parentId).toBe(editor.getCurrentPageId())
    const after = editorToExcalidrawScene(editor).elements[0]
    expect(after.x).toBeCloseTo(element.x); expect(after.y).toBeCloseTo(element.y); expect(after.angle).toBeCloseTo(element.angle)
  })

  it('persists stacking changes for legacy groups as well as their leaf elements', () => {
    const editor = new Editor()
    editor.createShapes([
      { id: 'shape:group', type: 'group' },
      { id: 'shape:child', type: 'magic', parentId: 'shape:group' },
      { id: 'shape:outside', type: 'magic' },
    ])
    const [child, outside] = editorToExcalidrawScene(editor).elements
    apply(editor, [outside, child])
    expect(editorToExcalidrawScene(editor).elements.map(element => element.id)).toEqual(['shape:outside', 'shape:child'])
  })

  it('keeps reorder diffs immutable so undo restores the original stacking order', () => {
    const editor = new Editor()
    editor.createShapes([{ id: 'shape:a', type: 'magic' }, { id: 'shape:b', type: 'magic' }, { id: 'shape:c', type: 'magic' }])
    editor.markHistoryStoppingPoint('Before reorder')
    const originalRecords = editor.getCurrentPageShapesSorted()
    originalRecords.forEach(Object.freeze)
    const scene = editorToExcalidrawScene(editor)
    const changed = [scene.elements[2], scene.elements[0], scene.elements[1]]
    const changes = sceneToEditorChanges(editor, changed)
    expect(originalRecords.map(shape => shape.index)).toEqual([1, 2, 3])
    expect(changes.updates).toHaveLength(3)
    apply(editor, changed)
    editor.markHistoryStoppingPoint('After reorder')
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:c', 'shape:a', 'shape:b'])
    editor.undo()
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:a', 'shape:b', 'shape:c'])
    editor.redo()
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:c', 'shape:a', 'shape:b'])
  })

  it('imports duplicates in their native position without adding a second history edit', () => {
    const editor = new Editor()
    editor.createShapes([{ id: 'shape:a', type: 'magic' }, { id: 'shape:b', type: 'magic' }])
    const [a, b] = editorToExcalidrawScene(editor).elements
    const duplicate = { ...a, id: 'duplicate', x: a.x + 20, y: a.y + 20 }
    editor.markHistoryStoppingPoint('Before duplicate')
    apply(editor, [a, duplicate, b])
    editor.markHistoryStoppingPoint('After duplicate')
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:a', 'duplicate', 'shape:b'])
    // Native image decoding, selection, or file availability can emit another onChange.
    expect(sceneToEditorChanges(editor, [a, duplicate, b])).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
    const rendered = { id: 'render:duplicate' as BinaryFileData['id'], dataURL: 'data:image/png;base64,new' as BinaryFileData['dataURL'], mimeType: 'image/png', created: 2 } as BinaryFileData
    const scene = editorToExcalidrawScene(editor, [a, duplicate, b], new Map([['duplicate', rendered]]))
    expect(sceneToEditorChanges(editor, scene.elements, scene.files).updates).toEqual([])
    editor.undo()
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:a', 'shape:b'])
    editor.redo()
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual(['shape:a', 'duplicate', 'shape:b'])
  })

  it('imports new native strokes and persists pressure, deletion and stacking order', () => {
    const editor = new Editor()
    editor.createShapes([{ id: 'shape:a', type: 'magic' }, { id: 'shape:b', type: 'magic' }])
    const scene = editorToExcalidrawScene(editor), template = scene.elements[0]
    const native = { ...template, id: 'native-ink', type: 'freedraw', strokeWidth: 3, x: 400, y: 100, width: 90, height: 20, points: [[0, 0], [90, 20]], pressures: [.2, .8], simulatePressure: false, lastCommittedPoint: null, customData: undefined, link: null } as unknown as ExcalidrawFreeDrawElement
    apply(editor, [...scene.elements, native])
    expect(editor.getShape<TLShape<'draw'>>('native-ink')?.props.points).toEqual([{ x: 0, y: 0, z: .2 }, { x: 90, y: 20, z: .8 }])
    const next = editorToExcalidrawScene(editor).elements
    const previous = editor.getShape('shape:a')!
    const changes = sceneToEditorChanges(editor, [next[2], next[1], next[0]])
    expect(editor.getShape('shape:a')).toBe(previous); expect(previous.index).toBe(1)
    expect(changes.updates).toHaveLength(2)
    apply(editor, [next[2], next[1], next[0]])
    expect(editorToExcalidrawScene(editor).elements.map(element => element.id)).toEqual(['native-ink', 'shape:b', 'shape:a'])
    apply(editor, [next[2], { ...next[1], isDeleted: true }, next[0]])
    expect(editor.getShape('shape:b')).toBeUndefined()
  })

  it('does not lose locked images or their asset data when the native scene omits them', () => {
    const editor = new Editor()
    editor.createAssets([{ id: 'asset:worksheet', typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,abc', mimeType: 'image/png', w: 200, h: 300 } }])
    editor.createShape({ id: 'shape:worksheet', type: 'image', isLocked: true, props: { assetId: 'asset:worksheet', w: 200, h: 300 } })
    const scene = editorToExcalidrawScene(editor)
    expect(scene.files['asset:worksheet'].dataURL).toBe('data:image/png;base64,abc')
    expect(scene.elements[0].locked).toBe(true); expect(sceneToEditorChanges(editor, []).deletes).toEqual([])
  })

  it('keeps live-content proxy files out of notebook assets', () => {
    const editor = new Editor()
    editor.createShape({ type: 'magic', props: { kind: 'math', latex: 'x^2' } })
    const scene = editorToExcalidrawScene(editor)
    expect(scene.elements[0]).toMatchObject({ type: 'image', fileId: LIVE_CONTENT_FILE_ID })
    expect(scene.files[LIVE_CONTENT_FILE_ID].mimeType).toBe('image/svg+xml')
    expect(atob(scene.files[LIVE_CONTENT_FILE_ID].dataURL.split(',')[1])).toContain('<svg')
    expect(sceneToEditorChanges(editor, scene.elements, scene.files).assets).toEqual([])
    expect(editor.store.allRecords().filter(record => record.typeName === 'asset')).toEqual([])
  })

  it('uses completed custom renders as native image files while retaining editable source', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:math', type: 'magic', props: { kind: 'math', latex: 'x^2' } })
    editor.createShape({ id: 'shape:unrendered', type: 'magic', props: { kind: 'plot', expression: 'sin(x)' } })
    const file = { id: 'render:math:1', mimeType: 'image/png', dataURL: 'data:image/png;base64,render', created: 123 } as BinaryFileData
    const rendered = new Map([['shape:math', file]]), scene = editorToExcalidrawScene(editor, [], rendered)
    expect(scene.elements[0]).toMatchObject({ type: 'image', fileId: file.id, customData: { magicWhiteboard: { shape: { type: 'magic', props: { latex: 'x^2' } } } } })
    expect(scene.files[file.id]).toBe(file)
    expect(scene.files[LIVE_CONTENT_FILE_ID]).toBeDefined()
    expect(sceneToEditorChanges(editor, scene.elements, scene.files)).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
    expect(editorToExcalidrawScene(editor, scene.elements, rendered).elements[0]).toBe(scene.elements[0])
    const replacement = { ...file, id: 'render:math:2' as BinaryFileData['id'], dataURL: 'data:image/png;base64,new' as BinaryFileData['dataURL'] }
    const updated = editorToExcalidrawScene(editor, scene.elements, new Map([['shape:math', replacement]]))
    expect(updated.elements[0]).toMatchObject({ fileId: replacement.id, version: scene.elements[0].version + 1 })
    expect(sceneToEditorChanges(editor, updated.elements, updated.files).updates).toEqual([])
  })

  it('rejects unsupported native clipboard arrowheads and text before changing the notebook', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:template', type: 'magic' })
    const template = editorToExcalidrawScene(editor).elements[0]
    const arrow = { ...template, id: 'native-arrow', type: 'arrow', customData: undefined, width: 100, height: 25, strokeWidth: 3, points: [[0, 0], [100, 25]], startArrowhead: null, endArrowhead: 'arrow', startBinding: null, endBinding: null, lastCommittedPoint: null, elbowed: false } as unknown as ExcalidrawElement
    const text = { ...template, id: 'native-text', type: 'text', customData: undefined, width: 120, height: 24, text: 'Pasted notes', originalText: 'Pasted notes', fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.2 } as unknown as ExcalidrawElement
    const before = editor.getSnapshot()
    expect(() => apply(editor, [template, arrow, text])).toThrow('Nothing was added')
    expect(editor.getSnapshot()).toEqual(before)
  })
})
