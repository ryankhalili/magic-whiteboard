import { describe, expect, it } from 'vitest'
import { extractContentPreviews } from '../src/ai/content-preview'
import type { BoardContext } from '../shared/board'

const context: BoardContext = { focus: null, pointer: null, selectedIds: ['shape:m'], lastCreatedIds: ['shape:m'], viewport: { x: 0, y: 0, w: 1000, h: 800 }, objects: [
  { id: 'shape:m', kind: 'math', bounds: { x: 10, y: 20, w: 300, h: 100 }, rotation: 0, latex: 'x^2+2' },
] }
const preview = (source: string) => extractContentPreviews('call_test', source, context).at(-1)

describe('progressive tool content preview', () => {
  it('decodes an unfinished LaTeX string without completing the tool call', () => {
    const value = preview(String.raw`{"operations":[{"type":"create_math","latex":"\\int_0^{1} x`)
    expect(value?.value).toBe(String.raw`\int_0^{1} x`)
    expect(value?.complete).toBe(false)
    expect(value?.operationType).toBe('create_math')
  })
  it('preserves JSON string delimiters as literal content', () => {
    const value = preview(String.raw`{"operations":[{"type":"create_text","text":"He said \"x}\" and [`)
    expect(value?.value).toBe('He said "x}" and [')
  })
  it('waits through a split unicode escape rather than inserting invalid text', () => {
    const prefix = '{"operations":[{"type":"create_text","text":"angle \\u03'
    expect(preview(prefix)?.value).toBe('angle ')
    expect(preview(prefix + 'b8')?.value).toBe('angle θ')
  })
  it('ignores an incomplete key and does not treat field names as content', () => {
    expect(preview('{"operations":[{"type":"create_math","lat')).toBeUndefined()
    expect(preview('{"operations":[{"type":"create_ma')).toBeUndefined()
  })
  it('returns a full appended source for an incremental edit', () => {
    const value = preview('{"operations":[{"type":"edit_content","field":"latex","replacement":"+3')
    expect(value?.value).toBe('x^2+2+3')
    expect(value?.kind).toBe('edit')
    expect(value?.target).toBe('shape:m')
  })
  it('reconstructs a partial range replacement preserving surrounding content', () => {
    const value = preview('{"operations":[{"type":"edit_content","target":"shape:m","field":"latex","start":4,"end":5,"replacement":"3')
    expect(value?.value).toBe('x^2+3')
  })
  it('reconstructs unique exact replacement and rejects ambiguous matches', () => {
    expect(preview('{"operations":[{"type":"edit_content","field":"latex","find":"x","replace":"y')?.value).toBe('y^2+2')
    expect(preview('{"operations":[{"type":"edit_content","field":"latex","find":"2","replace":"3')).toBeUndefined()
  })
  it('never guesses the meaning of an unsupported operation', () => {
    expect(preview('{"operations":[{"type":"run_javascript","text":"alert(1)')).toBeUndefined()
  })
  it('bounds parser work and treats prototype property names as data', () => {
    expect(preview('x'.repeat(100001))).toBeUndefined()
    const result = preview('{"__proto__":{"polluted":true},"operations":[{"type":"create_text","text":"safe"}]}')
    expect(result?.value).toBe('safe')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it.each([
    ['selected', 'shape:selected', 's+3'], ['selection', 'shape:selected', 's+3'],
    ['focus', 'shape:focus', 'f+3'], ['last', 'shape:last', 'l+3'],
  ])('resolves the %s target alias like the board controller', (alias, target, value) => {
    const aliasedContext: BoardContext = {
      ...context, selectedIds: ['shape:selected'], lastCreatedIds: ['shape:last'],
      focus: { kind: 'point', bounds: { x: 10, y: 20, w: 0, h: 0 }, targetIds: ['shape:focus'] },
      objects: ['selected', 'focus', 'last'].map(name => ({ ...context.objects[0], id: `shape:${name}`, latex: name[0] })),
    }
    const result = extractContentPreviews('alias_call', `{"operations":[{"type":"edit_content","target":"${alias}","field":"latex","replacement":"+3`, aliasedContext).at(-1)
    expect(result?.target).toBe(target)
    expect(result?.value).toBe(value)
    expect(result?.bounds).toEqual(context.objects[0].bounds)
  })
  it('does not fall back to last-created when an explicit selection alias is empty', () => {
    const result = extractContentPreviews('missing_selection', '{"operations":[{"type":"edit_content","target":"selected","field":"latex","replacement":"+3', { ...context, selectedIds: [] })
    expect(result).toEqual([])
  })
  it('gives explicit ids priority over a target alias', () => {
    const result = extractContentPreviews('explicit_ids', '{"operations":[{"type":"edit_content","ids":["shape:m"],"target":"focus","field":"latex","replacement":"+3', context).at(-1)
    expect(result?.target).toBe('shape:m')
    expect(result?.value).toBe('x^2+2+3')
  })
})
