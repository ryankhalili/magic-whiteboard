import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { Editor, type TLShape } from '../src/canvas/editor'
import { editorToExcalidrawScene, sceneToEditorChanges } from '../src/canvas/excalidrawScene'
import { createBoardController } from '../src/board/controller'
import { parseProjectFile } from '../src/files/boardFiles'
import { DEFAULT_SETTINGS, type BoardContext } from '../shared/board'

const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

function workspace(editor = new Editor()) {
  const controller = createBoardController(editor, (): BoardContext => ({
    focus: null, focusMode: 'reference', pointer: { x: 500, y: 400 },
    selectedIds: editor.getSelectedShapeIds(), lastCreatedIds: controller.lastCreatedIds,
    objects: controller.getObjects(), viewport: editor.getViewportPageBounds(),
  }))
  return { editor, controller }
}

function applyNativeScene(
  editor: Editor,
  elements: Parameters<typeof sceneToEditorChanges>[1],
  files: Parameters<typeof sceneToEditorChanges>[2] = {},
) {
  const changes = sceneToEditorChanges(editor, elements, files)
  editor.markHistoryStoppingPoint('Native Excalidraw interaction')
  editor.run(() => {
    editor.createAssets(changes.assets)
    editor.deleteShapes(changes.deletes)
    editor.createShapes(changes.creates)
    editor.updateShapes(changes.updates)
  })
  editor.markHistoryStoppingPoint('After native Excalidraw interaction')
  return changes
}

/** A native stroke has no application metadata until its first scene import. */
function nativeInk(): ExcalidrawElement {
  const seed = new Editor()
  seed.createShape({
    id: 'shape:seed', type: 'draw', x: 140, y: 180,
    props: {
      points: [{ x: 0, y: 0, pressure: .2 }, { x: 20, y: 30, pressure: .8 }, { x: 70, y: 15, pressure: .4 }],
      color: '#2563eb', size: 'm', strokeWidth: 3.5, w: 70, h: 30,
    },
  })
  const element = editorToExcalidrawScene(seed).elements[0]
  expect(element.type).toBe('freedraw')
  return { ...element, id: 'native-ink', customData: undefined }
}

function addBackground(editor: Editor) {
  editor.createAssets([{
    id: 'asset:homework', typeName: 'asset', type: 'image', meta: {},
    props: { src: imageData, name: 'Homework.png', w: 1, h: 1, mimeType: 'image/png', isAnimated: false },
  }])
  editor.createShape({
    id: 'shape:homework', type: 'image', x: 0, y: 0, isLocked: true,
    props: { assetId: 'asset:homework', w: 794, h: 1123, altText: 'Homework' },
    meta: { marginaliaBackground: true },
  })
  editor.markHistoryStoppingPoint('Background loaded')
}

function pose(element: ExcalidrawElement) {
  return { x: element.x, y: element.y, width: element.width, height: element.height, angle: element.angle }
}

function expectPose(actual: ReturnType<typeof pose>, expected: ReturnType<typeof pose>) {
  for (const property of ['x', 'y', 'width', 'height', 'angle'] as const) {
    expect(actual[property]).toBeCloseTo(expected[property], 10)
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Excalidraw and application workflows', () => {
  it('keeps native handwriting available to AI targeting and one-step delete undo/redo', () => {
    const { editor, controller } = workspace()
    applyNativeScene(editor, [nativeInk()])
    const stroke = structuredClone(editor.getShape<TLShape<'draw'>>('native-ink')!)
    expect(stroke.type).toBe('draw')
    expect(stroke.props.points).toHaveLength(3)
    expect(controller.getObjects()).toEqual([expect.objectContaining({ id: stroke.id, kind: 'draw' })])

    editor.select(stroke.id)
    expect(controller.applyOperations([{ type: 'delete_objects', target: 'selected' }]).ok).toBe(true)
    expect(editorToExcalidrawScene(editor).elements).toHaveLength(0)
    controller.applyOperations([{ type: 'undo' }])
    expect(editor.getShape(stroke.id)).toEqual(stroke)
    const restored = editorToExcalidrawScene(editor).elements[0]
    expect(restored).toMatchObject({ id: stroke.id, type: 'freedraw', strokeColor: '#2563eb' })
    controller.applyOperations([{ type: 'redo' }])
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    controller.applyOperations([{ type: 'undo' }])
    controller.applyOperations([{ type: 'undo' }])
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
    controller.applyOperations([{ type: 'redo' }])
    expect(editor.getShape(stroke.id)).toEqual(stroke)
  })

  it('preserves a graph’s native resize and rotation through AI content edits and reload', () => {
    const { editor, controller } = workspace()
    const created = controller.applyOperations([{
      type: 'create_plot', expression: 'sin(x)', axisMode: 'equal',
      bounds: { x: 100, y: 120, w: 440, h: 320 }, xMin: -4, xMax: 4,
    }])
    expect(created.ok).toBe(true)
    const id = created.ids[0]
    const initial = editorToExcalidrawScene(editor)
    const changed = initial.elements.map(element => ({
      ...element, x: 275, y: 85, width: 600, height: 260, angle: Math.PI / 3,
      version: element.version + 1,
    }))
    applyNativeScene(editor, changed, initial.files)
    const moved = structuredClone(editor.getShape<TLShape<'magic'>>(id)!)
    const beforeAI = pose(editorToExcalidrawScene(editor).elements[0])
    expect(beforeAI).toEqual(expect.objectContaining({ width: 600, height: 260 }))
    expect(beforeAI.x).toBeCloseTo(275)
    expect(beforeAI.y).toBeCloseTo(85)
    expect(beforeAI.angle).toBeCloseTo(Math.PI / 3)

    editor.select(id)
    expect(controller.applyOperations([{ type: 'update_object', target: 'selected', expression: 'cos(x)', xMin: 0, xMax: 8 }]).ok).toBe(true)
    const edited = editor.getShape<TLShape<'magic'>>(id)!
    expect(edited).toMatchObject({ id, props: { expression: 'cos(x)', w: 600, h: 260 }, meta: { axisMode: 'equal' } })
    expect(edited.x).toBeCloseTo(moved.x, 10)
    expect(edited.y).toBeCloseTo(moved.y, 10)
    expect(edited.rotation).toBeCloseTo(moved.rotation, 10)
    expectPose(pose(editorToExcalidrawScene(editor).elements[0]), beforeAI)
    editor.undo()
    expect(editor.getShape(id)).toEqual(moved)
    editor.redo()

    const reloaded = workspace(new Editor(editor.getSnapshot()))
    expect(reloaded.controller.getObjects()[0]).toMatchObject({ id, expression: 'cos(x)', xMin: 0, xMax: 8, axisMode: 'equal' })
    expectPose(pose(editorToExcalidrawScene(reloaded.editor).elements[0]), beforeAI)
    expect(reloaded.controller.applyOperations([{ type: 'edit_content', target: id, field: 'expression', find: 'cos', replace: 'sin' }]).ok).toBe(true)
    expect(reloaded.editor.getShape<TLShape<'magic'>>(id)!.props.expression).toBe('sin(x)')
  })

  it('protects the homework background from native erase and AI delete while preserving its bytes', () => {
    const { editor, controller } = workspace()
    addBackground(editor)
    const scene = editorToExcalidrawScene(editor)
    applyNativeScene(editor, [...scene.elements, nativeInk()], scene.files)
    const withInk = editorToExcalidrawScene(editor)
    applyNativeScene(editor, withInk.elements.map(element => ({ ...element, isDeleted: true })), withInk.files)
    expect(editor.getCurrentPageShapes().map(shape => shape.id)).toEqual(['shape:homework'])
    expect(controller.applyOperations([{ type: 'delete_objects', target: 'shape:homework' }]).ok).toBe(false)
    expect(editor.getAsset('asset:homework')!.props.src).toBe(imageData)
    editor.undo()
    expect(editor.getShape('native-ink')).toBeDefined()

    editor.markHistoryStoppingPoint('Remove background explicitly')
    editor.run(() => editor.deleteShapes(['shape:homework']), { ignoreShapeLock: true })
    editor.markHistoryStoppingPoint('After removing background')
    expect(editor.getShape('shape:homework')).toBeUndefined()
    editor.undo()
    expect(editor.getShape('shape:homework')).toMatchObject({ isLocked: true, meta: { marginaliaBackground: true } })
    const reopened = new Editor(editor.getSnapshot())
    expect(reopened.getAsset('asset:homework')!.props.src).toBe(imageData)
    expect(editorToExcalidrawScene(reopened).elements.find(element => element.id === 'shape:homework')).toMatchObject({ type: 'image', locked: true })
  })

  it('keeps notebook sources and images editable after native changes, device saves, and project import', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.resetModules()
    const backups = await import('../src/notebooks/canvasBackup')
    const { editor, controller } = workspace()
    addBackground(editor)
    const created = controller.applyOperations([
      { type: 'create_math', latex: '\\frac{x^2}{2} + C', bounds: { x: 80, y: 100, w: 360, h: 120 } },
      { type: 'create_text', text: 'Differentiate the answer.\nKeep the constant.', bounds: { x: 80, y: 300, w: 400, h: 160 } },
    ])
    expect(created.ok).toBe(true)
    const [mathId, textId] = created.ids
    editor.updateShape({ id: mathId, type: 'magic', meta: { literalBounds: { x: 20, y: 20, w: 700, h: 600 } } })
    const scene = editorToExcalidrawScene(editor)
    applyNativeScene(editor, scene.elements.map(element => element.id === mathId
      ? { ...element, x: element.x + 70, y: element.y + 35, version: element.version + 1 }
      : element), scene.files)
    editor.setCamera({ x: -75, y: 35, z: .75 }).select(mathId)
    await backups.saveNotebookSnapshot('excalidraw-algebra', editor.getSnapshot())

    const second = workspace()
    second.controller.applyOperations([{ type: 'create_text', text: 'Independent notebook' }])
    await backups.saveNotebookSnapshot('excalidraw-biology', second.editor.getSnapshot())
    // Reload the module so the next read cannot use its saved in-memory checkpoint.
    vi.resetModules()
    const freshBackups = await import('../src/notebooks/canvasBackup')
    const saved = await freshBackups.loadNotebookSnapshot('excalidraw-algebra')
    const reopened = new Editor(saved)
    expect(reopened.getCamera()).toEqual({ x: -75, y: 35, z: .75 })
    expect(reopened.getSelectedShapeIds()).toEqual([mathId])
    expect(reopened.getShape<TLShape<'magic'>>(mathId)).toMatchObject({ props: { latex: '\\frac{x^2}{2} + C' }, meta: { literalBounds: { x: 20, y: 20, w: 700, h: 600 } } })
    expect(reopened.getShape<TLShape<'magic'>>(textId)!.props.text).toBe('Differentiate the answer.\nKeep the constant.')
    const otherNotebook = workspace(new Editor(await freshBackups.loadNotebookSnapshot('excalidraw-biology')))
    expect(otherNotebook.controller.getObjects()).toEqual([expect.objectContaining({ text: 'Independent notebook' })])

    const settings = { ...DEFAULT_SETTINGS, name: 'Algebra', mode: 'page' as const, paper: 'grid' as const, focusMode: 'literal' as const }
    const project = parseProjectFile(JSON.stringify({ format: 'marginalia', version: 1, settings, snapshot: reopened.getSnapshot() }))
    expect(project.settings).toEqual(settings)
    const imported = workspace(new Editor(project.snapshot))
    expect(imported.editor.getAsset('asset:homework')!.props.src).toBe(imageData)
    expect(imported.controller.applyOperations([{ type: 'edit_content', target: mathId, field: 'latex', find: 'C', replace: '7' }]).ok).toBe(true)
    expect(imported.editor.getShape<TLShape<'magic'>>(mathId)!.props.latex).toBe('\\frac{x^2}{2} + 7')
    expect(editorToExcalidrawScene(imported.editor).elements.map(element => element.id)).toEqual(reopened.getCurrentPageShapesSorted().map(shape => shape.id))
  })
})
