import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import { Editor } from './editor'
import { editorToExcalidrawScene, LIVE_CONTENT_FILE_ID } from './excalidrawScene'
import { NativeSceneImportError, validateNativeSceneImport } from './nativeImportValidation'

function setup() {
  const editor = new Editor()
  editor.createShape({ id: 'shape:source', type: 'magic', props: { kind: 'math', latex: 'x^2' } })
  const original = editorToExcalidrawScene(editor).elements[0]
  return { editor, original, foreign: { ...original, id: 'foreign', customData: undefined } }
}

describe('portable native clipboard boundary', () => {
  it.each(['diamond', 'rectangle', 'text', 'arrow', 'line', 'frame', 'embeddable'])('rejects a foreign %s before changing existing content', type => {
    const { editor, original, foreign } = setup(), snapshot = editor.getSnapshot()
    expect(() => validateNativeSceneImport(editor, [original, { ...foreign, type } as ExcalidrawElement])).toThrow(NativeSceneImportError)
    expect(editor.getSnapshot()).toEqual(snapshot)
  })

  it('accepts the application source when duplicated with a fresh native identity', () => {
    const { editor, original } = setup()
    const duplicate = { ...original, id: 'copied-math', groupIds: ['copied-group'] }
    expect(() => validateNativeSceneImport(editor, [original, duplicate])).not.toThrow()
  })

  it('allows source-backed disconnected ink proxies without importing their temporary image asset', () => {
    const { editor, original } = setup()
    const draw = { id: 'old-ink', type: 'draw', props: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], segments: [{ type: 'free', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], color: 'black', size: 'm' } }
    const proxy = { ...original, id: 'copied-ink', fileId: LIVE_CONTENT_FILE_ID, customData: { magicWhiteboard: { schemaVersion: 1, shape: draw, offset: { x: 0, y: 0 } } } } as unknown as ExcalidrawElement
    expect(() => validateNativeSceneImport(editor, [original, proxy])).not.toThrow()
    expect(Object.values(editor.getSnapshot().document.store).filter(record => record.typeName === 'asset')).toHaveLength(0)
  })

  it('accepts native ink with pressure samples', () => {
    const { editor, foreign } = setup()
    const ink = { ...foreign, type: 'freedraw', points: [[0, 0], [20, 30]], pressures: [.1, .9], strokeWidth: 3, strokeColor: '#123456' } as ExcalidrawElement
    expect(() => validateNativeSceneImport(editor, [ink])).not.toThrow()
  })

  it('accepts the zero-sized first point of a native pen stroke', () => {
    const { editor, foreign } = setup()
    const dot = { ...foreign, type: 'freedraw', width: 0, height: 0, points: [[0, 0]], pressures: [], simulatePressure: true, strokeWidth: 3, strokeColor: '#123456' } as ExcalidrawElement
    expect(() => validateNativeSceneImport(editor, [dot])).not.toThrow()
  })

  it('allows an application image duplicate to reuse an existing embedded asset', () => {
    const { editor } = setup()
    editor.createAssets([{ id: 'asset:existing', typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,AA==', name: 'Original', w: 100, h: 100 } }])
    editor.createShape({ id: 'shape:image', type: 'image', props: { assetId: 'asset:existing', w: 100, h: 100 } })
    const image = editorToExcalidrawScene(editor).elements.find(element => element.id === 'shape:image')!
    expect(() => validateNativeSceneImport(editor, [{ ...image, id: 'copied-image' }])).not.toThrow()
  })

  it('accepts portable raster pixels and rejects SVG or external image data', () => {
    const { editor, foreign } = setup()
    const image = { ...foreign, type: 'image', fileId: 'asset:paste' } as ExcalidrawElement
    const files = (dataURL: string) => ({ 'asset:paste': { id: 'asset:paste', dataURL, mimeType: 'image/png', created: 1 } }) as unknown as BinaryFiles
    expect(() => validateNativeSceneImport(editor, [image], files('data:image/png;base64,AA=='))).not.toThrow()
    for (const src of ['data:image/svg+xml;base64,PHN2Zy8+', 'https://example.com/image.png']) {
      expect(() => validateNativeSceneImport(editor, [image], files(src))).toThrow('Only embedded PNG')
    }
  })

  it('rejects the whole mixed paste instead of accepting its compatible subset', () => {
    const { editor, original, foreign } = setup(), snapshot = editor.getSnapshot()
    expect(() => validateNativeSceneImport(editor, [{ ...original, id: 'new-math' }, { ...foreign, type: 'diamond' } as ExcalidrawElement])).toThrow('Nothing was added')
    expect(editor.getSnapshot()).toEqual(snapshot)
  })

  it('checks copied source against notebook validation before accepting it', () => {
    const { editor, original } = setup()
    const invalid = { ...original, id: 'damaged-copy', customData: { magicWhiteboard: { schemaVersion: 1, shape: { type: 'geo', props: { geo: 'diamond' } } } } } as ExcalidrawElement
    expect(() => validateNativeSceneImport(editor, [invalid])).toThrow('not supported')
  })
})
