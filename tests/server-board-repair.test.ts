import { describe, expect, it } from 'vitest'
import type { BoardContext, BoardOperation } from '../shared/board'
import { pinBoardRepair, prepareBoardRepair, validateRepairContext } from '../src/ai/board-repair'

const context: BoardContext = {
  focus: null, pointer: { x: 10, y: 20 }, selectedIds: ['math:a'], lastCreatedIds: [],
  viewport: { x: 0, y: 0, w: 1000, h: 700 },
  objects: [
    { id: 'math:a', kind: 'math', latex: 'x^2', bounds: { x: 0, y: 0, w: 200, h: 100 }, rotation: 0 },
    { id: 'math:b', kind: 'math', latex: 'y^2', bounds: { x: 300, y: 0, w: 200, h: 100 }, rotation: 0 },
  ],
}
const original: BoardOperation = { type: 'edit_content', field: 'latex', replacement: '=\\answer' }
const failure = { ok: false, message: 'Unsupported LaTeX command \\answer.', ids: [] }
function prepared(operations = [original], before = context) {
  const result = prepareBoardRepair(operations, before, before, failure)
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

describe('bounded content repair safety', () => {
  it('allows unsupported LaTeX control words to be corrected, preserving the original target', () => {
    const repair = prepared()
    const changedSelection = { ...context, selectedIds: ['math:b'], pointer: { x: 400, y: 80 } }
    const decision = pinBoardRepair(repair, [{ type: 'update_object', target: 'selected', latex: 'x^2 = ?' }], changedSelection)
    expect(decision).toEqual({ ok: true, value: [{ type: 'update_object', target: 'math:a', latex: 'x^2 = ?' }] })
    expect(repair.failedOperations).toEqual([original])
  })

  it.each([
    { type: 'update_object', target: 'math:b', latex: 'x^2 = ?' },
    { type: 'update_object', latex: 'x^2 = ?', bounds: { x: 10, y: 10, w: 500, h: 100 } },
    { type: 'update_object', text: 'unrelated' },
    { type: 'delete_objects', target: 'math:a' },
    { type: 'create_math', latex: 'x^2 = ?' },
  ] satisfies BoardOperation[])('rejects unrelated actions or extra fields: %j', candidate => {
    expect(pinBoardRepair(prepared(), [candidate], context).ok).toBe(false)
  })

  it('rejects a changed source, removed target, lock, or geometry before committing a correction', () => {
    const repair = prepared()
    for (const changes of [{ latex: 'x^3' }, { locked: true }, { rotation: 90 }]) {
      const modified = { ...context, objects: [{ ...context.objects[0], ...changes }, context.objects[1]] }
      expect(validateRepairContext(repair, modified).ok).toBe(false)
    }
    expect(validateRepairContext(repair, { ...context, objects: [context.objects[1]] }).ok).toBe(false)
  })

  it('rejects changed literal focus even when the object source remains unchanged', () => {
    const literal: BoardContext = { ...context, focusMode: 'literal', focus: { kind: 'region', bounds: { x: 0, y: 0, w: 300, h: 300 }, targetIds: ['math:a'] } }
    expect(validateRepairContext(prepared([original], literal), { ...literal, focus: null }).ok).toBe(false)
    expect(validateRepairContext(prepared(), { ...context, focusMode: 'literal' }).ok).toBe(false)
  })

  it('does not retry partly successful batches, unrelated failures, or silently omit failed edits', () => {
    const partial = [{ ok: true, message: 'Created.', ids: ['math:c'] }, failure]
    expect(prepareBoardRepair([original], context, context, partial).ok).toBe(false)
    expect(prepareBoardRepair([original], context, context, { ...failure, message: 'Unsupported operation.' }).ok).toBe(false)
    expect(prepareBoardRepair([original], context, context, { ...failure, message: 'The object extends outside the literal focus.' }).ok).toBe(false)
    const repair = prepared([original, { ...original, target: 'math:b' }])
    expect(pinBoardRepair(repair, [{ type: 'update_object', target: 'math:a', latex: 'x^2 = ?' }], context).ok).toBe(false)
  })

  it('only retries creation on an unchanged empty board with the same placement and request count', () => {
    const empty = { ...context, objects: [], selectedIds: [] }
    const operation: BoardOperation = { type: 'create_math', latex: '\\answer', placement: 'pointer' }
    expect(prepareBoardRepair([operation], context, context, failure).ok).toBe(false)
    const repair = prepared([operation], empty)
    expect(pinBoardRepair(repair, [{ ...operation, latex: '?' }], empty).ok).toBe(true)
    expect(pinBoardRepair(repair, [{ ...operation, latex: '?', placement: 'focus' }], empty).ok).toBe(false)
    expect(validateRepairContext(repair, { ...empty, pointer: { x: 11, y: 20 } }).ok).toBe(false)
    expect(validateRepairContext(repair, { ...empty, objects: [context.objects[0]] }).ok).toBe(false)
  })

  it('owns an immutable pre-failure snapshot and treats added null values as changes', () => {
    const before = structuredClone(context)
    const repair = prepared([original], before)
    before.objects[0].latex = 'later'
    expect(repair.objects[0].latex).toBe('x^2')
    const candidate = { type: 'update_object', latex: 'x^2 = ?', color: null } as unknown as BoardOperation
    expect(pinBoardRepair(repair, [candidate], context).ok).toBe(false)
  })
})
