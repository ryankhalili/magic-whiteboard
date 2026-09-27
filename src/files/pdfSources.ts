/**
 * Content keys of board imports: the same file always gets the same key, so its page images
 * are reused. Earlier versions also stored the original bytes in this IndexedDB store; imports
 * no longer do, and dropPdfSources frees what they left behind.
 */
const DATABASE = 'marginalia-pdf-sources-v1'
const STORE = 'sources'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Device storage is unavailable.')); return }
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => { database.close(); opening = null }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('Device storage is unavailable.'))
    request.onblocked = () => reject(new Error('Close other tabs of this app and try again.'))
  }).catch(error => { opening = null; throw error })
  return opening
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

let dropped = false
/** Earlier versions kept every imported original here and nothing reads them, so free that space once. */
export function dropPdfSources(): void {
  if (dropped || typeof indexedDB === 'undefined') return
  dropped = true
  try { indexedDB.deleteDatabase(DATABASE) } catch { /* storage blocked */ }
}

/** A content key such as "sha256:9f86d0...". */
export async function pdfKey(bytes: Uint8Array): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))}`
}

export async function getPdfSource(key: string): Promise<Uint8Array | null> {
  const database = await open()
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => {
      const value: unknown = request.result
      resolve(value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null)
    }
    request.onerror = () => reject(request.error)
  })
}

/** Stores bytes under their own hash only, so a crafted file can never replace another PDF. */
export async function putPdfSource(bytes: Uint8Array): Promise<string> {
  const key = await pdfKey(bytes)
  const database = await open()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const existing = store.getKey(key)
    existing.onsuccess = () => { if (existing.result === undefined) store.put(bytes.slice(), key) }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('The PDF could not be saved on this device.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('The PDF could not be saved on this device.'))
  })
  return key
}
