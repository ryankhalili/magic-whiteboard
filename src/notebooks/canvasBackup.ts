import type { TLEditorSnapshot } from '../canvas/types'
import { normalizeSnapshot } from '../canvas/migration'

const DATABASE = 'marginalia-canvas-backups-v1'
const STORE = 'notebooks'
const ORIGINAL_PREFIX = 'pre-owned-canvas:'

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

function isSdkSnapshot(snapshot: TLEditorSnapshot | undefined): boolean {
  const schema = snapshot?.document?.schema
  return !!schema && schema.engine !== 'magic-whiteboard' && (schema.schemaVersion === 2 ||
    !!schema.sequences && typeof schema.sequences === 'object' && Object.keys(schema.sequences).some(key => key.startsWith('com.tldraw.')))
}

class OriginalArchiveError extends Error {
  constructor() {
    super('The original notebook checkpoint could not be preserved before migration. Its saved copy has not been replaced. Free device storage or download an editable backup from the previous app, then try again.')
  }
}

/** Run inside a readwrite transaction so concurrent tabs cannot replace the first archive. */
function archiveWithinTransaction(store: IDBObjectStore, entry: Entry | undefined, done: () => void): void {
  if (!entry || !isSdkSnapshot(entry.snapshot)) { done(); return }
  const id = `${ORIGINAL_PREFIX}${entry.id}`
  const request = store.get(id)
  request.onsuccess = () => {
    if (!request.result) store.add({ ...entry, id })
    // add and any subsequent checkpoint put commit or abort together.
    done()
  }
}

async function preserveOriginalCheckpoint(entry: Entry): Promise<void> {
  if (!isSdkSnapshot(entry.snapshot)) return
  try {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      archiveWithinTransaction(transaction.objectStore(STORE), entry, () => {})
    })
  } catch { throw new OriginalArchiveError() }
}

async function writeEntry(entry: Entry): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Notebook save failed'))
    transaction.onabort = () => reject(transaction.error || new Error('Notebook save was interrupted'))
    const store = transaction.objectStore(STORE)
    const request = store.get(entry.id)
    request.onsuccess = () => archiveWithinTransaction(store, request.result as Entry | undefined, () => { store.put(entry) })
  })
}

/**
 * Durably checkpoint a complete board before unmounting its editor. Calls serialize
 * in invocation order, so a slower earlier save cannot overwrite a later snapshot.
 */
export function saveNotebookSnapshot(id: string, snapshot: TLEditorSnapshot): Promise<void> {
  if (id.startsWith(ORIGINAL_PREFIX)) return Promise.reject(new Error('Original notebook archives are read-only.'))
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

/** Read the former SDK's document records without modifying or deleting its database. */
export async function loadLegacyNotebookSnapshot(persistenceKey: string): Promise<TLEditorSnapshot | null> {
  if (typeof indexedDB === 'undefined') throw new Error('Saved notebook storage could not be opened.')
  if (typeof indexedDB.databases !== 'function') {
    throw new Error('This browser cannot check for earlier notebooks. Open this notebook in the previous app and download an editable backup, then import it here. Existing saved data has not changed.')
  }
  const databases = await indexedDB.databases()
  const matches = databases.filter(info => info.name && info.name !== DATABASE && info.name.includes(persistenceKey))
  if (!matches.length) return null
  const candidates: TLEditorSnapshot[] = []
  for (const info of matches) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(info.name!)
      // A concurrently removed database must not be silently recreated during migration.
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('The earlier notebook database changed while opening. Please try again.')) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Close the earlier notebook tab and try again.'))
    })
    try {
      const store: Record<string, unknown> = Object.create(null)
      let count = 0
      const collect = (value: unknown, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 3) return
        if (Array.isArray(value)) { for (const child of value) collect(child, depth + 1); return }
        const record = value as Record<string, unknown>
        if (typeof record.id === 'string' && typeof record.typeName === 'string') {
          if (!store[record.id] && ++count > 20_000) throw new Error('The earlier notebook contains too many records to migrate.')
          store[record.id] = record
        } else for (const child of Object.values(record)) collect(child, depth + 1)
      }
      for (const name of Array.from(database.objectStoreNames)) {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction(name, 'readonly')
          const request = transaction.objectStore(name).getAll(undefined, 20_001)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
          transaction.onabort = () => reject(transaction.error)
        })
        if (records.length > 20_000) throw new Error('The earlier notebook is too large to migrate automatically.')
        for (const record of records) collect(record)
      }
      if (!Object.keys(store).length) throw new Error('An earlier notebook was found but its data format could not be read. Download an editable backup from the previous app and import it here. Existing saved data has not changed.')
      candidates.push(normalizeSnapshot({ document: { schema: {}, store } }))
    } finally { database.close() }
  }
  if (candidates.length > 1) throw new Error('Multiple earlier copies of this notebook were found. Export the correct notebook from the previous app and import it here. Existing saved data has not changed.')
  return candidates[0]
}

/** Wait for pending writes, then load a checkpoint or read-only migration candidate. */
export async function loadNotebookSnapshot(id: string, persistenceKey?: string): Promise<TLEditorSnapshot | null> {
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
    if (!newest?.snapshot) return persistenceKey ? loadLegacyNotebookSnapshot(persistenceKey) : null
    // Preserve exact original records before the caller can normalize and save.
    await preserveOriginalCheckpoint(entry && isSdkSnapshot(entry.snapshot) ? entry : newest)
    state.memory.set(id, newest)
    return clone(newest.snapshot)
  } catch (error) {
    if (error instanceof OriginalArchiveError) throw error
    const cached = state.memory.get(id)
    if (cached) return clone(cached.snapshot)
    throw new Error(`Saved notebook storage could not be opened. The current board has not been replaced; try again or open a downloaded notebook backup.${error instanceof Error ? ` ${error.message}` : ''}`)
  }
}

/** Read the first raw SDK checkpoint for rollback/export recovery. Never normalizes it. */
export async function loadOriginalNotebookSnapshot(id: string): Promise<TLEditorSnapshot | null> {
  await state.queue
  const database = await openDatabase()
  const entry = await new Promise<Entry | undefined>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(`${ORIGINAL_PREFIX}${id}`)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    transaction.onabort = () => reject(transaction.error)
  })
  return entry?.snapshot ? clone(entry.snapshot) : null
}
