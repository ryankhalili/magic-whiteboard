import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import type { TLEditorSnapshot } from '../canvas/types'
import { readFileSync } from 'node:fs'
import { normalizeSnapshot } from '../canvas/migration'

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

  it('migrates a legacy-only database read-only and preserves its source records', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/legacy-canvas.json', import.meta.url), 'utf8'))
    const name = 'legacy-document:marginalia-board-v1'
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' })
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('records', 'readwrite')
      for (const record of Object.values(fixture.snapshot.document.store)) transaction.objectStore('records').put(record)
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
    })
    const { loadNotebookSnapshot } = await import('./canvasBackup')
    const migrated = await loadNotebookSnapshot('legacy', 'marginalia-board-v1')
    expect(Object.values(migrated!.document.store).filter(record => record.typeName === 'shape')).toHaveLength(6)
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('records').objectStore('records').getAll()
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    expect(Object.fromEntries(records.map(record => [(record as { id: string }).id, record]))).toEqual(fixture.snapshot.document.store)
    // Reading a migration candidate does not create an authoritative checkpoint until the app loads it.
    expect(await loadNotebookSnapshot('legacy')).toBeNull()
    database.close()
  })

  it('preserves the exact original SDK checkpoint, including encoded ink, after an owned save', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/legacy-canvas.json', import.meta.url), 'utf8'))
    const { saveNotebookSnapshot, loadNotebookSnapshot, loadOriginalNotebookSnapshot } = await import('./canvasBackup')
    await saveNotebookSnapshot('legacy', fixture.snapshot)
    const loaded = await loadNotebookSnapshot('legacy')
    const owned = normalizeSnapshot(loaded)
    await saveNotebookSnapshot('legacy', owned)
    vi.resetModules()
    const fresh = await import('./canvasBackup')
    expect(await fresh.loadNotebookSnapshot('legacy')).toEqual(owned)
    expect(await fresh.loadOriginalNotebookSnapshot('legacy')).toEqual(fixture.snapshot)
    const archived = await loadOriginalNotebookSnapshot('legacy')
    const ink = Object.values(archived!.document.store).find((record: any) => record.type === 'draw') as any
    expect(ink.props.segments[0].path).toBe('AAAAAAAAAAB2ThRKdk4USnZOFkp2ThRKdk4USnZOFEp2ThZKdk4USg==')
    expect(ink.props.points).toBeUndefined()
  })

  it('never replaces the first original archive on repeated loads or later SDK checkpoints', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/legacy-canvas.json', import.meta.url), 'utf8'))
    const { saveNotebookSnapshot, loadNotebookSnapshot, loadOriginalNotebookSnapshot } = await import('./canvasBackup')
    await saveNotebookSnapshot('legacy', fixture.snapshot)
    await loadNotebookSnapshot('legacy')
    const later = structuredClone(fixture.snapshot)
    later.session.currentPageId = 'later SDK checkpoint'
    await saveNotebookSnapshot('legacy', later)
    await loadNotebookSnapshot('legacy')
    await loadNotebookSnapshot('legacy')
    expect(await loadOriginalNotebookSnapshot('legacy')).toEqual(fixture.snapshot)
    await expect(saveNotebookSnapshot('pre-owned-canvas:legacy', later)).rejects.toThrow('read-only')
    expect(await loadOriginalNotebookSnapshot('legacy')).toEqual(fixture.snapshot)
  })

  it('blocks migration and checkpoint replacement when the original archive cannot commit', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/legacy-canvas.json', import.meta.url), 'utf8'))
    const { saveNotebookSnapshot, loadNotebookSnapshot, loadOriginalNotebookSnapshot } = await import('./canvasBackup')
    await saveNotebookSnapshot('legacy', fixture.snapshot)
    const add = IDBObjectStore.prototype.add
    const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = add.call(this, value, key)
      if (String(value.id).startsWith('pre-owned-canvas:')) this.transaction.abort()
      return request
    })
    try {
      await expect(loadNotebookSnapshot('legacy')).rejects.toThrow('could not be preserved')
      await expect(saveNotebookSnapshot('legacy', normalizeSnapshot(fixture.snapshot))).rejects.toThrow('could not be saved')
      expect(await loadOriginalNotebookSnapshot('legacy')).toBeNull()
    } finally { failure.mockRestore() }
    vi.resetModules()
    expect(await (await import('./canvasBackup')).loadNotebookSnapshot('legacy')).toEqual(fixture.snapshot)
  })

  it('refuses to replace unreadable legacy data with an empty checkpoint', async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('legacy-document:marginalia-board-broken', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('unrecognized')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    database.close()
    const { loadNotebookSnapshot } = await import('./canvasBackup')
    await expect(loadNotebookSnapshot('broken', 'marginalia-board-broken')).rejects.toThrow('data format could not be read')
    expect(await loadNotebookSnapshot('broken')).toBeNull()
  })
})
