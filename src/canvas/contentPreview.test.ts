import { describe, expect, it } from 'vitest'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { Editor } from './editor'
import { getContentPreviewTarget, isContentPreviewTarget } from './contentPreview'
import { editorToExcalidrawScene, LIVE_CONTENT_FILE_ID, sceneToEditorChanges } from './excalidrawScene'

function setup() {
  const editor = new Editor()
  editor.createShape({ id: 'shape:math', type: 'magic', x: 120, y: 80, rotation: .2, props: { kind: 'math', latex: 'x^2' } })
  editor.select('shape:math')
  editor.markHistoryStoppingPoint('Initial equation')
  return editor
}

describe('native bitmap and streaming DOM handoff', () => {
  it('substitutes a transparent proxy without modifying source, selection, pose, or history', () => {
    const editor = setup(), before = editor.getSnapshot()
    const file = { id: 'render:math', mimeType: 'image/png', dataURL: 'data:image/png;base64,cG5n', created: 1 } as BinaryFileData
    const rendered = new Map([['shape:math', file]])
    const scene = editorToExcalidrawScene(editor, [], rendered)
    expect(scene.elements[0]).toMatchObject({ fileId: file.id })
    const preview = getContentPreviewTarget(editor, { target: 'shape:math', field: 'latex', value: 'x^2+' })
    expect(isContentPreviewTarget(editor.getShape('shape:math'), preview)).toBe(true)
    const allowedFiles = new Map([...rendered].filter(([id]) => !isContentPreviewTarget(editor.getShape(id), preview)))
    const streaming = editorToExcalidrawScene(editor, scene.elements, allowedFiles)
    expect(streaming.elements[0]).toMatchObject({ fileId: LIVE_CONTENT_FILE_ID, x: scene.elements[0].x, y: scene.elements[0].y, angle: scene.elements[0].angle })
    expect(sceneToEditorChanges(editor, streaming.elements, streaming.files)).toEqual({ creates: [], updates: [], deletes: [], assets: [] })
    expect(editor.getSnapshot()).toEqual(before)
    expect(editor.getSelectedShapeIds()).toEqual(['shape:math'])
    expect(getContentPreviewTarget(editor, { target: 'shape:math', field: 'latex', value: 'x^2+3' }, preview)).toBe(preview)
    const cleared = getContentPreviewTarget(editor, null, preview)
    expect(cleared).toBeNull()
    const restored = editorToExcalidrawScene(editor, streaming.elements, rendered)
    expect(restored.elements[0]).toMatchObject({ fileId: file.id })
    expect(sceneToEditorChanges(editor, restored.elements, restored.files).updates).toEqual([])
    editor.undo()
    expect(editor.getCurrentPageShapes()).toHaveLength(0) // No preview/history entry was added.
  })

  it('ends its transient rendering role when the content commits, disappears, or targets another object', () => {
    const editor = setup()
    const preview = getContentPreviewTarget(editor, { target: 'shape:math', field: 'latex', value: 'x^2+3' })
    editor.updateShape({ id: 'shape:math', type: 'magic', props: { latex: 'x^2+3' } })
    expect(isContentPreviewTarget(editor.getShape('shape:math'), preview)).toBe(false)
    expect(isContentPreviewTarget(undefined, preview)).toBe(false)
    editor.createShape({ id: 'shape:other', type: 'magic', props: { kind: 'text', text: '' } })
    const next = getContentPreviewTarget(editor, { target: 'shape:other', field: 'text', value: 'Hello' }, preview)
    expect(isContentPreviewTarget(editor.getShape('shape:math'), next)).toBe(false)
    expect(isContentPreviewTarget(editor.getShape('shape:other'), next)).toBe(true)
    expect(getContentPreviewTarget(editor, { target: 'missing', field: 'latex', value: 'x' })).toBeNull()
  })
})
