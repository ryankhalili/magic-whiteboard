import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/board'
import {
  LEGACY_PERSISTENCE_KEY, LEGACY_SETTINGS_KEY, NOTEBOOK_BACKUP_KEY, NOTEBOOK_RECOVERY_KEY,
  NOTEBOOK_STORAGE_KEY, NotebookRepository, parseNotebookManifest, type NotebookStorage,
} from './library'

function memoryStorage(): NotebookStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } }
}
function ids() {
  let next = 0
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
}

describe('local notebook library', () => {
  it('migrates the old notebook without changing its canvas key or explicit paper choices', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, name: 'Chemistry', paper: 'grid', backgroundColor: '#f0f4ee' }))
    const repository = new NotebookRepository(storage, () => 100, ids())
    expect(repository.getSnapshot().activeNotebook).toMatchObject({
      id: 'legacy', persistenceKey: LEGACY_PERSISTENCE_KEY,
      settings: { name: 'Chemistry', paper: 'grid', backgroundColor: '#f0f4ee' },
    })
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toContain('Chemistry')
  })

  it('updates only the paired old cream and dotted default to white and plain', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, backgroundColor: '#fbfaf6', paper: 'dots' }))
    expect(new NotebookRepository(storage).getSnapshot().activeNotebook.settings).toMatchObject({ backgroundColor: '#ffffff', paper: 'plain' })
  })

  it('also migrates an already-created notebook manifest from the earlier default theme', () => {
    const storage = memoryStorage()
    new NotebookRepository(storage)
    const manifest = JSON.parse(storage.getItem(NOTEBOOK_STORAGE_KEY)!)
    manifest.notebooks[0].settings.backgroundColor = '#fbfaf6'
    manifest.notebooks[0].settings.paper = 'dots'
    storage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(manifest))
    const restored = new NotebookRepository(storage)
    expect(restored.getSnapshot().activeNotebook.settings).toMatchObject({ backgroundColor: '#ffffff', paper: 'plain' })
  })

  it('creates independent boards and persists the active notebook, names, and settings', () => {
    const storage = memoryStorage()
    const repository = new NotebookRepository(storage, () => 100, ids())
    const id = repository.createNotebook('Calculus')
    repository.updateNotebookSettings(id, { ...DEFAULT_SETTINGS, name: 'Integration', mode: 'page', paper: 'ruled' })
    repository.selectNotebook('legacy')
    expect(repository.getSnapshot().activeNotebook.persistenceKey).toBe(LEGACY_PERSISTENCE_KEY)
    repository.selectNotebook(id)
    const restored = new NotebookRepository(storage)
    expect(restored.getSnapshot().notebooks).toHaveLength(2)
    expect(restored.getSnapshot().activeNotebook).toMatchObject({ id, persistenceKey: `marginalia-board-${id}`, settings: { name: 'Integration', mode: 'page', paper: 'ruled' } })
    expect(restored.getSnapshot().notebooks[0].settings.name).not.toBe('Integration')
  })

  it('recovers a damaged manifest from its backup and preserves the unreadable data', () => {
    const storage = memoryStorage()
    const repository = new NotebookRepository(storage, () => 100, ids())
    const id = repository.createNotebook('Physics')
    storage.setItem(NOTEBOOK_BACKUP_KEY, storage.getItem(NOTEBOOK_STORAGE_KEY)!)
    storage.setItem(NOTEBOOK_STORAGE_KEY, '{broken')
    const restored = new NotebookRepository(storage)
    expect(restored.getSnapshot().activeNotebook.id).toBe(id)
    expect(restored.getSnapshot().storageWarning).toContain('backup')
    expect(storage.getItem(NOTEBOOK_RECOVERY_KEY)).toBe('{broken')
  })

  it('keeps the current board accessible and refuses an unsavable new notebook', () => {
    const storage: NotebookStorage = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } }
    const repository = new NotebookRepository(storage, () => 100, ids())
    expect(repository.getSnapshot().storageWarning).toBeTruthy()
    expect(() => repository.createNotebook('Do not lose this')).toThrow('storage')
    expect(repository.getSnapshot().notebooks).toHaveLength(1)
    expect(repository.getSnapshot().activeNotebook.id).toBe('legacy')
  })

  it('merges notebooks from another tab without switching this tab or dropping titles', () => {
    const storage = memoryStorage()
    const idFactory = ids()
    const one = new NotebookRepository(storage, () => 100, idFactory)
    const two = new NotebookRepository(storage, () => 100, idFactory)
    const first = one.createNotebook('Biology')
    const second = two.createNotebook('Geometry')
    one.refresh()
    expect(one.getSnapshot().notebooks).toHaveLength(3)
    expect(one.getSnapshot().activeNotebook.id).toBe(first)
    one.renameNotebook(first, 'Cell biology')
    two.refresh()
    expect(two.getSnapshot().activeNotebook.id).toBe(second)
    expect(two.getSnapshot().notebooks.find(notebook => notebook.id === first)?.settings.name).toBe('Cell biology')
  })

  it('derives each persistence key from its identity, ignoring forged shared keys', () => {
    const storage = memoryStorage()
    const repository = new NotebookRepository(storage, () => 100, ids())
    const id = repository.createNotebook('Independent')
    const manifest = JSON.parse(storage.getItem(NOTEBOOK_STORAGE_KEY)!)
    manifest.notebooks[1].persistenceKey = LEGACY_PERSISTENCE_KEY
    expect(parseNotebookManifest(JSON.stringify(manifest))?.notebooks[1].persistenceKey).toBe(`marginalia-board-${id}`)
  })

  it('preserves a newer remote title when a stale tab changes only the paper', () => {
    const storage = memoryStorage()
    const first = new NotebookRepository(storage, () => 100, ids())
    const second = new NotebookRepository(storage, () => 100, ids())
    const staleSettings = second.getSnapshot().activeNotebook.settings
    first.renameNotebook('legacy', 'A newer title')
    second.updateNotebookSettings('legacy', { ...staleSettings, paper: 'grid' })
    expect(second.getSnapshot().activeNotebook.settings).toMatchObject({ name: 'A newer title', paper: 'grid' })
    expect(new NotebookRepository(storage).getSnapshot().activeNotebook.settings).toMatchObject({ name: 'A newer title', paper: 'grid' })
  })

  it('defaults legacy notebooks to reference focus and persists literal focus independently', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ name: 'Existing notes', mode: 'infinite', paper: 'plain', backgroundColor: '#ffffff' }))
    const repository = new NotebookRepository(storage, () => 100, ids())
    expect(repository.getSnapshot().activeNotebook.settings.focusMode).toBe('reference')
    const id = repository.createNotebook('Precise layout')
    expect(repository.getSnapshot().activeNotebook.settings.focusMode).toBe('reference')
    repository.updateNotebookSettings(id, { ...repository.getSnapshot().activeNotebook.settings, focusMode: 'literal' })
    const restored = new NotebookRepository(storage)
    expect(restored.getSnapshot().activeNotebook.settings.focusMode).toBe('literal')
    expect(restored.getSnapshot().notebooks.find(notebook => notebook.id === 'legacy')?.settings.focusMode).toBe('reference')
  })
})
