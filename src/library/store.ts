import { closeBookPdf } from './pdfjs'
import type { Anchor, BookRecord, PageRecord } from './types'

const DB_NAME = 'magic-whiteboard-textbooks-v1'
const STORES = ['books', 'files', 'pages', 'anchors', 'thumbs'] as const
type StoreName = typeof STORES[number]

const UNAVAILABLE = 'This browser is not letting the app save textbooks. Turn off private browsing or allow site storage, then try again.'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.reject(new Error(UNAVAILABLE))
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try { request = indexedDB.open(DB_NAME, 1) } catch { reject(new Error(UNAVAILABLE)); return }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: ['bookId', 'index'] }).createIndex('bookId', 'bookId')
      if (!db.objectStoreNames.contains('anchors')) db.createObjectStore('anchors', { keyPath: 'id' }).createIndex('bookId', 'bookId')
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); opening = null }
      db.onclose = () => { opening = null }
      resolve(db)
    }
    request.onerror = () => reject(new Error(UNAVAILABLE))
    request.onblocked = () => reject(new Error('Close the other tabs of this app, then try again.'))
  }).catch(error => { opening = null; throw error })
  return opening
}

function friendly(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'QuotaExceededError') return new Error('This device is out of storage space for textbooks. Remove a book from the library and try again.')
  if (error instanceof Error && error.message === UNAVAILABLE) return error
  return new Error('The textbook library could not be read or saved. Reload the page and try again.')
}

/** Runs work inside one transaction and resolves with its result once the transaction commits. */
async function transact<T>(names: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
  let db: IDBDatabase
  try { db = await open() } catch (error) { throw friendly(error) }
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try { tx = db.transaction(names, mode) } catch (error) { opening = null; reject(friendly(error)); return }
    let result: T
    let failed: unknown = null
    tx.oncomplete = () => failed ? reject(friendly(failed)) : resolve(result)
    tx.onerror = () => reject(friendly(tx.error))
    tx.onabort = () => reject(friendly(tx.error ?? failed))
    Promise.resolve().then(() => work(tx)).then(value => { result = value }, error => {
      failed = error
      try { tx.abort() } catch { /* already finished */ }
    })
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listBooks(): Promise<BookRecord[]> {
  const books = await transact(['books'], 'readonly', tx => request(tx.objectStore('books').getAll() as IDBRequest<BookRecord[]>))
  return books.filter(book => book && typeof book.id === 'string').sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
}

export async function getBook(id: string): Promise<BookRecord | null> {
  const book = await transact(['books'], 'readonly', tx => request(tx.objectStore('books').get(id) as IDBRequest<BookRecord | undefined>))
  return book ?? null
}

export async function saveBook(book: BookRecord): Promise<void> {
  await transact(['books'], 'readwrite', tx => { tx.objectStore('books').put(book) })
}

export async function touchBook(id: string): Promise<BookRecord | null> {
  return transact(['books'], 'readwrite', async tx => {
    const store = tx.objectStore('books')
    const book = await request(store.get(id) as IDBRequest<BookRecord | undefined>)
    if (!book) return null
    const next = { ...book, openedAt: Date.now() }
    store.put(next)
    return next
  })
}

/** Write once: an existing file is never replaced, so a crafted file cannot overwrite another book. */
export async function putBookBytes(id: string, bytes: Uint8Array): Promise<void> {
  await transact(['files'], 'readwrite', async tx => {
    const store = tx.objectStore('files')
    const key = await request(store.getKey(id))
    if (key === undefined) store.put(bytes, id)
  })
}

export async function getBookBytes(id: string): Promise<Uint8Array | null> {
  const value = await transact(['files'], 'readonly', tx => request(tx.objectStore('files').get(id) as IDBRequest<unknown>))
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  return null
}

export async function putPages(pages: PageRecord[]): Promise<void> {
  if (!pages.length) return
  await transact(['pages'], 'readwrite', tx => { const store = tx.objectStore('pages'); for (const page of pages) store.put(page) })
}

export async function getPages(bookId: string): Promise<PageRecord[]> {
  const pages = await transact(['pages'], 'readonly', tx => request(tx.objectStore('pages').index('bookId').getAll(bookId) as IDBRequest<PageRecord[]>))
  return pages.sort((a, b) => a.index - b.index)
}

export async function getPage(bookId: string, index: number): Promise<PageRecord | null> {
  if (!Number.isInteger(index) || index < 0) return null
  const page = await transact(['pages'], 'readonly', tx => request(tx.objectStore('pages').get([bookId, index]) as IDBRequest<PageRecord | undefined>))
  return page ?? null
}

export async function putAnchors(anchors: Anchor[]): Promise<void> {
  if (!anchors.length) return
  await transact(['anchors'], 'readwrite', tx => { const store = tx.objectStore('anchors'); for (const anchor of anchors) store.put(anchor) })
}

export async function getAnchors(bookId: string): Promise<Anchor[]> {
  const anchors = await transact(['anchors'], 'readonly', tx => request(tx.objectStore('anchors').index('bookId').getAll(bookId) as IDBRequest<Anchor[]>))
  return anchors.sort((a, b) => a.pageIndex - b.pageIndex || a.box.y - b.box.y || a.box.x - b.box.x)
}

export async function getThumb(key: string): Promise<string | null> {
  const src = await transact(['thumbs'], 'readonly', tx => request(tx.objectStore('thumbs').get(key) as IDBRequest<unknown>))
  return typeof src === 'string' ? src : null
}

export async function putThumb(key: string, src: string): Promise<void> {
  await transact(['thumbs'], 'readwrite', tx => { tx.objectStore('thumbs').put(src, key) })
}

/** Deletes the book with its file, pages, items and thumbnails. */
export async function removeBook(id: string): Promise<void> {
  closeBookPdf(id)
  await transact([...STORES], 'readwrite', async tx => {
    tx.objectStore('books').delete(id)
    tx.objectStore('files').delete(id)
    tx.objectStore('pages').delete(IDBKeyRange.bound([id], [id, []]))
    tx.objectStore('thumbs').delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`))
    const keys = await request(tx.objectStore('anchors').index('bookId').getAllKeys(id))
    const anchors = tx.objectStore('anchors')
    for (const key of keys) anchors.delete(key)
  })
}

let persisting: Promise<boolean> | null = null

/** Asks the browser once not to evict the library when space runs low. */
export function requestPersistentStorage(): Promise<boolean> {
  persisting ??= (async () => {
    try {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
      if (!storage?.persist) return false
      if (await storage.persisted?.()) return true
      return await storage.persist()
    } catch { return false }
  })()
  return persisting
}

/** 'sha256:<64 hex>' of the file bytes. */
export async function bookIdFor(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('This browser cannot fingerprint files. Open the app over https or localhost.')
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
