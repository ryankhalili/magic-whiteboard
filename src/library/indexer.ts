import type { PDFDocumentProxy } from 'pdfjs-dist'
import { bodyFontSize, detectAnchors, type OpenItem } from './anchors'
import { assignPrintedLabels } from './labels'
import { closePdf, hasPdfHeader, openPdf, pageLines } from './pdfjs'
import { thumbFromPage } from './render'
import { bookIdFor, getAnchors, getBook, getBookBytes, putAnchors, putBookBytes, putPages, putThumb, removeAnchors, removeBook, replaceBook, requestPersistentStorage, saveBook, touchBook } from './store'
import type { Anchor, BookRecord, ImportProgress, PageRecord } from './types'

export const MAX_BOOK_BYTES = 400 * 1024 * 1024
const BATCH = 25
/** bumped whenever finding items changes, so books indexed before are read again */
export const INDEX_VERSION = 3

/** True when a book never finished indexing or was indexed by an older item finder. */
export function needsReindex(book: BookRecord): boolean {
  return !book?.indexed || (book.indexVersion ?? 1) < INDEX_VERSION
}

type Report = (phase: ImportProgress['phase'], done: number, total: number) => void

function reporter(onProgress?: (p: ImportProgress) => void): Report {
  return (phase, done, total) => { try { onProgress?.({ phase, done, total }) } catch { /* ui errors never stop an import */ } }
}

async function readPdf(file: File): Promise<Uint8Array> {
  if (!file || !(file.size > 0)) throw new Error('This file is empty.')
  if (file.size > MAX_BOOK_BYTES) throw new Error('Choose a PDF smaller than 400 MB.')
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) }
  catch { throw new Error('This file could not be read. Try choosing it again.') }
  if (!hasPdfHeader(bytes)) throw new Error('This file is not a PDF.')
  return bytes
}

/** The metadata title when it looks like a real title, else the file name. */
export function bookTitle(metaTitle: unknown, fileName: string): string {
  const fromName = fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Untitled book'
  if (typeof metaTitle !== 'string') return fromName
  const title = metaTitle.replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\s+/g, ' ').trim()
  if (title.length < 3 || title.length > 200 || /\.(pdf|docx?|pptx?|tex|indd|qxd)$/i.test(title) || !/[A-Za-z]{2}/.test(title)
    || /^(untitled|document|title|book|slide ?\d*|print|output|new document)$/i.test(title) || /^[\w-]{24,}$/.test(title)) return fromName
  return title.slice(0, 160)
}

/** Quick facts for the import dialog without reading the pages. */
export async function inspectPdf(file: File): Promise<{ pageCount: number; title: string; size: number }> {
  const doc = await openPdf(await readPdf(file))
  try {
    const meta = await doc.getMetadata().catch(() => null) as { info?: { Title?: unknown } } | null
    return { pageCount: doc.numPages, title: bookTitle(meta?.info?.Title, file.name), size: file.size }
  } finally { await closePdf(doc) }
}

// lets the page paint between batches; scheduler.yield and message ports are not throttled in background tabs
function yieldNow(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  if (typeof MessageChannel !== 'undefined') {
    return new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); resolve() }; channel.port2.postMessage(0) })
  }
  return new Promise(resolve => setTimeout(resolve, 0))
}

type OutlineNode = { title?: unknown; dest?: unknown; items?: OutlineNode[] }

async function flatOutline(doc: PDFDocumentProxy): Promise<BookRecord['outline']> {
  const out: BookRecord['outline'] = []
  let outline: OutlineNode[] | null = null
  try { outline = await doc.getOutline() as OutlineNode[] | null } catch { return out }
  const visit = async (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      if (out.length >= 600 || depth > 6) return
      const title = typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
      let pageIndex = -1
      try {
        const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest
        const ref = Array.isArray(dest) ? dest[0] : null
        if (typeof ref === 'number') pageIndex = ref
        else if (ref && typeof ref === 'object') pageIndex = await doc.getPageIndex(ref as { num: number; gen: number })
      } catch { /* unresolved destinations are skipped */ }
      if (title && Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < doc.numPages) out.push({ title, pageIndex, depth })
      if (Array.isArray(node.items) && node.items.length) await visit(node.items, depth + 1)
    }
  }
  await visit(outline ?? [], 0)
  return out
}

type Read = { pages: PageRecord[]; anchors: Anchor[]; labels: (string | null)[]; outline: BookRecord['outline']; textPages: number }

/** Text of every page, printed page labels, the items a teacher can ask for and the outline. */
async function readBook(id: string, doc: PDFDocumentProxy, report: Report): Promise<Read> {
  const count = doc.numPages
  const pages: PageRecord[] = []
  for (let start = 0; start < count; start += BATCH) {
    for (let index = start; index < Math.min(count, start + BATCH); index++) {
      let record: PageRecord = { bookId: id, index, label: null, width: 612, height: 792, text: '', lines: [] }
      try {
        const page = await doc.getPage(index + 1)
        try {
          const { width, height, lines } = await pageLines(page)
          record = { ...record, width, height, lines, text: lines.map(line => line.text).join('\n').slice(0, 8000) }
        } finally { page.cleanup() }
      } catch { /* a broken page stays empty and keeps its place */ }
      pages.push(record)
      if (index % 5 === 4 || index === count - 1) report('reading', index + 1, count)
    }
    await yieldNow()
  }

  report('indexing', 0, count)
  const pdfLabels = await doc.getPageLabels().catch(() => null)
  const labels = assignPrintedLabels(pages.map(page => ({
    index: page.index, edges: [...page.lines.slice(0, 2), ...page.lines.slice(Math.max(2, page.lines.length - 3))].map(line => line.text),
  })), pdfLabels)
  pages.forEach(page => { page.label = labels[page.index] ?? null })
  const sample = pages.length > 120 ? pages.filter((_, i) => i % Math.ceil(pages.length / 120) === 0) : pages
  const body = bodyFontSize(sample.flatMap(page => page.lines))
  let anchors = findItems(id, pages, body, false)
  // a worksheet packet numbers its problems with no "Exercises" heading: read it as one exercise set
  if (!anchors.some(anchor => anchor.kind === 'exercise' || anchor.kind === 'problem' || anchor.kind === 'example')) anchors = findItems(id, pages, body, true)
  const outline = await flatOutline(doc)
  await yieldNow()
  return { pages, anchors, labels: labels.slice(0, count), outline, textPages: pages.filter(page => page.text.replace(/\s/g, '').length >= 20).length }
}

function findItems(id: string, pages: PageRecord[], body: number, allExercises: boolean): Anchor[] {
  const anchors: Anchor[] = [], byId = new Map<string, Anchor>()
  let exerciseMode = allExercises, answers = 0, exerciseSize = 0, carry: OpenItem[] = []
  for (const page of pages) {
    const found = detectAnchors(id, { index: page.index, lines: page.lines, exerciseMode, answers, exerciseSize, carry, allExercises }, body)
    // items that ran off the page before learn where they go on
    for (const { id: anchorId, continues } of found.continued) { const anchor = byId.get(anchorId); if (anchor) anchor.continues = continues }
    for (const anchor of found.anchors) byId.set(anchor.id, anchor)
    anchors.push(...found.anchors)
    exerciseMode = found.exerciseMode; answers = found.answers; exerciseSize = found.exerciseSize; carry = found.open
  }
  return anchors
}

const REMOVED = 'This book was removed from the library.'

/** The last save of a read: a book removed while it was being read is cleaned up instead of coming back. */
async function finish(done: BookRecord): Promise<void> {
  if (await replaceBook(done)) return
  await removeBook(done.id).catch(() => undefined)
  throw new Error(REMOVED)
}

async function writeBook(read: Read, report: Report) {
  const count = read.pages.length
  for (let start = 0; start < count; start += BATCH) {
    await putPages(read.pages.slice(start, start + BATCH))
    report('saving', Math.min(count, start + BATCH), count)
  }
  for (let start = 0; start < read.anchors.length; start += 500) await putAnchors(read.anchors.slice(start, start + 500))
}

async function coverOf(id: string, doc: PDFDocumentProxy, fallback: string | null): Promise<string | null> {
  try {
    const page = await doc.getPage(1)
    let cover: string
    try { cover = await thumbFromPage(page, 240) } finally { page.cleanup() }
    await putThumb(`${id}:0:240`, cover).catch(() => undefined)
    return cover
  } catch { return fallback /* no cover outside the browser or for a broken first page */ }
}

/**
 * Saves a PDF to the library: the original bytes, then the text of every page, printed page labels
 * and the items a teacher can ask for. Importing the same file again just reopens it.
 */
export async function importBook(file: File, onProgress?: (p: ImportProgress) => void): Promise<BookRecord> {
  const report = reporter(onProgress)
  report('reading', 0, 0)
  const bytes = await readPdf(file)
  const id = await bookIdFor(bytes)
  const existing = await getBook(id)
  if (existing?.indexed) {
    // write once, so this only puts back a file that went missing
    await putBookBytes(id, bytes)
    if (needsReindex(existing)) await ensureIndexed(id, onProgress)
    return (await touchBook(id)) ?? existing
  }
  // a lookup that asks for this book while it is still being read waits for this import instead of reading it twice
  const running = updating.get(id)
  if (running) return running
  const task = readNewBook(id, bytes, file, existing, report)
  updating.set(id, task)
  try { return await task } finally { if (updating.get(id) === task) updating.delete(id) }
}

async function readNewBook(id: string, bytes: Uint8Array, file: File, existing: BookRecord | undefined | null, report: Report): Promise<BookRecord> {
  void requestPersistentStorage()
  await putBookBytes(id, bytes)
  let doc: PDFDocumentProxy
  try { doc = await openPdf(bytes) }
  catch (error) { if (!existing) await removeBook(id).catch(() => undefined); throw error }
  try {
    const count = doc.numPages
    if (count < 1) throw new Error('This PDF has no pages.')
    const meta = await doc.getMetadata().catch(() => null) as { info?: { Title?: unknown } } | null
    const now = Date.now()
    const book: BookRecord = {
      id, title: bookTitle(meta?.info?.Title, file.name), fileName: file.name.slice(0, 240), size: bytes.byteLength, pageCount: count,
      addedAt: existing?.addedAt ?? now, openedAt: now, labels: new Array(count).fill(null), outline: [], cover: existing?.cover ?? null,
      indexed: false, textPages: 0,
    }
    await saveBook(book)
    const read = await readBook(id, doc, report)
    await writeBook(read, report)
    const cover = await coverOf(id, doc, book.cover)
    const done: BookRecord = { ...book, labels: read.labels, outline: read.outline, cover, indexed: true, textPages: read.textPages, indexVersion: INDEX_VERSION }
    await putBookBytes(id, bytes)
    await finish(done)
    report('saving', count, count)
    return done
  } catch (error) {
    if (!existing) await removeBook(id).catch(() => undefined)
    if (error instanceof Error && /storage|library|PDF|pages|browser/i.test(error.message)) throw error
    throw new Error('This PDF could not be saved to the library.')
  } finally {
    await closePdf(doc)
  }
}

const updating = new Map<string, Promise<BookRecord>>()

/**
 * Reads a saved book again from its stored PDF when it never finished indexing or was indexed by an
 * older item finder. Keeps its id, title, file name and dates; pages and items are replaced.
 */
export function ensureIndexed(bookId: string, onProgress?: (p: ImportProgress) => void): Promise<BookRecord> {
  const running = updating.get(bookId)
  if (running) return running
  const task = reindex(bookId, reporter(onProgress)).finally(() => updating.delete(bookId))
  updating.set(bookId, task)
  return task
}

async function reindex(bookId: string, report: Report): Promise<BookRecord> {
  const book = await getBook(bookId)
  if (!book) throw new Error('This book is no longer in the library. Import it again.')
  if (!needsReindex(book)) return book
  report('reading', 0, book.pageCount || 0)
  const bytes = await getBookBytes(bookId)
  if (!bytes || !hasPdfHeader(bytes)) throw new Error('This book is no longer in the library. Import it again.')
  const doc = await openPdf(bytes)
  try {
    const count = doc.numPages
    if (count < 1) throw new Error('This PDF has no pages.')
    const read = await readBook(bookId, doc, report)
    const base: BookRecord = { ...book, size: bytes.byteLength, pageCount: count, labels: read.labels, outline: read.outline, textPages: read.textPages, indexed: false }
    // items the new finder no longer sees are dropped; the stored PDF is never touched, so closing the tab now loses nothing
    const fresh = new Set(read.anchors.map(anchor => anchor.id))
    await removeAnchors((await getAnchors(bookId)).filter(anchor => !fresh.has(anchor.id)).map(anchor => anchor.id))
    await writeBook(read, report)
    const cover = book.cover ?? await coverOf(bookId, doc, null)
    const done: BookRecord = { ...base, cover, indexed: true, indexVersion: INDEX_VERSION }
    await finish(done)
    report('saving', count, count)
    return done
  } catch (error) {
    if (error instanceof Error && /storage|library|PDF|pages|browser/i.test(error.message)) throw error
    throw new Error('This book could not be updated. Import it again.')
  } finally {
    await closePdf(doc)
  }
}
