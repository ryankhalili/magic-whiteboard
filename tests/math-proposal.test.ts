import { describe, expect, it } from 'vitest'
import { Editor } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { MathProposal, needsMathPreview } from '../src/math/MathProposal'
import { parseBoardCommand } from '../shared/tool-command'
import { compactContext, contextSchema, BOARD_INSTRUCTIONS } from '../server/board-tools'
import { constrainRepairCommand } from '../server/command-repair'
import type { BoardContext, BoardOperation } from '../shared/board'

const surface: BoardOperation = { type: 'create_plot', expression: 'x*y', visualization: { type: 'surface' }, xMin: -3, xMax: 3, yMin: -3, yMax: 3 }
function setup() {
  const editor = new Editor()
  const context: BoardContext = { objects: [], focus: null, pointer: { x: 200, y: 200 }, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1000, h: 800 } }
  const controller = createBoardController(editor, () => context)
  return { editor, context, controller }
}

describe('editable math proposals', () => {
  it('requires review for complex creations, not simple math or edits', () => {
    expect(needsMathPreview([surface])).toBe(true)
    expect(needsMathPreview([{ type: 'create_math', latex: 'x^2' }, { type: 'create_plot', expression: 'x^2' }])).toBe(false)
    expect(needsMathPreview([{ ...surface, type: 'update_object', target: 'shape:a' }])).toBe(false)
  })

  it('keeps the real board unchanged through creation, revision and invalid corrections', () => {
    const { editor, context } = setup(), original = editor.getSnapshot()
    const draft = new MathProposal(editor, context, [surface])
    expect(draft.shapes).toHaveLength(1)
    expect(draft.revise([{ type: 'update_object', target: draft.ids[0], expression: 'sin(x)*cos(y)', showGrid: false }]).ok).toBe(true)
    expect(draft.shapes[0].props.expression).toBe('sin(x)*cos(y)')
    expect(draft.revision).toBe(2)
    expect(draft.revise([{ type: 'update_object', target: 'last', expression: 'sin(' }]).ok).toBe(false)
    expect(draft.revision).toBe(2)
    expect(draft.shapes[0].props.expression).toBe('sin(x)*cos(y)')
    expect(editor.getSnapshot()).toEqual(original)
  })

  it('commits the revised source and exact reviewed placement as one undoable insertion', () => {
    const { editor, context, controller } = setup()
    const draft = new MathProposal(editor, context, [surface])
    expect(draft.revise([{ type: 'update_object', target: 'selected', expression: 'x^2+y^2', visualization: { type: 'surface', showWireframe: false }, showNumbers: false }]).ok).toBe(true)
    const bounds = draft.operations(draft.id, draft.revision)[0].bounds
    context.pointer = { x: 800, y: 700 }
    expect(controller.applyOperations(draft.operations(draft.id, draft.revision)).ok).toBe(true)
    expect(controller.getObjects()[0]).toMatchObject({ expression: 'x^2+y^2', bounds, showNumbers: false, visualization: { showWireframe: false } })
    editor.undo()
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })

  it('does not overwrite unrelated work added while a preview is open', () => {
    const { editor, context, controller } = setup()
    const draft = new MathProposal(editor, context, [surface])
    controller.applyOperations([{ type: 'create_text', text: 'Keep my notes' }])
    controller.applyOperations(draft.operations(draft.id, draft.revision))
    expect(controller.getObjects()).toHaveLength(2)
    expect(controller.getObjects().some(o => o.text === 'Keep my notes')).toBe(true)
  })

  it('preserves the position and rotation of a rotated draft on confirmation', () => {
    const { editor, context, controller } = setup()
    const draft = new MathProposal(editor, context, [{ ...surface, rotation: 35, bounds: { x: 100, y: 150, w: 480, h: 360 } }])
    const before = draft.shapes[0]
    const result = controller.applyOperations(draft.operations(draft.id, draft.revision))
    expect(result.ok).toBe(true)
    const after = editor.getShape(result.ids[0] as never)!
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(after.rotation).toBeCloseTo(before.rotation)
  })

  it('rejects stale confirmation, mixed mutations and edits outside the draft', () => {
    const { editor, context, controller } = setup()
    const real = controller.applyOperations([{ type: 'create_plot', expression: 'x' }]).ids[0]
    const draft = new MathProposal(editor, context, [surface])
    draft.revise([{ type: 'update_object', target: draft.ids[0], color: 'blue' }])
    expect(() => draft.operations(draft.id, 1)).toThrow(/changed/)
    expect(() => draft.operations('old-preview', draft.revision)).toThrow(/changed/)
    expect(() => draft.revise([{ type: 'update_object', ids: [draft.ids[0], real], color: 'red' }])).toThrow(/only change/)
    expect(() => new MathProposal(editor, context, [surface, { type: 'delete_objects', target: real }])).toThrow(/separately/)
    expect(controller.getObjects()[0].expression).toBe('x')
  })

  it('preserves literal-area constraints through draft edits', () => {
    const { editor, context } = setup()
    context.focusMode = 'literal'; context.focus = { kind: 'region', bounds: { x: 10, y: 10, w: 500, h: 400 }, targetIds: [] }
    const draft = new MathProposal(editor, context, [{ ...surface, placement: 'focus' }])
    expect(draft.revise([{ type: 'transform_object', target: draft.ids[0], dx: 2000 }]).ok).toBe(false)
    expect(draft.revision).toBe(1)
  })

  it('keeps complete preview identity and properties in bounded model context', () => {
    const { editor, context } = setup(), draft = new MathProposal(editor, context, [surface])
    const state = contextSchema.parse({ ...context, pendingMath: draft.summary, objects: draft.objects })
    const packed = compactContext(state)
    expect(packed.pendingMath).toEqual(draft.summary)
    expect(packed.objects[0]).toMatchObject({ id: draft.ids[0], expression: 'x*y', visualization: { type: 'surface' } })
    expect(BOARD_INSTRUCTIONS).toContain('Never confirm on your own')
  })

  it('requires a single versioned confirmation action, separate from creation or edits', () => {
    expect(parseBoardCommand({ type: 'confirm_math', target: 'preview:test', previewRevision: 2 }).operations).toHaveLength(1)
    expect(() => parseBoardCommand({ type: 'confirm_math', target: 'preview:test' })).toThrow()
    expect(() => parseBoardCommand([surface, { type: 'confirm_math', target: 'preview:test', previewRevision: 1 }])).toThrow()
    expect(() => parseBoardCommand({ type: 'cancel_math' })).toThrow()
  })

  it('allows repair to edit the identified draft but never to approve it automatically', () => {
    const { editor, context } = setup(), draft = new MathProposal(editor, context, [surface])
    const request = { instruction: 'make it blue', context: contextSchema.parse({ ...context, pendingMath: draft.summary, objects: draft.objects }),
      failure: { kind: 'malformed_arguments' as const, message: 'Incomplete arguments' } }
    const repaired = constrainRepairCommand({ operations: [{ type: 'update_object', target: draft.ids[0], color: 'blue' }], message: '' }, request)
    expect(repaired.operations[0].target).toBe(draft.ids[0])
    expect(() => constrainRepairCommand({ operations: [{ type: 'confirm_math', target: draft.id, previewRevision: 1 }], message: '' }, request)).toThrow(/approval/)
  })
})
