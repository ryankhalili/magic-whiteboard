import { validateLatex } from './latex'
import { validateExpression } from './expression'
import type { MagicShape, MagicShapeProps } from './MagicShape'
import type { Editor } from '../canvas/editor'

export const SOURCE_FLUSH_EVENT = 'marginalia-before-board-command'
export type SourceFlushOptions = { silent?: boolean; finishHistory?: boolean }

export function flushSourceEdits(options: SourceFlushOptions = {}): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SOURCE_FLUSH_EVENT, { detail: options }))
}

/** Flush deferred source synchronously before copying document data for persistence. */
export function snapshotWithPendingSource(editor: Editor, options: SourceFlushOptions = {}) {
  flushSourceEdits(options)
  return editor.getSnapshot()
}

export function sourceField(shape: MagicShape): 'latex' | 'expression' | 'text' {
  return shape.props.kind === 'math' ? 'latex' : shape.props.kind === 'plot' ? 'expression' : 'text'
}

/** Validate source before replacing the last renderable content. Preserve graph axes. */
export function sourceUpdate(shape: MagicShape, value: string): Partial<MagicShapeProps> {
  if (value.length > 6000) throw new Error('Keep this object under 6,000 characters.')
  const field = sourceField(shape)
  if (field === 'expression') return { expression: validateExpression(value).expression }
  if (field === 'latex') {
    try { validateLatex(value) }
    catch (error) { throw new Error(`Finish the LaTeX expression to update the board. ${error instanceof Error ? error.message : ''} The last valid equation is still visible.`) }
  }
  return { [field]: value }
}
