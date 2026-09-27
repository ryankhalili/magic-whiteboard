import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types'
import { Editor, type TLShape, type TLShapeId } from '../src/canvas/editor'
import { normalizeSnapshot } from '../src/canvas/migration'
import { editorToExcalidrawScene, sceneToEditorChanges } from '../src/canvas/excalidrawScene'
import { createBoardController, focusImageBounds, libraryAssetId, libraryImageSize } from '../src/board/controller'
import { insertGeneratedImage } from '../src/images/insertGeneratedImage'
import { loadProject, MAX_PROJECT_BYTES, projectFileBlob } from '../src/files/boardFiles'
import { assetChars } from '../src/files/pdfPages'
import { DEFAULT_SETTINGS, type BoardContext, type BoardOperation, type Bounds } from '../shared/board'
import { generatedPng } from './fixtures/generated-image'

const BOOK = 'sha256:' + 'b'.repeat(64)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const jpeg = (chars: number, fill = 'A') => `data:image/jpeg;base64,${fill.repeat(chars)}`

function setup(extra: Partial<BoardContext> = {}) {
  const editor = new Editor()
  const context: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [], ...extra }
  const controller = createBoardController(editor, () => ({ ...context, selectedIds: editor.getSelectedShapeIds() }))
  return { editor, controller, context }
}
const assetIds = (editor: Editor) => editor.store.allRecords().filter(record => record.typeName === 'asset').map(record => record.id).sort()
const snapshotAssets = (editor: Editor) => Object.values(editor.getSnapshot().document.store).filter(record => record.typeName === 'asset').map(record => record.id).sort()
const order = (editor: Editor) => editor.getCurrentPageShapesSorted().map(shape => shape.id)

function pageOp(index: number, bounds: Bounds, src = jpeg(40)): BoardOperation {
  return {
    type: 'create_image', image: { src, w: 1391, h: 1800, mimeType: 'image/jpeg', name: `Calculus, page ${index}` }, bounds, locked: true,
    meta: { assetKey: `${BOOK}#${index}:page`, library: { bookId: BOOK, title: 'Calculus', pageIndex: index, pageLabel: String(index - 7), kind: 'page' } },
  }
}
function itemOp(key: string, bounds: Bounds, src: string = PNG): BoardOperation {
  return {
    type: 'create_image', image: { src, w: 1400, h: 394, mimeType: src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', name: `Example ${key}` }, bounds,
    meta: { assetKey: `${BOOK}#199:example:${key}:item`, library: { bookId: BOOK, title: 'Calculus', pageIndex: 199, pageLabel: '191', kind: 'item', itemKind: 'example', itemLabel: key, workBelow: 300 } },
  }
}
const removeLocked = (editor: Editor, ids: string[]) => editor.run(() => editor.deleteShapes(ids as TLShapeId[]), { ignoreShapeLock: true })

// the same steps WhiteboardCanvas.ingest runs for a native Excalidraw change
function ingest(editor: Editor, elements: readonly ExcalidrawElement[], files: BinaryFiles = {}) {
  const changes = sceneToEditorChanges(editor, elements, files)
  editor.markHistoryStoppingPoint('Native change')
  editor.run(() => {
    if (changes.assets.length) editor.createAssets(changes.assets)
    if (changes.creates.length) editor.createShapes(changes.creates)
    if (changes.updates.length) editor.updateShapes(changes.updates)
    if (changes.deletes.length) editor.deleteShapes(changes.deletes)
  })
  editor.markHistoryStoppingPoint('After native change')
  return changes
}
const file = (id: string, dataURL: string) => ({ id, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(';')), created: 1 }) as unknown as BinaryFileData

afterEach(() => vi.restoreAllMocks())

describe('images of deleted objects', () => {
  it('never fill up an empty notebook: 200 page inserts and deletes all succeed', () => {
    const { editor, controller } = setup()
    const big = jpeg(500_000)
    for (let i = 0; i < 200; i++) {
      const result = i % 2 ? controller.applyOperations([itemOp(`p${i}`, { x: 100, y: 100, w: 640, h: 180 }, big)]) : controller.applyOperations([pageOp(i, { x: 100, y: 100, w: 700, h: 906 }, big)])
      expect(result.ok, `insert ${i}: ${result.message}`).toBe(true)
      removeLocked(editor, result.ids)
      expect(editor.getCurrentPageShapes()).toHaveLength(0)
      // at most the image of the object just deleted waits for the next insert
      expect(assetIds(editor).length).toBeLessThanOrEqual(1)
    }
    expect(snapshotAssets(editor)).toEqual([])
    expect(() => normalizeSnapshot(editor.getSnapshot())).not.toThrow()
  })

  it('count only images still in use toward the notebook limit', () => {
    const editor = new Editor()
    const add = (id: string) => editor.run(() => {
      editor.createAssets([{ id, typeName: 'asset', type: 'image', meta: {}, props: { src: jpeg(30_000_000), w: 10, h: 10 } }])
      editor.createShape({ id: `shape:${id.slice(6)}`, type: 'image', props: { assetId: id, w: 100, h: 100 } })
    })
    add('asset:one')
    expect(() => add('asset:two')).toThrow('no room for more images')
    expect(assetIds(editor)).toEqual(['asset:one'])
    editor.deleteShapes(['shape:one'])
    add('asset:two')
    expect(assetIds(editor)).toEqual(['asset:two'])
  })

  it('leave room for a board PDF import once their objects are gone', () => {
    const { editor, controller } = setup()
    const page = controller.applyOperations([pageOp(30, { x: 0, y: 0, w: 700, h: 906 }, jpeg(400_000))])
    expect(assetChars(editor)).toBeGreaterThanOrEqual(400_000)
    removeLocked(editor, page.ids)
    // the record waits for the next image, but it no longer takes room
    expect(assetIds(editor)).toHaveLength(1)
    expect(assetChars(editor)).toBe(0)
    editor.undo()
    expect(assetChars(editor)).toBeGreaterThanOrEqual(400_000)
  })

  it('keeps a new image that no object uses yet, and counts it', () => {
    const editor = new Editor()
    editor.createAssets([{ id: 'asset:a', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
    editor.createAssets([{ id: 'asset:b', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
    editor.createShape({ id: 'shape:a', type: 'image', props: { assetId: 'asset:a', w: 10, h: 10 } })
    editor.createShape({ id: 'shape:b', type: 'image', props: { assetId: 'asset:b', w: 10, h: 10 } })
    expect(assetIds(editor)).toEqual(['asset:a', 'asset:b'])
    expect(editorToExcalidrawScene(editor).files['asset:a'].dataURL).toBe(PNG)
  })

  it('come back with their pixels on undo, and go again on redo', () => {
    const { editor, controller } = setup()
    const page = controller.applyOperations([pageOp(30, { x: 0, y: 0, w: 700, h: 906 })])
    const pageAsset = libraryAssetId(`${BOOK}#30:page`)
    editor.markHistoryStoppingPoint('before delete')
    removeLocked(editor, page.ids)
    editor.markHistoryStoppingPoint('after delete')
    expect(controller.applyOperations([itemOp('3.2', { x: 900, y: 0, w: 640, h: 180 })]).ok).toBe(true)
    expect(editor.getAsset(pageAsset)).toBeUndefined()
    editor.undo()
    expect(editor.getAsset(pageAsset)?.props.src).toBe(jpeg(40))
    editor.undo()
    expect(order(editor)).toEqual(page.ids)
    expect(editorToExcalidrawScene(editor).files[pageAsset].dataURL).toBe(jpeg(40))
    editor.redo(); editor.redo()
    expect(editor.getAsset(pageAsset)).toBeUndefined()
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(() => new Editor(normalizeSnapshot(editor.getSnapshot()))).not.toThrow()
  })

  it('stay out of saved notebooks and project files, which reopen', async () => {
    const { editor, controller } = setup()
    const kept = controller.applyOperations([itemOp('1', { x: 0, y: 0, w: 640, h: 180 })])
    const gone = controller.applyOperations([itemOp('2', { x: 0, y: 700, w: 640, h: 180 }, jpeg(80, 'B'))])
    editor.deleteShapes(gone.ids as TLShapeId[])
    expect(assetIds(editor)).toHaveLength(2)
    expect(snapshotAssets(editor)).toEqual([libraryAssetId(`${BOOK}#199:example:1:item`)])
    const blob = projectFileBlob(editor, DEFAULT_SETTINGS)
    expect(await blob.text()).not.toContain(jpeg(80, 'B'))
    const reopened = new Editor()
    await loadProject(reopened, new File([blob], 'lesson.marginalia.json'))
    expect(reopened.getCurrentPageShapes().map(shape => shape.id)).toEqual(kept.ids)
    expect(assetIds(reopened)).toEqual(snapshotAssets(editor))
  })

  it('does not disturb confirmed image generation, including undo and a repeated job', () => {
    const { editor, controller } = setup()
    const page = controller.applyOperations([pageOp(40, { x: 0, y: 0, w: 700, h: 906 })])
    removeLocked(editor, page.ids)
    const image = generatedPng()
    const id = insertGeneratedImage(editor, 'job-assets-1', image, { x: 50, y: 60, w: 300, h: 300 }, 'A leaf')
    const shape = editor.getShape(id)!
    if (shape.type !== 'image') throw new Error('expected an image')
    expect(editor.getAsset(shape.props.assetId)?.props.src).toBe(image.dataUrl)
    expect(editor.getAsset(libraryAssetId(`${BOOK}#40:page`))).toBeUndefined()
    expect(insertGeneratedImage(editor, 'job-assets-1', image, { x: 50, y: 60, w: 300, h: 300 }, 'A leaf')).toBe(id)
    editor.undo()
    expect(editor.getShape(id)).toBeUndefined()
    editor.redo()
    expect(editor.getAsset((editor.getShape(id) as TLShape<'image'>).props.assetId)?.props.src).toBe(image.dataUrl)
    const restored = new Editor(normalizeSnapshot(editor.getSnapshot()))
    expect(insertGeneratedImage(restored, 'job-assets-1', image, { x: 50, y: 60, w: 300, h: 300 }, 'A leaf')).toBe(id)
  })

  it('does not disturb native pasted images, even a cut image pasted back with a new one', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:math', type: 'magic', props: { kind: 'math', latex: 'x' } })
    const template = editorToExcalidrawScene(editor).elements[0]
    const pasted = (id: string, fileId: string) => ({ ...template, id, type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null, customData: undefined, x: 300, y: 40, width: 120, height: 90 }) as unknown as ExcalidrawElement
    const one = pasted('native-one', 'file-one'), two = pasted('native-two', 'file-two')
    const files = { 'file-one': file('file-one', PNG), 'file-two': file('file-two', jpeg(60, 'C')) } as BinaryFiles
    ingest(editor, [template, one], files)
    expect(editor.getAsset('file-one')?.props.src).toBe(PNG)
    // cut: the object goes, the native scene keeps the file
    ingest(editor, [template], files)
    expect(editor.getShape('native-one')).toBeUndefined()
    // paste it back together with a new image in one change: both keep their pixels
    const changes = ingest(editor, [template, { ...one, id: 'native-one-copy' }, two], files)
    expect(changes.assets.map(asset => asset.id)).toEqual(['file-two'])
    for (const [shapeId, src] of [['native-one-copy', PNG], ['native-two', jpeg(60, 'C')]] as const) {
      const shape = editor.getShape(shapeId) as TLShape<'image'>
      expect(editor.getAsset(shape.props.assetId)?.props.src).toBe(src)
    }
    expect(() => normalizeSnapshot(editor.getSnapshot())).not.toThrow()
    editor.undo()
    expect(editor.getShape('native-two')).toBeUndefined()
    expect(editor.getAsset('file-one')?.props.src).toBe(PNG)
  })
})

describe('project files', () => {
  it('reopen at the size the notebook allows for images', async () => {
    const editor = new Editor()
    editor.run(() => {
      editor.createAssets([{ id: 'asset:full', typeName: 'asset', type: 'image', meta: {}, props: { src: jpeg(55_900_000), w: 10, h: 10 } }])
      editor.createShape({ id: 'shape:full', type: 'image', props: { assetId: 'asset:full', w: 100, h: 100 } })
    })
    const blob = projectFileBlob(editor, DEFAULT_SETTINGS)
    expect(blob.size).toBeGreaterThan(40 * 1024 * 1024)
    expect(blob.size).toBeLessThanOrEqual(MAX_PROJECT_BYTES)
    const reopened = new Editor()
    await loadProject(reopened, new File([blob], 'full.marginalia.json'))
    expect(reopened.getShape('shape:full')).toBeDefined()
  })

  it('refuses to save a file that could not be opened again, with the same limit', async () => {
    const editor = new Editor()
    vi.spyOn(Blob.prototype, 'size', 'get').mockReturnValue(MAX_PROJECT_BYTES + 1)
    expect(() => projectFileBlob(editor, DEFAULT_SETTINGS)).toThrow('too large to save')
    vi.restoreAllMocks()
    await expect(loadProject(editor, { size: MAX_PROJECT_BYTES + 1, text: async () => '{}' } as File)).rejects.toThrow('smaller than 64 MB')
  })
})

describe('library pages through the Excalidraw adapter', () => {
  function board() {
    const env = setup()
    const { editor } = env
    editor.createAssets([{ id: 'asset:sheet', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
    editor.run(() => editor.createShapes([
      { id: 'shape:sheet', type: 'image', x: -900, y: 0, isLocked: true, props: { assetId: 'asset:sheet', w: 816, h: 1056 }, meta: { marginaliaBackground: true } },
      { id: 'shape:ink', type: 'draw', props: { points: [{ x: 300, y: 300 }, { x: 380, y: 340 }], color: 'blue', size: 'm' } },
      { id: 'shape:math', type: 'magic', x: 420, y: 520, props: { kind: 'math', latex: 'x^2', w: 200, h: 80 } },
    ]), { ignoreShapeLock: true })
    editor.markHistoryStoppingPoint('board ready')
    return env
  }
  // the teacher tapped near the ink earlier; that focus places the page right over it
  const atFocus = (index: number) => {
    const size = libraryImageSize({ w: 1391, h: 1800 }, 'page')
    const bounds = focusImageBounds(size, { focus: { kind: 'point', bounds: { x: 260, y: 280, w: 0, h: 0 }, targetIds: [] }, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [] })!
    return pageOp(index, bounds)
  }

  it('puts a page under the ink it lands on, locked, and the native scene shows that order', () => {
    const { editor, controller } = board()
    const result = controller.applyOperations([atFocus(30)])
    expect(result.ok, result.message).toBe(true)
    const [page] = result.ids
    expect(order(editor)).toEqual(['shape:sheet', page, 'shape:ink', 'shape:math'])
    expect(editor.getSelectedShapeIds()).toEqual([])
    const scene = editorToExcalidrawScene(editor)
    expect(scene.elements.map(element => element.id)).toEqual(['shape:sheet', page, 'shape:ink', 'shape:math'])
    const element = scene.elements[1]
    expect(element).toMatchObject({ type: 'image', locked: true, fileId: libraryAssetId(`${BOOK}#30:page`) })
    expect(element.x).toBeCloseTo(260); expect(element.y).toBeCloseTo(280)
    expect(element.customData?.magicWhiteboard.shape.meta.library).toMatchObject({ kind: 'page', pageIndex: 30 })
    expect(scene.files[libraryAssetId(`${BOOK}#30:page`)].dataURL).toBe(jpeg(40))
    // the ink on the page is the first thing under the pen, never the page
    expect(editor.getShapeAtPoint({ x: 300, y: 300 }, { margin: 4 })?.id).toBe('shape:ink')
    expect(editor.getShapeAtPoint({ x: 700, y: 900 })?.id).toBe(page)
    // the next native onChange changes nothing, so there is no sync loop
    expect(sceneToEditorChanges(editor, scene.elements, scene.files)).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
  })

  it('keeps the page locked and at the back through native gestures', () => {
    const { editor, controller } = board()
    const [page] = controller.applyOperations([atFocus(30)]).ids
    const [sheet, pageElement, ink, math] = editorToExcalidrawScene(editor).elements
    const before = editor.getShape(page)
    // dragging the ink over the page
    ingest(editor, [sheet, pageElement, { ...ink, x: ink.x + 40, y: ink.y + 25 }, math])
    expect(order(editor)).toEqual(['shape:sheet', page, 'shape:ink', 'shape:math'])
    // a native attempt to unlock or move the page is ignored
    ingest(editor, [sheet, { ...pageElement, locked: false, x: pageElement.x + 50 }, ink, math])
    expect(editor.getShape(page)).toBe(before)
    // a stale scene that omits the page does not delete it
    ingest(editor, [sheet, ink, math])
    expect(editor.getShape(page)).toBe(before)
    // new ink drawn on the page goes on top of it
    const stroke = { ...ink, id: 'native-ink', customData: undefined, x: 500, y: 600 } as ExcalidrawElement
    ingest(editor, [...editorToExcalidrawScene(editor).elements, stroke])
    expect(order(editor)).toEqual(['shape:sheet', page, 'shape:ink', 'shape:math', 'native-ink'])
    expect(editorToExcalidrawScene(editor).elements.find(element => element.id === page)?.locked).toBe(true)
  })

  it('stacks a later page above earlier paper, keeps problems on top, and survives undo and reload', () => {
    const { editor, controller } = board()
    const [first] = controller.applyOperations([atFocus(30)]).ids
    const item = controller.applyOperations([itemOp('3.2', { x: 900, y: 100, w: 640, h: 180 })])
    expect(editor.getSelectedShapeIds()).toEqual(item.ids)
    const [second] = controller.applyOperations([pageOp(31, { x: 300, y: 500, w: 700, h: 906 })]).ids
    expect(order(editor)).toEqual(['shape:sheet', first, second, 'shape:ink', 'shape:math', item.ids[0]])
    editor.undo()
    expect(order(editor)).toEqual(['shape:sheet', first, 'shape:ink', 'shape:math', item.ids[0]])
    editor.redo()
    expect(order(editor)).toEqual(['shape:sheet', first, second, 'shape:ink', 'shape:math', item.ids[0]])
    const reopened = new Editor(normalizeSnapshot(editor.getSnapshot()))
    const scene = editorToExcalidrawScene(reopened)
    expect(scene.elements.map(element => element.id)).toEqual(['shape:sheet', first, second, 'shape:ink', 'shape:math', item.ids[0]])
    expect(scene.elements.filter(element => element.locked).map(element => element.id)).toEqual(['shape:sheet', first, second])
  })

  it('goes on top when everything on the board is locked', () => {
    const editor = new Editor()
    editor.run(() => editor.createShapes([
      { id: 'shape:a', type: 'geo', isLocked: true, props: { w: 10, h: 10 } },
      { id: 'shape:b', type: 'geo', props: { w: 10, h: 10 } },
    ]), { ignoreShapeLock: true })
    editor.run(() => editor.updateShapes([{ id: 'shape:b', type: 'geo', isLocked: true }]), { ignoreShapeLock: true })
    editor.run(() => editor.sendToBack(['shape:a'], { aboveLocked: true }), { ignoreShapeLock: true })
    expect(order(editor)).toEqual(['shape:b', 'shape:a'])
    // without the lock override a locked shape does not move
    editor.sendToBack(['shape:b'], { aboveLocked: true })
    expect(order(editor)).toEqual(['shape:b', 'shape:a'])
  })
})

