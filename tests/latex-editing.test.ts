import { describe, expect, it } from 'vitest'
import { Editor } from '../src/canvas/editor'
import type { MagicShape } from '../src/board/MagicShape'
import { createBoardController } from '../src/board/controller'
import { applyLatexContentEdit } from '../src/board/contentEdit'
import { normalizeLatexInput, validateLatex } from '../src/board/latex'
import { sourceUpdate } from '../src/board/liveSource'

function setup() {
  const editor = new Editor()
  const controller = createBoardController(editor, () => ({
    focus: null, pointer: null, selectedIds: editor.getSelectedShapeIds(), lastCreatedIds: [], objects: [],
    viewport: { x: 0, y: 0, w: 1000, h: 800 },
  }))
  const read = (id: string) => editor.getShape<MagicShape>(id)!
  return { editor, controller, read }
}

describe('conservative LaTeX input normalization', () => {
  it.each(['$x+1$', '$$x+1$$', '\\(x+1\\)', '\\[x+1\\]', '```latex\nx+1\n```', '```tex\n$$x+1$$\n```'])('unwraps a complete math transport wrapper: %s', input => {
    expect(validateLatex(input, true)).toBe('x+1')
  })
  it('preserves escaped literal dollars, meaningful spaces, and mixed math spans', () => {
    const price = '\\text{Cost: \\$5}'
    expect(normalizeLatexInput(price)).toBe(price)
    expect(validateLatex(`$${price}$`, true)).toBe(price)
    expect(normalizeLatexInput(' has a nucleus ')).toBe(' has a nucleus ')
    expect(normalizeLatexInput('$x$ and $y$')).toBe('$x$ and $y$')
    expect(() => validateLatex('$x$ and $y$', true)).toThrow(/without mixed dollar-delimited spans/)
  })
  it('does not guess missing braces, arguments, or paired delimiters', () => {
    for (const source of ['\\frac{x}{', '\\frac{x}', '\\left(x', 'x\\right)']) {
      expect(normalizeLatexInput(source)).toBe(source)
      expect(() => validateLatex(source, true)).toThrow(/incomplete|delimiters do not match/)
    }
    expect(validateLatex('x=')).toBe('x=')
    expect(validateLatex('\\int_0^1')).toBe('\\int_0^1')
  })
  it('reports unsupported commands without inventing their meaning', () => {
    expect(() => validateLatex('x=\\answer{3}', true)).toThrow(/Unsupported LaTeX command \\answer/)
    expect(() => validateLatex('x=\\answer{3}', true)).toThrow(/resend the complete equation/)
    expect(normalizeLatexInput('\\answer{3}')).toBe('\\answer{3}')
  })
})

describe('LaTeX fragment boundaries', () => {
  it('separates a trailing control word from appended letters, preserving the command', () => {
    expect(applyLatexContentEdit('\\cosh', { replacement: 'x' })).toBe('\\cosh x')
    expect(applyLatexContentEdit('\\alpha', { replacement: 'x+1' })).toBe('\\alpha x+1')
    expect(applyLatexContentEdit('\\cosh ', { replacement: 'x' })).toBe('\\cosh x')
    expect(applyLatexContentEdit('x', { replacement: '+3' })).toBe('x+3')
    expect(applyLatexContentEdit('\\cosh', { replacement: '\\theta' })).toBe('\\cosh\\theta')
    expect(applyLatexContentEdit('\\\\cosh', { replacement: 'x' })).toBe('\\\\coshx') // An escaped backslash does not start a command.
  })
  it('unwraps append fragments and older wrapped sources without changing explicit range semantics', () => {
    expect(applyLatexContentEdit('$$\\cosh$$', { replacement: '$x$' })).toBe('\\cosh x')
    expect(applyLatexContentEdit('\\cos', { start: 4, end: 4, replacement: 'h' })).toBe('\\cosh')
    expect(applyLatexContentEdit('\\cosh x', { find: 'cosh', replace: 'sinh' })).toBe('\\sinh x')
    expect(applyLatexContentEdit('\\text{Price}', { find: 'Price', replace: '$5$' })).toBe('\\text{$5$}')
    expect(applyLatexContentEdit('\\text{The cell}', { start: 14, end: 14, replacement: ' has a nucleus' })).toBe('\\text{The cell has a nucleus}')
  })
})

describe('math command validation and recovery', () => {
  it('uses one normalization and validation policy for create, update, and edit', () => {
    const { editor, controller, read } = setup()
    const created = controller.applyOperations([{ type: 'create_math', latex: '$$\\cosh$$' }])
    expect(created.ok, created.message).toBe(true)
    const id = created.ids[0]
    expect(read(id).props.latex).toBe('\\cosh')
    const appended = controller.applyOperations([{ type: 'edit_content', target: id, field: 'latex', replacement: '$x$' }])
    expect(appended.ok, appended.message).toBe(true)
    expect(read(id).props.latex).toBe('\\cosh x')
    const updated = controller.applyOperations([{ type: 'update_object', target: id, latex: '\\[\\cosh x = \\frac{e^x+e^{-x}}{2}\\]' }])
    expect(updated.ok, updated.message).toBe(true)
    expect(read(id).props.latex).toBe('\\cosh x = \\frac{e^x+e^{-x}}{2}')
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    editor.undo(); expect(read(id).props.latex).toBe('\\cosh x')
  })
  it('rejects malformed create batches atomically and preserves the previous equation after bad updates/edits', () => {
    const { controller, read, editor } = setup()
    const created = controller.applyOperations([{ type: 'create_math', latex: 'x+1' }])
    const id = created.ids[0], initial = structuredClone(read(id))
    const failedCreate = controller.applyOperations([{ type: 'create_text', text: 'Not committed' }, { type: 'create_math', latex: '\\answer{3}' }])
    expect(failedCreate.ok).toBe(false)
    expect(failedCreate.message).toContain('Unsupported LaTeX command \\answer')
    for (const operation of [
      { type: 'update_object' as const, target: id, latex: '\\left(x' },
      { type: 'edit_content' as const, target: id, field: 'latex' as const, replacement: '=\\frac{1}{' },
    ]) {
      const result = controller.applyOperations([operation])
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/delimiters do not match|incomplete/)
      expect(result.message).toContain('The board has not changed.')
      expect(read(id)).toEqual(initial)
    }
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    expect(controller.applyOperations([{ type: 'update_object', target: id, latex: 'x+1=3' }]).ok).toBe(true)
    expect(read(id).props.latex).toBe('x+1=3')
  })
  it('validates display-mode environments consistently and retains invalid manual drafts outside the saved object', () => {
    const { controller, read, editor } = setup()
    const aligned = '\\begin{align}x&=1\\end{align}'
    const made = controller.applyOperations([{ type: 'create_math', latex: aligned }])
    expect(made.ok, made.message).toBe(true)
    const shape = read(made.ids[0])
    expect(sourceUpdate(shape, aligned)).toEqual({ latex: aligned })
    expect(() => sourceUpdate(shape, '\\frac{x}{')).toThrow(/last valid equation is still visible/)
    expect(read(shape.id).props.latex).toBe(aligned)
    const valid = sourceUpdate(shape, '\\frac{x}{2}')
    editor.updateShape({ id: shape.id, type: 'magic', props: valid })
    expect(read(shape.id).props.latex).toBe('\\frac{x}{2}')
  })
})
