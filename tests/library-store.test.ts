import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
  bookIdFor, getAnchors, getBook, getBookBytes, getPage, getPages, getThumb, listBooks, putAnchors, putBookBytes, putPages, putThumb,
  removeBook, requestPersistentStorage, saveBook, touchBook,
} from '../src/library/store'
import type { Anchor, BookRecord, PageRecord } from '../src/library/types'

function bookRecord(id: string, openedAt: number): BookRecord {
  return {
    id, title: `Book ${id}`, fileName: `${id}.pdf`, size: 10, pageCount: 3, addedAt: 1, openedAt,
    labels: [null, '1', '2'], outline: [], cover: null, indexed: true, textPages: 3,
  }
}

const pageRecord = (bookId: string, index: number): PageRecord => ({ bookId, index, label: String(index), width: 612, height: 792, text: `page ${index}`, lines: [] })
const anchor = (bookId: string, pageIndex: number, label: string): Anchor => ({
  id: `${bookId}#${pageIndex}:example:${label}`, bookId, pageIndex, kind: 'example', label, heading: `EXAMPLE ${label}`, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, snippet: '',
})

describe('library store', () => {
  it('saves, lists newest first and touches books', async () => {
    await saveBook(bookRecord('a', 100))
    await saveBook(bookRecord('b', 300))
    await saveBook(bookRecord('c', 200))
    expect((await listBooks()).map(book => book.id)).toEqual(['b', 'c', 'a'])
    expect((await getBook('c'))?.title).toBe('Book c')
    expect(await getBook('missing')).toBeNull()
    const touched = await touchBook('a')
    expect(touched?.openedAt).toBeGreaterThan(300)
    expect((await listBooks())[0].id).toBe('a')
    expect(await touchBook('missing')).toBeNull()
  })

  it('writes book bytes once', async () => {
    await putBookBytes('bytes', new Uint8Array([1, 2, 3]))
    await putBookBytes('bytes', new Uint8Array([9, 9, 9]))
    expect(Array.from((await getBookBytes('bytes'))!)).toEqual([1, 2, 3])
    expect(await getBookBytes('nothing')).toBeNull()
  })

  it('stores pages, anchors and thumbnails per book', async () => {
    await putPages([pageRecord('p', 2), pageRecord('p', 0), pageRecord('p', 1), pageRecord('q', 0)])
    expect((await getPages('p')).map(page => page.index)).toEqual([0, 1, 2])
    expect((await getPage('p', 1))?.text).toBe('page 1')
    expect(await getPage('p', 9)).toBeNull()
    expect(await getPage('p', -1)).toBeNull()
    await putAnchors([anchor('p', 2, '3.2'), anchor('p', 0, '1.1'), anchor('q', 0, '1.1')])
    expect((await getAnchors('p')).map(item => item.label)).toEqual(['1.1', '3.2'])
    await putThumb('p:0:240', 'data:image/jpeg;base64,AAAA')
    expect(await getThumb('p:0:240')).toBe('data:image/jpeg;base64,AAAA')
    expect(await getThumb('p:1:240')).toBeNull()
    await putPages([]); await putAnchors([])
  })

  it('removes a book with everything that belongs to it and nothing else', async () => {
    for (const id of ['gone', 'kept']) {
      await saveBook(bookRecord(id, 5))
      await putBookBytes(id, new Uint8Array([7]))
      await putPages([pageRecord(id, 0), pageRecord(id, 1)])
      await putAnchors([anchor(id, 0, '2.1')])
      await putThumb(`${id}:0:240`, 'data:image/jpeg;base64,BBBB')
    }
    await removeBook('gone')
    expect(await getBook('gone')).toBeNull()
    expect(await getBookBytes('gone')).toBeNull()
    expect(await getPages('gone')).toEqual([])
    expect(await getAnchors('gone')).toEqual([])
    expect(await getThumb('gone:0:240')).toBeNull()
    expect(await getBook('kept')).not.toBeNull()
    expect(await getPages('kept')).toHaveLength(2)
    expect(await getAnchors('kept')).toHaveLength(1)
    expect(await getThumb('kept:0:240')).not.toBeNull()
    await removeBook('never-there')
  })

  it('fingerprints files with sha256', async () => {
    const id = await bookIdFor(new TextEncoder().encode('abc'))
    expect(id).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('asks for persistent storage without failing where it is missing', async () => {
    await expect(requestPersistentStorage()).resolves.toBeTypeOf('boolean')
  })

  it('uses its own database name', async () => {
    const names = (await indexedDB.databases()).map(entry => entry.name)
    expect(names).toContain('magic-whiteboard-textbooks-v1')
    expect(names.some(name => name?.includes('marginalia-board'))).toBe(false)
  })

  it('rejects with a plain message when the browser has no IndexedDB', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    try {
      vi.resetModules()
      const fresh = await import('../src/library/store')
      await expect(fresh.listBooks()).rejects.toThrow(/private browsing/)
      await expect(fresh.saveBook(bookRecord('x', 1))).rejects.toThrow(/private browsing/)
    } finally {
      if (saved) Object.defineProperty(globalThis, 'indexedDB', saved)
    }
  })
})
