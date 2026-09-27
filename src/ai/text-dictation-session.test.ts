import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardContext, BoardOperation, BoardResult } from '../../shared/board'
import { applyContentEdit } from '../board/contentEdit'
import { createTextDictationSession } from './text-dictation-session'

const base: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [],
  viewport: { x: 0, y: 0, w: 1000, h: 800 }, dictationMode: 'text' }
const existing: BoardContext = { ...base, selectedIds: ['note'], lastCreatedIds: ['note'], objects: [
  { id: 'note', kind: 'text', text: 'Hello', bounds: { x: 0, y: 0, w: 300, h: 100 }, rotation: 0 },
] }
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(initial = base, extra: Partial<Parameters<typeof createTextDictationSession>[0]> = {}) {
  let current = structuredClone(initial), count = 0
  const notices = vi.fn(), applied = vi.fn()
  const apply = vi.fn((operations: BoardOperation[]): BoardResult => {
    const operation = operations[0]
    const id = operation.target ?? `created-${++count}`
    if (operation.type === 'create_text') {
      current.objects.push({ id, kind: 'text', text: operation.text, rotation: 0, bounds: current.focus?.bounds ?? { x: 0, y: 0, w: 300, h: 100 } })
      current.lastCreatedIds = [id]
    } else {
      const object = current.objects.find(item => item.id === id)!
      object.text = applyContentEdit(object.text!, operation)
    }
    current.selectedIds = [id]
    current.lastCreatedIds = [id]
    return { ok: true, message: 'Updated', ids: [id] }
  })
  const session = createTextDictationSession({ getContext: () => current, applyOperations: apply, onNotice: notices, onApplied: applied, ...extra })
  return { session, apply, notices, applied, context: () => structuredClone(current), change: (mutate: (ctx: BoardContext) => void) => mutate(current), text: () => current.objects.map(item => item.text) }
}
afterEach(() => vi.useRealTimers())

describe('ordered local text dictation', () => {
  it('accepts final transcription before commit and applies literally once', async () => {
    const f = fixture()
    f.session.transcript('one', 'What is photosynthesis?'); f.session.enqueue('one', f.context())
    await settle()
    f.session.transcript('one', 'A semantic answer'); expect(f.session.enqueue('one', f.context())).toBe(false)
    await settle()
    expect(f.text()).toEqual(['What is photosynthesis?']); expect(f.apply).toHaveBeenCalledTimes(1)
  })
  it('accepts a final arriving after an earlier failure but before commit', async () => {
    const resolve = vi.fn(async () => 'Recovery'), f = fixture(base, { resolveTranscript: resolve })
    f.session.fail('one'); f.session.transcript('one', 'Authoritative final.'); f.session.enqueue('one', f.context()); await settle()
    expect(f.text()).toEqual(['Authoritative final.']); expect(resolve).not.toHaveBeenCalled()
  })
  it('applies out-of-order transcripts in commit order and rebases only its own text append', async () => {
    const f = fixture(existing), captured = f.context()
    f.session.enqueue('one', captured); f.session.enqueue('two', captured); f.session.enqueue('three', captured)
    f.session.transcript('three', 'third.'); f.session.transcript('two', 'second,'); await settle()
    expect(f.apply).not.toHaveBeenCalled()
    f.session.transcript('one', 'first,'); await settle()
    expect(f.text()).toEqual(['Hello first, second, third.']); expect(f.notices).not.toHaveBeenCalled()
    expect(f.applied.mock.calls.map(call => call[0])).toEqual(['one', 'two', 'three'])
  })
  it('creates once and then appends across queued and later turns in an unchanged empty focus', async () => {
    const focus = { kind: 'region' as const, bounds: { x: 400, y: 50, w: 300, h: 200 }, targetIds: [] }
    const f = fixture({ ...existing, focus }), captured = f.context()
    f.session.enqueue('one', captured); f.session.enqueue('two', captured)
    f.session.transcript('one', 'New'); f.session.transcript('two', 'paragraph.'); await settle()
    expect(f.text()).toEqual(['Hello', 'New paragraph.'])
    expect(f.session.preview('three', 'More.', f.context())).toMatchObject({ kind: 'edit', value: 'New paragraph. More.', target: 'created-1' })
    f.session.enqueue('three', f.context()); f.session.transcript('three', 'More.'); await settle()
    expect(f.text()).toEqual(['Hello', 'New paragraph. More.'])
    expect(f.apply.mock.calls.map(call => call[0][0].type)).toEqual(['create_text', 'edit_content', 'edit_content'])
  })
  it('supports a late commit captured before the preceding own edit finished', async () => {
    const f = fixture(existing), captured = f.context()
    f.session.enqueue('one', captured); f.session.transcript('one', 'world.'); await settle()
    f.session.enqueue('two', captured); f.session.transcript('two', 'Next.'); await settle()
    expect(f.text()).toEqual(['Hello world. Next.'])
  })
  it('rebases edits when the controller changes lastCreatedIds to the selected target', async () => {
    const f = fixture({ ...existing, lastCreatedIds: ['older-object'] }), captured = f.context()
    f.session.enqueue('one', captured); f.session.enqueue('two', captured)
    f.session.transcript('one', 'world.'); f.session.transcript('two', 'Next.'); await settle()
    expect(f.context().lastCreatedIds).toEqual(['note'])
    expect(f.text()).toEqual(['Hello world. Next.']); expect(f.notices).not.toHaveBeenCalled()
  })
  it('creates another block after explicitly choosing a different empty focus', async () => {
    const f = fixture({ ...base, focus: { kind: 'region', bounds: { x: 0, y: 0, w: 300, h: 100 }, targetIds: [] } })
    f.session.enqueue('one', f.context()); f.session.transcript('one', 'First'); await settle()
    f.change(ctx => { ctx.focus!.bounds.x = 500 }); f.session.updateContext()
    f.session.enqueue('two', f.context()); f.session.transcript('two', 'Second'); await settle()
    expect(f.text()).toEqual(['First', 'Second'])
  })
  it('does not reuse a consumed source selection for the next phrase', async () => {
    const f = fixture({ ...existing, contentSelection: { shapeId: 'note', field: 'text', coordinateSpace: 'text', start: 0, end: 5 } }), captured = f.context()
    f.session.enqueue('one', captured); f.session.enqueue('two', captured)
    f.session.transcript('one', 'Goodbye'); f.session.transcript('two', 'Replace again'); await settle()
    expect(f.text()).toEqual(['Goodbye']); expect(f.apply).toHaveBeenCalledTimes(1); expect(f.notices).toHaveBeenCalled()
    expect(f.session.preview('three', 'again', f.context())).toBeNull()
  })
  it('drops all pending phrases after a target switch, even if the original target returns', async () => {
    const f = fixture(existing)
    f.session.enqueue('one', f.context()); f.session.enqueue('two', f.context())
    f.change(ctx => { ctx.selectedIds = [] }); f.session.updateContext()
    f.change(ctx => { ctx.selectedIds = ['note'] }); f.session.updateContext()
    f.session.transcript('one', 'late'); f.session.transcript('two', 'late'); await settle()
    expect(f.apply).not.toHaveBeenCalled(); expect(f.notices).toHaveBeenCalledTimes(1)
  })
  it('revalidates after flushing manual source drafts', async () => {
    const flush = vi.fn(() => f.change(ctx => { ctx.objects[0].text = 'Manual source edit' }))
    const f = fixture(existing, { beforeApplyOperations: flush })
    f.session.enqueue('one', f.context()); f.session.transcript('one', 'late'); await settle()
    expect(flush).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled(); expect(f.text()).toEqual(['Manual source edit'])
  })
  it('does not rebase through an unrelated edit made during apply', async () => {
    const f = fixture(existing), original = f.apply.getMockImplementation()!
    f.apply.mockImplementation(ops => { const result = original(ops); f.change(ctx => { ctx.viewport.x += 1 }); return result })
    f.session.enqueue('one', f.context()); f.session.enqueue('two', f.context())
    f.session.transcript('one', 'world.'); f.session.transcript('two', 'Next'); await settle()
    // The unrelated change prevents certifying the preceding edit for automatic rebase.
    expect(f.text()[0]).toBe('Hello world.'); expect(f.apply).toHaveBeenCalledTimes(1)
  })
  it('ignores pointer hover between its own edits', async () => {
    const f = fixture(existing)
    f.session.enqueue('one', f.context()); f.session.transcript('one', 'world.'); await settle()
    f.change(ctx => { ctx.pointer = { x: 999, y: 500 } }); f.session.updateContext()
    f.session.enqueue('two', f.context()); f.session.transcript('two', 'Next'); await settle()
    expect(f.text()).toEqual(['Hello world. Next'])
  })
  it('keeps the created text anchor while a library book or reference page changes', async () => {
    const f = fixture({ ...base, focus: { kind: 'region', bounds: { x: 0, y: 0, w: 400, h: 200 }, targetIds: [] } })
    f.session.enqueue('one', f.context()); f.session.transcript('one', 'First sentence.'); await settle()
    f.change(ctx => { ctx.library = { openBook: { title: 'Biology' }, books: [{ title: 'Biology', pages: 300 }], panelPage: { label: '12', pageIndex: 15 } } })
    f.session.updateContext()
    expect(f.session.preview('two', 'Next sentence.', f.context())).toMatchObject({ target: 'created-1', kind: 'edit', value: 'First sentence. Next sentence.' })
    f.session.enqueue('two', f.context())
    f.change(ctx => { ctx.library!.panelPage = { label: '13', pageIndex: 16 } }); f.session.updateContext()
    f.session.transcript('two', 'Next sentence.'); await settle()
    expect(f.text()).toEqual(['First sentence. Next sentence.']); expect(f.notices).not.toHaveBeenCalled()
  })
  it('certifies an own edit when only library metadata changes during application', async () => {
    const f = fixture(existing), original = f.apply.getMockImplementation()!, captured = f.context()
    f.apply.mockImplementation(ops => {
      const result = original(ops)
      f.change(ctx => { ctx.library = { openBook: null, books: [], highlights: ['Example 3.2'] } })
      return result
    })
    f.session.enqueue('one', captured); f.session.enqueue('two', captured)
    f.session.transcript('one', 'world.'); f.session.transcript('two', 'Next.'); await settle()
    expect(f.text()).toEqual(['Hello world. Next.']); expect(f.notices).not.toHaveBeenCalled()
  })
  it('still drops a pending phrase if its source changes while library metadata also changes', async () => {
    const f = fixture(existing)
    f.session.enqueue('one', f.context())
    f.change(ctx => {
      ctx.library = { openBook: { title: 'Biology' }, books: [] }
      ctx.objects[0].text = 'A manual source edit'
    })
    f.session.updateContext(); f.session.transcript('one', 'Late phrase'); await settle()
    expect(f.apply).not.toHaveBeenCalled(); expect(f.text()).toEqual(['A manual source edit']); expect(f.notices).toHaveBeenCalledOnce()
  })
  it('cancels pending work on Stop/reset or leaving text mode', async () => {
    for (const modeSwitch of [false, true]) {
      const f = fixture(existing)
      f.session.enqueue('one', f.context())
      if (modeSwitch) { f.change(ctx => { ctx.dictationMode = 'assistant' }); f.session.updateContext() } else f.session.reset()
      f.session.transcript('one', 'late'); await settle(); expect(f.apply).not.toHaveBeenCalled()
    }
  })
  it('bounds the pending queue at eight turns and keeps accepted order', async () => {
    const f = fixture(existing), captured = f.context()
    for (let i = 0; i < 8; i++) expect(f.session.enqueue(String(i), captured)).toBe(true)
    expect(f.session.enqueue('overflow', captured)).toBe(false)
    for (let i = 7; i >= 0; i--) f.session.transcript(String(i), String(i))
    await settle(); await settle(); await settle()
    expect(f.apply).toHaveBeenCalledTimes(8); expect(f.text()).toEqual(['Hello 0 1 2 3 4 5 6 7'])
  })
  it('does not retry a failed board operation or expose provider error text', async () => {
    const f = fixture(existing, { applyOperations: () => ({ ok: false, message: '你想让我做什么?', ids: [] }) })
    f.session.enqueue('one', f.context()); f.session.transcript('one', 'Text'); await settle()
    expect(f.applied).not.toHaveBeenCalled(); expect(f.notices.mock.calls[0][0]).toContain('could not be written')
    expect(f.notices.mock.calls[0][0]).not.toContain('你')
  })
  it('reports pending until the queue settles and invokes onIdle after success', async () => {
    const idle = vi.fn(() => expect(f.session.isPending()).toBe(false)), f = fixture(base, { onIdle: idle })
    expect(f.session.isPending()).toBe(false)
    f.session.enqueue('one', f.context()); expect(f.session.isPending()).toBe(true)
    f.session.transcript('one', 'Done.'); await settle()
    expect(f.session.isPending()).toBe(false); expect(idle).toHaveBeenCalledOnce()
  })
})

describe('bounded transcription recovery', () => {
  it('waits six seconds then invokes injected exact-audio recovery once', async () => {
    vi.useFakeTimers()
    const resolve = vi.fn(async () => 'Recovered words.'), state = vi.fn(), f = fixture(base, { resolveTranscript: resolve, onRecoveryState: state })
    f.session.enqueue('one', f.context()); await vi.advanceTimersByTimeAsync(5999); expect(resolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await settle()
    expect(resolve).toHaveBeenCalledWith('one', expect.any(AbortSignal)); expect(f.text()).toEqual(['Recovered words.'])
    expect(state.mock.calls).toEqual([[true], [false]])
  })
  it('starts fallback immediately after a failed transcription notification', async () => {
    const resolve = vi.fn(async () => 'Recovered.'), f = fixture(base, { resolveTranscript: resolve })
    f.session.fail('one'); f.session.enqueue('one', f.context()); await settle()
    expect(resolve).toHaveBeenCalledOnce(); expect(f.text()).toEqual(['Recovered.'])
  })
  it('uses a late authoritative final and aborts the pending fallback', async () => {
    const result = deferred<string>(), resolve = vi.fn((_id: string, _signal: AbortSignal) => result.promise), f = fixture(base, { resolveTranscript: resolve })
    f.session.enqueue('one', f.context()); f.session.fail('one'); await settle()
    f.session.transcript('one', 'Final transcript.'); await settle()
    expect(resolve.mock.calls[0][1].aborted).toBe(true); expect(f.text()).toEqual(['Final transcript.'])
    result.resolve('Wrong late fallback'); await settle(); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('aborts fallback on reset and ignores its late result', async () => {
    const result = deferred<string>(), resolve = vi.fn((_id: string, _signal: AbortSignal) => result.promise), state = vi.fn()
    const f = fixture(base, { resolveTranscript: resolve, onRecoveryState: state })
    f.session.enqueue('one', f.context()); f.session.fail('one'); await settle()
    f.session.reset(); result.resolve('Late result'); await settle()
    expect(resolve.mock.calls[0][1].aborted).toBe(true); expect(f.apply).not.toHaveBeenCalled(); expect(state).toHaveBeenLastCalledWith(false)
  })
  it('bounds a stalled injected recovery and continues with the next phrase', async () => {
    vi.useFakeTimers()
    const f = fixture(existing, { resolveTranscript: () => new Promise(() => {}) })
    f.session.enqueue('one', f.context()); f.session.enqueue('two', f.context()); f.session.fail('one'); f.session.transcript('two', 'Next.'); await settle()
    await vi.advanceTimersByTimeAsync(25000); await settle()
    expect(f.text()).toEqual(['Hello Next.']); expect(f.notices).toHaveBeenCalledTimes(1)
  })
  it('reports a recoverable English notice when transcription fails', async () => {
    const idle = vi.fn(), f = fixture(base, { onIdle: idle, resolveTranscript: async () => { throw new Error('你想让我做什么?') } })
    f.session.enqueue('one', f.context()); f.session.fail('one'); await settle()
    expect(f.apply).not.toHaveBeenCalled(); expect(f.notices.mock.calls[0][0]).toBe("I couldn't transcribe that phrase. Please repeat it.")
    expect(f.session.isPending()).toBe(false); expect(idle).toHaveBeenCalledOnce()
  })
})
