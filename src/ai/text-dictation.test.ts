import { describe, expect, it } from 'vitest'
import type { BoardContext, BoardObject } from '../../shared/board'
import { generateTextTranscriptPreview, prepareTextDictation } from './text-dictation'

const base: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [],
  viewport: { x: 0, y: 0, w: 1000, h: 800 }, dictationMode: 'text' }
const object: BoardObject = { id: 'note', kind: 'text', text: 'Hello', bounds: { x: 50, y: 50, w: 200, h: 100 }, rotation: 0 }
const editing: BoardContext = { ...base, selectedIds: ['note'], lastCreatedIds: ['note'], objects: [object] }
const prepare = (text: string, captured = base, current = captured) => prepareTextDictation(text, captured, current)
const selected = (start: number, end: number, text?: string): BoardContext => ({ ...editing,
  contentSelection: { shapeId: 'note', field: 'text', start, end, text, coordinateSpace: 'text' } })

describe('literal text dictation', () => {
  it.each(['What is the integral of sine?', 'Delete everything.', '你想让我做什么?', 'Dr. Rivera: DNA → RNA.', 'First paragraph.\n\nSecond paragraph.', 'a\r\nb'])('writes %s verbatim without interpreting it', text => {
    expect(prepare(text)).toMatchObject({ ok: true, value: text, command: { operations: [{ type: 'create_text', text, placement: 'auto' }] } })
  })
  it('trims only outer whitespace', () => expect(prepare('  Title:  Two spaces.  ')).toMatchObject({ ok: true, value: 'Title:  Two spaces.' }))
  it.each([['world.', 'Hello world.'], [', world.', 'Hello, world.'], ['!', 'Hello!']])('joins %s appropriately', (text, value) => {
    expect(prepare(text, editing)).toMatchObject({ ok: true, value, target: 'note', command: { operations: [{ type: 'edit_content', field: 'text', target: 'note' }] } })
  })
  it('does not insert spaces between Chinese fragments', () => {
    const ctx = { ...editing, objects: [{ ...object, text: '你好' }] }
    expect(prepare('世界。', ctx)).toMatchObject({ ok: true, value: '你好世界。' })
  })
  it('uses last-created text only without explicit focus or selection', () => {
    expect(prepare('world.', { ...editing, selectedIds: [] })).toMatchObject({ ok: true, value: 'Hello world.' })
  })
  it('replaces an exact source range using canonical shapeId', () => {
    const ctx = selected(1, 4, 'ell'); ctx.contentSelection!.objectId = 'stale-alias'
    expect(prepare('ipp', ctx)).toMatchObject({ ok: true, value: 'Hippo', command: { operations: [{ start: 1, end: 4, replacement: 'ipp' }] } })
  })
  it('inserts at an exact cursor without automatic spaces', () => expect(prepare('!', selected(5, 5))).toMatchObject({ ok: true, value: 'Hello!' }))
  it('replaces a unique exact quoted selection', () => {
    expect(prepare('Goodbye', { ...editing, contentSelection: { shapeId: 'note', field: 'text', text: 'Hello' } })).toMatchObject({ ok: true, value: 'Goodbye' })
  })
  it('rejects ambiguous quoted selections', () => {
    const ctx = { ...editing, objects: [{ ...object, text: 'yes yes' }], contentSelection: { shapeId: 'note', field: 'text' as const, text: 'yes' } }
    expect(prepare('no', ctx).ok).toBe(false)
  })
  it.each([[-1, 3], [0, 50], [4, 2], [1.5, 2]])('rejects invalid range %s to %s', (start, end) => expect(prepare('x', selected(start, end)).ok).toBe(false))
  it('rejects stale selected text and MathLive coordinate ranges', () => {
    expect(prepare('x', selected(1, 4, 'old')).ok).toBe(false)
    const ctx = selected(1, 4); ctx.contentSelection!.coordinateSpace = 'mathlive'
    expect(prepare('x', ctx).ok).toBe(false)
  })
  it('creates at a new empty focus despite old selected text and source selection', () => {
    const ctx = { ...selected(0, 5), focus: { kind: 'region' as const, bounds: { x: 500, y: 200, w: 300, h: 180 }, targetIds: [] } }
    expect(prepare('New note.', ctx)).toMatchObject({ ok: true, value: 'New note.', command: { operations: [{ type: 'create_text', placement: 'focus' }] } })
  })
  it('does not select one object arbitrarily from several', () => {
    expect(prepare('text', { ...editing, selectedIds: ['note', 'other'], objects: [object, { ...object, id: 'other' }] }).ok).toBe(false)
  })
  it('creates prose beside a selected math object without editing its source', () => {
    const ctx = { ...editing, objects: [{ ...object, kind: 'math', text: undefined, latex: 'x^2' }] }
    expect(prepare('Explanation', ctx)).toMatchObject({ ok: true, command: { operations: [{ type: 'create_text' }] } })
  })
  it('rejects a locked text target', () => expect(prepare('more', { ...editing, objects: [{ ...object, locked: true }] }).ok).toBe(false))
  it.each(['assistant', 'math'] as const)('requires text mode on both snapshots: %s', dictationMode => {
    expect(prepare('words', { ...base, dictationMode }).ok).toBe(false)
    expect(prepare('words', base, { ...base, dictationMode }).ok).toBe(false)
  })
  it.each(['', ' ', 'x\0y', 'x\u001by', 'x'.repeat(6001)])('rejects empty, control, or oversized input', text => expect(prepare(text).ok).toBe(false))
  it('accepts 6000 characters but bounds the final append including its separator', () => {
    expect(prepare('x'.repeat(6000)).ok).toBe(true)
    expect(prepare('x'.repeat(5995), editing).ok).toBe(false)
    expect(prepare('x'.repeat(5994), editing)).toMatchObject({ ok: true })
  })
  it.each([
    (ctx: BoardContext) => { ctx.selectedIds = [] },
    (ctx: BoardContext) => { ctx.objects[0].text = 'Manually edited' },
    (ctx: BoardContext) => { ctx.objects[0].locked = true },
    (ctx: BoardContext) => { ctx.objects[0].bounds.x += 10 },
    (ctx: BoardContext) => { ctx.objects = [] },
    (ctx: BoardContext) => { ctx.contentSelection = { shapeId: 'note', field: 'text', text: 'Hello' } },
    (ctx: BoardContext) => { ctx.focusMode = 'literal' },
  ])('drops a stale or changed target', mutate => {
    const current = structuredClone(editing); mutate(current)
    expect(prepare('More', editing, current).ok).toBe(false)
  })
  it('ignores pointer hover and unrelated object changes', () => {
    const current = { ...editing, pointer: { x: 100, y: 200 }, objects: [object, { ...object, id: 'unrelated' }] }
    expect(prepare('More', editing, current).ok).toBe(true)
  })
  it('rejects viewport movement before automatic placement and active gestures', () => {
    expect(prepare('Text', base, { ...base, viewport: { ...base.viewport, x: 10 } }).ok).toBe(false)
    expect(prepare('Text', { ...base, gesture: { active: true, bounds: base.viewport, start: { x: 0, y: 0 }, current: { x: 1, y: 1 } } }).ok).toBe(false)
  })
})

describe('literal region and safe previews', () => {
  const region: BoardContext = { ...editing, focusMode: 'literal', focus: { kind: 'region', targetIds: ['note'], bounds: { x: 0, y: 0, w: 300, h: 200 } } }
  it('permits a text object fully inside the literal region', () => expect(prepare('world', region).ok).toBe(true))
  it('rejects a partially outside object even when its ID is focused', () => {
    expect(prepare('world', { ...region, objects: [{ ...object, bounds: { ...object.bounds, x: 200 } }] }).ok).toBe(false)
  })
  it('rejects a source target outside literal focus IDs', () => {
    const ctx = { ...region, focus: { ...region.focus!, targetIds: ['other'] }, objects: [object, { ...object, id: 'other' }], contentSelection: selected(0, 5).contentSelection }
    expect(prepare('world', ctx).ok).toBe(false)
  })
  it('requires a large enough literal creation region', () => {
    const ctx = { ...region, focus: { ...region.focus!, targetIds: [], bounds: { x: 0, y: 0, w: 79, h: 48 } } }
    expect(prepare('world', ctx).ok).toBe(false)
  })
  it('returns a preview with exactly the final literal value and never mutates snapshots', () => {
    const before = structuredClone(region)
    expect(generateTextTranscriptPreview('item', 'world.', region, region)).toMatchObject({ callId: 'transcript:item', kind: 'edit', field: 'text', value: 'Hello world.', target: 'note', complete: false })
    expect(region).toEqual(before)
    expect(generateTextTranscriptPreview('item', 'words', region, { ...region, dictationMode: 'math' })).toBeNull()
  })
})
