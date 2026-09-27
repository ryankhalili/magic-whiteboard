import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { TLEditorSnapshot } from 'tldraw'

function snapshot(name: string): TLEditorSnapshot {
  return {
    document: { schema: { schemaVersion: 2, sequences: {} }, store: {} },
    session: { testName: name },
  } as unknown as TLEditorSnapshot
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(() => { vi.unstubAllGlobals() })

describe('notebook canvas checkpoints', () => {
  it('persists independent boards and returns null for a notebook with no checkpoint', async () => {
    const { saveNotebookSnapshot, loadNotebookSnapshot } = await import('./canvasBackup')
    expect(await loadNotebookSnapshot('missing')).toBeNull()
    await saveNotebookSnapshot('algebra', snapshot('equations'))
    await saveNotebookSnapshot('biology', snapshot('cells'))
    expect(await loadNotebookSnapshot('algebra')).toEqual(snapshot('equations'))
    expect(await loadNotebookSnapshot('biology')).toEqual(snapshot('cells'))
    // A fresh module has no in-memory cache; this read must come from IndexedDB.
    vi.resetModules()
    const fresh = await import('./canvasBackup')
    expect(await fresh.loadNotebookSnapshot('algebra')).toEqual(snapshot('equations'))
  })

  it('serializes rapid writes and loads the latest queued snapshot', async () => {
    const { saveNotebookSnapshot, loadNotebookSnapshot } = await import('./canvasBackup')
    const saves = Array.from({ length: 10 }, (_, index) => saveNotebookSnapshot('one', snapshot(`edit-${index}`)))
    expect(await loadNotebookSnapshot('one')).toEqual(snapshot('edit-9'))
    await Promise.all(saves)
    vi.resetModules()
    expect(await (await import('./canvasBackup')).loadNotebookSnapshot('one')).toEqual(snapshot('edit-9'))
  })

  it('copies snapshots so later caller edits cannot mutate an in-flight save or loaded value', async () => {
    const { saveNotebookSnapshot, loadNotebookSnapshot } = await import('./canvasBackup')
    const initial = snapshot('original')
    const save = saveNotebookSnapshot('one', initial)
    ;(initial.session as unknown as { testName: string }).testName = 'mutated outside'
    await save
    const loaded = await loadNotebookSnapshot('one')
    expect(loaded).toEqual(snapshot('original'))
    ;(loaded!.session as unknown as { testName: string }).testName = 'mutated result'
    expect(await loadNotebookSnapshot('one')).toEqual(snapshot('original'))
  })

  it('reports unavailable storage, preserves the in-tab snapshot, and permits a later retry', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { saveNotebookSnapshot, loadNotebookSnapshot } = await import('./canvasBackup')
    await expect(saveNotebookSnapshot('one', snapshot('unsaved work'))).rejects.toThrow('could not be saved')
    expect(await loadNotebookSnapshot('one')).toEqual(snapshot('unsaved work'))
    await expect(loadNotebookSnapshot('unknown')).rejects.toThrow('storage could not be opened')
    vi.stubGlobal('indexedDB', new IDBFactory())
    await saveNotebookSnapshot('one', snapshot('recovered work'))
    vi.resetModules()
    expect(await (await import('./canvasBackup')).loadNotebookSnapshot('one')).toEqual(snapshot('recovered work'))
  })
})
