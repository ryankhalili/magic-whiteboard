import { describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/canvas/editor'
import type { MagicShape } from '../src/board/MagicShape'
import { SOURCE_FLUSH_EVENT, snapshotWithPendingSource, sourceField, sourceUpdate, type SourceFlushOptions } from '../src/board/liveSource'

function mathEditor(kind: 'math' | 'plot' | 'text' = 'math') {
  const editor = new Editor()
  editor.createShape({ id: 'shape:source', type: 'magic', props: { kind, latex: 'x^2', expression: 'sin(x)', text: 'A note', xMin: -7, xMax: 11, yMin: -3, yMax: 8 } })
  editor.markHistoryStoppingPoint('Initial content')
  const read = () => editor.getShape<MagicShape>('shape:source')!
  const write = (value: string) => editor.updateShape<MagicShape>({ id: 'shape:source', type: 'magic', props: sourceUpdate(read(), value) })
  return { editor, read, write }
}

describe('live object source validation', () => {
  it('keeps the previous renderable equation when a draft is incomplete, then accepts its completion', () => {
    const { read, write } = mathEditor()
    const before = structuredClone(read())
    expect(() => write('\\frac{x}{')).toThrow('Finish the LaTeX expression')
    expect(read()).toEqual(before)
    write('\\frac{x}{2}')
    expect(read().props.latex).toBe('\\frac{x}{2}')
    write('')
    expect(read().props.latex).toBe('')
    expect(read().id).toBe(before.id)
  })
  it('supports live implicit equations without changing the user’s axis ranges', () => {
    const { read, write } = mathEditor('plot')
    write('x^2+y^2=9')
    expect(read().props).toMatchObject({ expression: 'x^2+y^2=9', xMin: -7, xMax: 11, yMin: -3, yMax: 8 })
    write('x=2')
    expect(read().props.expression).toBe('x=2')
    expect(() => write('x^2+y^2=')).toThrow()
    expect(read().props.expression).toBe('x=2')
  })
  it('groups a continuous valid typing session into one undo step', () => {
    const { editor, read, write } = mathEditor()
    editor.markHistoryStoppingPoint('Start editing source')
    write('x^2+1'); write('x^2+12'); write('x^2+123')
    editor.markHistoryStoppingPoint('Finish editing source')
    expect(read().props.latex).toBe('x^2+123')
    editor.undo(); expect(read().props.latex).toBe('x^2')
    editor.redo(); expect(read().props.latex).toBe('x^2+123')
  })
  it('separates a following voice change from already committed source typing', () => {
    const { editor, read, write } = mathEditor()
    write('x+2'); editor.markHistoryStoppingPoint('Finish source before command')
    editor.updateShape<MagicShape>({ id: read().id, type: 'magic', props: { latex: 'x+3' } }); editor.markHistoryStoppingPoint('After voice correction')
    editor.undo(); expect(read().props.latex).toBe('x+2')
    editor.undo(); expect(read().props.latex).toBe('x^2')
  })
  it('flushes deferred source before taking a save snapshot and cancels the stale timer', () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    try {
      const { editor, write } = mathEditor()
      const pending = setTimeout(() => write('x+7'), 180)
      let options: SourceFlushOptions | undefined
      target.addEventListener(SOURCE_FLUSH_EVENT, event => {
        options = (event as CustomEvent<SourceFlushOptions>).detail
        clearTimeout(pending)
        write('x+7')
      }, { once: true })
      const snapshot = snapshotWithPendingSource(editor, { silent: true, finishHistory: false })
      expect((snapshot.document.store['shape:source'] as MagicShape).props.latex).toBe('x+7')
      expect(options).toEqual({ silent: true, finishHistory: false })
      // Opening another document with the same object ID must not receive the old timer's text.
      const other = mathEditor(); other.write('y+9')
      editor.loadSnapshot(other.editor.getSnapshot())
      vi.runAllTimers()
      expect(editor.getShape<MagicShape>('shape:source')!.props.latex).toBe('y+9')
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
  it('treats ordinary prose as text and rejects oversized content before changing the object', () => {
    const { read, write } = mathEditor('text')
    expect(sourceField(read())).toBe('text')
    write('Cell membranes\ncontain phospholipids.')
    expect(read().props.text).toBe('Cell membranes\ncontain phospholipids.')
    expect(() => write('x'.repeat(6001))).toThrow('6,000')
    expect(read().props.text).toBe('Cell membranes\ncontain phospholipids.')
  })
})
