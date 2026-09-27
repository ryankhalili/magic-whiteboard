import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextLine } from './types'

type PdfJs = typeof import('pdfjs-dist')

let loading: Promise<PdfJs> | null = null
let loader = (): Promise<PdfJs> => Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  .then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib })
let documentOptions: Record<string, unknown> = {
  enableXfa: false, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/',
}

/** pdf.js is large, so it only loads the first time a PDF is opened. */
export function loadPdfJs(): Promise<PdfJs> {
  loading ??= loader().catch(error => { loading = null; throw error })
  return loading
}

/** node tests swap in the legacy build of pdf.js and local asset paths. */
export function setPdfJsLoader(load: () => Promise<unknown>, options: Record<string, unknown> = {}) {
  loader = load as () => Promise<PdfJs>
  loading = null
  documentOptions = { enableXfa: false, ...options }
}

export function hasPdfHeader(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')
}

export function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await loadPdfJs()
  // pdf.js takes ownership of the array it is given, so it gets a copy.
  const task = lib.getDocument({ ...documentOptions, data: bytes.slice() })
  try { return await task.promise }
  catch (error) {
    await task.destroy().catch(() => undefined)
    if ((lib.PasswordException && error instanceof lib.PasswordException) || (error as { name?: unknown } | null)?.name === 'PasswordException') {
      throw new Error('This PDF is password protected. Save an unlocked copy and import that.')
    }
    throw new Error('This PDF could not be opened.')
  }
}

/** Frees the document and its worker. */
export function closePdf(doc: PDFDocumentProxy): Promise<void> {
  return doc.loadingTask.destroy().catch(() => undefined)
}

type Fragment = { text: string; x0: number; x1: number; y: number; size: number; space: boolean }
type Run = { parts: Fragment[]; y: number; size: number; x0: number; x1: number }

function addPart(run: Run, part: Fragment) {
  run.parts.push(part)
  run.x0 = Math.min(run.x0, part.x0); run.x1 = Math.max(run.x1, part.x1)
  if (part.size > run.size) { run.size = part.size; run.y = part.y }
}

/**
 * Visual lines from pdf.js text items. toView maps PDF user space to the page as displayed (top left origin).
 * Items are read in content order so side by side columns stay apart, then pieces of one line drawn out of order are joined.
 */
export function textLinesFrom(items: ReadonlyArray<unknown>, toView: (x: number, y: number) => number[], width: number, height: number): TextLine[] {
  if (!(width > 0) || !(height > 0)) return []
  const runs: Run[] = []
  let current: Run | null = null, space = false
  const finish = () => { if (current) runs.push(current); current = null; space = false }
  for (const raw of items as Array<{ str?: unknown; transform?: unknown; width?: unknown; hasEOL?: unknown } | null>) {
    if (typeof raw?.str !== 'string' || !Array.isArray(raw.transform)) { if (raw?.hasEOL === true) finish(); continue }
    if (!raw.str.trim()) { if (current) space = true; if (raw.hasEOL === true) finish(); continue }
    const [a, b, c, d, e, f] = (raw.transform as unknown[]).map(Number)
    if (![a, b, c, d, e, f].every(Number.isFinite)) continue
    const scale = Math.hypot(a, b) || 1
    const advance = typeof raw.width === 'number' && Number.isFinite(raw.width) ? Math.max(0, raw.width) : 0
    const [sx, sy] = toView(e, f), [ex, ey] = toView(e + advance * a / scale, f + advance * b / scale)
    const [ux, uy] = toView(e + c, f + d)
    if (![sx, sy, ex, ey, ux, uy].every(Number.isFinite)) continue
    const part: Fragment = { text: raw.str, x0: Math.min(sx, ex), x1: Math.max(sx, ex), y: (sy + ey) / 2, size: Math.max(Math.hypot(ux - sx, uy - sy), 1), space: false }
    if (current) {
      const em = Math.max(current.size, part.size)
      // superscripts sit a little off the baseline; a jump back or a wide gap starts another line or column
      if (Math.abs(part.y - current.y) > Math.max(1.5, 0.45 * em) || part.x0 < current.x1 - em || part.x0 - current.x1 > 3 * em) finish()
    }
    part.space = space; space = false
    if (current) addPart(current, part)
    else current = { parts: [part], y: part.y, size: part.size, x0: part.x0, x1: part.x1 }
    if (raw.hasEOL === true) finish()
  }
  finish()

  runs.sort((p, q) => p.y - q.y || p.x0 - q.x0)
  const merged: Run[] = []
  for (const run of runs) {
    const em = run.size
    const host = merged.find(other => Math.abs(other.y - run.y) <= 0.3 * Math.max(em, other.size)
      && run.x0 - other.x1 >= -0.5 * em && run.x0 - other.x1 <= 1 * Math.max(em, other.size))
    if (host) { run.parts[0].space ||= run.x0 - host.x1 > 0.15 * em; for (const part of run.parts) addPart(host, part) }
    else merged.push({ ...run, parts: [...run.parts] })
  }

  const lines: TextLine[] = []
  for (const run of merged) {
    let text = '', end = -Infinity, chars = 0, weighted = 0, top = Infinity, bottom = -Infinity
    for (const part of run.parts) {
      if (text && (part.space || part.x0 - end > 0.15 * part.size) && !/\s$/.test(text) && !/^\s/.test(part.text)) text += ' '
      text += part.text
      end = Math.max(end, part.x1)
      const n = part.text.trim().length
      chars += n; weighted += n * part.size
      top = Math.min(top, part.y - part.size * 0.85); bottom = Math.max(bottom, part.y + part.size * 0.25)
    }
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) continue
    const size = chars ? weighted / chars : run.size
    lines.push({
      text: clean,
      box: { x: clamp01(run.x0 / width), y: clamp01(top / height), w: clamp01((run.x1 - run.x0) / width), h: clamp01((bottom - top) / height) },
      size: size / height,
    })
  }
  return lines.sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x)
}

function clamp01(value: number) { return Math.min(1, Math.max(0, value)) }

export async function pageLines(page: PDFPageProxy): Promise<{ width: number; height: number; lines: TextLine[] }> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const lines = textLinesFrom(content.items, (x, y) => viewport.convertToViewportPoint(x, y), viewport.width, viewport.height)
  return { width: viewport.width, height: viewport.height, lines }
}

type Entry = { doc: Promise<PDFDocumentProxy>; users: number; closed: boolean }
const open = new Map<string, Entry>()
const OPEN_LIMIT = 3

function release(entry: Entry) {
  if (entry.closed && entry.users === 0) entry.doc.then(closePdf).catch(() => undefined)
}

/** Runs use() with the book's open document, keeping the last 3 books open for quick rendering. */
export async function withBookPdf<T>(bookId: string, bytes: () => Promise<Uint8Array | null>, use: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  let entry = open.get(bookId)
  if (entry) { open.delete(bookId); open.set(bookId, entry) }
  else {
    const doc = bytes().then(data => {
      if (!data) throw new Error('This book is no longer in the library. Import it again.')
      return openPdf(data)
    })
    entry = { doc, users: 0, closed: false }
    open.set(bookId, entry)
    const created = entry
    doc.catch(() => { if (open.get(bookId) === created) open.delete(bookId) })
    while (open.size > OPEN_LIMIT) {
      const [oldest, old] = open.entries().next().value as [string, Entry]
      open.delete(oldest); old.closed = true; release(old)
    }
  }
  entry.users++
  try { return await use(await entry.doc) }
  finally { entry.users--; release(entry) }
}

export function closeBookPdf(bookId: string) {
  const entry = open.get(bookId)
  if (!entry) return
  open.delete(bookId); entry.closed = true; release(entry)
}
