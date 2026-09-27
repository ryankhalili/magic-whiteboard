import type { TLEditorSnapshot } from 'tldraw'

const DATABASE = 'marginalia-canvas-backups-v1'
const STORE = 'notebooks'

type Entry = { id: string; snapshot: TLEditorSnapshot; savedAt: number }
type BackupState = {
  memory: Map<string, Entry>
  queue: Promise<void>
  database: Promise<IDBDatabase> | null
}

// Retain pending saves through development hot updates, without storing anything on window.
const state: BackupState = import.meta.hot?.data.notebookBackups ?? {
  memory: new Map<string, Entry>(), queue: Promise.resolve(), database: null,
}
if (import.meta.hot) import.meta.hot.data.notebookBackups = state

function clone(snapshot: TLEditorSnapshot): TLEditorSnapshot {
  return typeof structuredClone === 'function' ? structuredClone(snapshot) : JSON.parse(JSON.stringify(snapshot))
}

function openDatabase(): Promise<IDBDatabase> {
  if (state.database) return state.database
  state.database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable')); return }
    const request = indexedDB.open(DATABASE, 1)
    let rejected = false
    const fail = () => { rejected = true; reject(request.error || new Error('Notebook storage is unavailable')) }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onerror = fail
    request.onblocked = fail
    request.onsuccess = () => {
      if (rejected) { request.result.close(); return }
      const database = request.result
      database.onversionchange = () => { database.close(); state.database = null }
      resolve(database)
    }
  }).catch(error => { state.database = null; throw error })
  return state.database
}

async function writeEntry(entry: Entry): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Notebook save failed'))
    transaction.onabort = () => reject(transaction.error || new Error('Notebook save was interrupted'))
    transaction.objectStore(STORE).put(entry)
  })
}

/**
 * Durably checkpoint a complete board before unmounting its tldraw editor. Calls serialize
 * in invocation order, so a slower earlier save cannot overwrite a later snapshot.
 */
export function saveNotebookSnapshot(id: string, snapshot: TLEditorSnapshot): Promise<void> {
  const entry: Entry = { id, snapshot: clone(snapshot), savedAt: Date.now() }
  state.memory.set(id, entry)
  const result = state.queue.then(async () => {
    try { await writeEntry(entry) }
    catch {
      throw new Error('This notebook could not be saved to device storage. It is still available in this tab. Download an editable backup before closing or switching notebooks.')
    }
  })
  // A failed write must be reported to its caller but must not prevent a later retry.
  state.queue = result.catch(() => {})
  return result
}

/** Wait for pending writes, then load the durable checkpoint; root validates its schema. */
export async function loadNotebookSnapshot(id: string): Promise<TLEditorSnapshot | null> {
  await state.queue
  try {
    const database = await openDatabase()
    const entry = await new Promise<Entry | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error)
    })
    const cached = state.memory.get(id)
    // If the last write failed, the newer in-tab copy must not be replaced by old disk data.
    const newest = cached && (!entry || cached.savedAt >= entry.savedAt) ? cached : entry
    if (!newest?.snapshot) return null
    state.memory.set(id, newest)
    return clone(newest.snapshot)
  } catch {
    const cached = state.memory.get(id)
    if (cached) return clone(cached.snapshot)
    throw new Error('Saved notebook storage could not be opened. The current board has not been replaced; try again or open a downloaded notebook backup.')
  }
}
