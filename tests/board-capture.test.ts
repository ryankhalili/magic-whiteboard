import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor, type TLShapeId } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { boardNeedsImage, captureBoardContext } from '../src/files/capture'
import type { BoardOperation, Focus } from '../shared/board'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const BOOK = 'sha256:' + 'c'.repeat(64)
let exported: string[][]

// a stand in for the browser canvas and image decoding, recording which objects were drawn
beforeEach(() => {
  exported = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:capture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect: () => {}, drawImage: () => {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }),
  })
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_url: string) { queueMicrotask(() => this.onload?.()) }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function libraryOp(kind: 'page' | 'item', x: number, y: number): BoardOperation {
  const page = kind === 'page'
  return {
    type: 'create_image', image: { src: PNG, w: 1400, h: page ? 1800 : 400, mimeType: 'image/png', name: 'book' }, locked: page,
    bounds: { x, y, w: page ? 700 : 640, h: page ? 900 : 183 },
    meta: { assetKey: `${BOOK}#${x}:${kind}`, library: { bookId: BOOK, title: 'Calculus', pageIndex: 30, pageLabel: '23', kind, ...(page ? {} : { itemKind: 'example', itemLabel: '3.2' }) } },
  }
}
function board() {
  const editor = new Editor()
  editor.setImageExporter(async (_editor, ids) => { exported.push([...ids]); return { blob: new Blob(['png']) } })
  const controller = createBoardController(editor, () => ({ focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1200, h: 800 }, objects: [] }))
  const result = controller.applyOperations([libraryOp('page', 0, 0), libraryOp('item', 750, 0)])
  if (!result.ok) throw new Error(result.message)
  editor.createShape({ id: 'shape:plot', type: 'magic', x: 760, y: 300, props: { kind: 'plot', expression: 'x', w: 400, h: 300 } })
  return { editor, page: result.ids.find(id => editor.getShape(id as TLShapeId)?.isLocked)!, item: result.ids.find(id => !editor.getShape(id as TLShapeId)?.isLocked)! }
}
const addInk = (editor: Editor) => editor.createShape({ id: 'shape:ink', type: 'draw', props: { points: [{ x: 100, y: 100 }, { x: 220, y: 160 }], color: 'blue', size: 'm' } })

describe('board screenshots for the model', () => {
  it('are not needed when the only images are from the textbook library', () => {
    const { editor } = board()
    expect(boardNeedsImage(editor)).toBe(false)
    addInk(editor)
    expect(boardNeedsImage(editor)).toBe(true)
    editor.deleteShapes(['shape:ink'])
    expect(boardNeedsImage(editor)).toBe(false)
    editor.createAssets([{ id: 'asset:photo', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
    editor.createShape({ id: 'shape:photo', type: 'image', x: 0, y: 1000, props: { assetId: 'asset:photo', w: 100, h: 100 } })
    expect(boardNeedsImage(editor)).toBe(true)
    expect(boardNeedsImage(new Editor())).toBe(false)
  })

  it('leave out book pages and problems but keep the ink written on them and everything else', async () => {
    const { editor, page, item } = board()
    addInk(editor)
    const worksheet = { id: 'shape:sheet' as TLShapeId, type: 'image' as const, x: 0, y: 950, isLocked: true, props: { assetId: 'asset:sheet', w: 300, h: 200 }, meta: { marginaliaBackground: true, pdf: { doc: 'd', name: 'Quiz', page: 1, pages: 1, at: 1, source: null, width: 612, height: 792, text: '' } } }
    editor.run(() => {
      editor.createAssets([{ id: 'asset:sheet', typeName: 'asset', type: 'image', meta: {}, props: { src: PNG, w: 1, h: 1 } }])
      editor.createShape(worksheet)
    })
    editor.setCamera({ x: 0, y: 0, z: .5 })
    expect(await captureBoardContext(editor)).toBe('data:image/jpeg;base64,AAAA')
    expect(exported).toHaveLength(1)
    expect(exported[0]).not.toContain(page)
    expect(exported[0]).not.toContain(item)
    expect(exported[0].sort()).toEqual(['shape:ink', 'shape:plot', 'shape:sheet'])
  })

  it('send nothing when only book content is in the captured area', async () => {
    const { editor, item } = board()
    const focus: Focus = { kind: 'point', bounds: { x: 800, y: 50, w: 0, h: 0 }, targetIds: [item] }
    expect(await captureBoardContext(editor, focus)).toBeNull()
    expect(exported).toEqual([])
    // ink on the problem is still read
    editor.createShape({ id: 'shape:work', type: 'draw', props: { points: [{ x: 800, y: 60 }, { x: 900, y: 90 }], color: 'black', size: 'm' } })
    expect(await captureBoardContext(editor, focus)).not.toBeNull()
    expect(exported).toEqual([['shape:work']])
  })
})
