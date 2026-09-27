import { useEffect, useState, useSyncExternalStore } from 'react'
import { NOTEBOOK_STORAGE_KEY, NotebookRepository, type NotebookLibraryState } from './library'

export interface NotebookLibraryController extends NotebookLibraryState {
  createNotebook: NotebookRepository['createNotebook']
  selectNotebook: NotebookRepository['selectNotebook']
  updateNotebookSettings: NotebookRepository['updateNotebookSettings']
  renameNotebook: NotebookRepository['renameNotebook']
}

export function useNotebookLibrary(): NotebookLibraryController {
  const [repository] = useState(() => {
    try { return new NotebookRepository(window.localStorage) }
    catch { return new NotebookRepository(null) }
  })
  const state = useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot)
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === NOTEBOOK_STORAGE_KEY) repository.refresh()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [repository])
  return {
    ...state,
    createNotebook: repository.createNotebook, selectNotebook: repository.selectNotebook,
    updateNotebookSettings: repository.updateNotebookSettings, renameNotebook: repository.renameNotebook,
  }
}
