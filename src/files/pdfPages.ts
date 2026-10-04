import type { Bounds } from '../../shared/board'
import type { Editor, TLShape } from '../canvas/editor'

export { isPdfFile } from '../library/pdfjs'

/** Board units are CSS pixels at 96 dpi and PDF units are points at 72 dpi. */
export const PX_PER_PT = 96 / 72
export const PAGE_GAP = 48
export const MAX_PDF_PAGES = 120
export const MAX_PDF_BYTES = 40 * 1024 * 1024
/** Stay under the embedded asset limit that normalizeSnapshot enforces on every reload. */
export const ASSET_CHAR_LIMIT = 54_000_000
/** Page images for one import share this many data URL characters, so a 100 slide deck stays light. */
export const RASTER_BUDGET = 20_000_000

/**
 * `source` is the content key (sha256) of the original PDF (see pdfSources.ts),
 * so boards that imported the same file share it. `width` and `height` are the page's
 * displayed size in points.
 */
export type PdfPageInfo = {
  doc: string; name: string; page: number; pages: number; at: number;
  source: string | null; width: number; height: number; text: string
}
export type WorksheetPage = { id: string; bounds: Bounds; info: PdfPageInfo }

/** Why a PDF cannot go on the board as pages, or null when it can. pageCount 0 means not known yet. */
export function boardImportLimit(pageCount: number, size: number): string | null {
  if (size > MAX_PDF_BYTES) {
    return `This PDF is ${Math.ceil(size / (1024 * 1024))} MB, too big for the board (up to 40 MB). Save it to the library instead.`
  }
  if (pageCount > MAX_PDF_PAGES) {
    return `This PDF has ${pageCount} pages, too many for the board (up to ${MAX_PDF_PAGES}). Save it to the library instead.`
  }
  return null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function pdfPageInfo(shape: TLShape | undefined): PdfPageInfo | null {
  const value = shape?.type === 'image' ? shape.meta.pdf : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const info = value as Record<string, unknown>
  if (typeof info.doc !== 'string' || !info.doc || !Number.isInteger(info.page) || !Number.isInteger(info.pages) ||
      (info.page as number) < 1 || (info.pages as number) < (info.page as number) || (info.pages as number) > MAX_PDF_PAGES) return null
  return {
    doc: info.doc, name: typeof info.name === 'string' ? info.name : 'Worksheet',
    page: info.page as number, pages: info.pages as number, at: typeof info.at === 'number' && Number.isFinite(info.at) ? info.at : 0,
    source: typeof info.source === 'string' ? info.source : null,
    width: positive(info.width) ? info.width : 0, height: positive(info.height) ? info.height : 0,
    text: typeof info.text === 'string' ? info.text : '',
  }
}

/** pdf.js text items in reading order, one line per EOL, with runs of spaces collapsed. */
export function joinTextItems(items: ReadonlyArray<unknown>, limit = 6000): string {
  let text = ''
  for (const item of items as Array<{ str?: unknown; hasEOL?: unknown } | null>) {
    if (typeof item?.str === 'string') text += item.str
    if (item?.hasEOL === true) text += '\n'
  }
  return text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, limit)
}

/**
 * Stack pages top to bottom. An empty board starts at the origin so A4 pages line up with
 * the A4 frame; otherwise the stack goes to the right of everything already on the board.
 * `fit` scales a single page into a fixed frame instead (A4 page mode).
 */
export function layoutPdfPages(sizes: Array<{ width: number; height: number }>, existing: Bounds[], fit?: Bounds): Bounds[] {
  if (fit && sizes.length === 1) {
    const w = sizes[0].width * PX_PER_PT, h = sizes[0].height * PX_PER_PT
    const scale = Math.min(fit.w / w, fit.h / h)
    return [{ x: fit.x + (fit.w - w * scale) / 2, y: fit.y, w: w * scale, h: h * scale }]
  }
  const column = Math.max(...sizes.map(size => size.width * PX_PER_PT))
  let x = 0, y = 0
  if (existing.length) {
    x = -Infinity; y = Infinity
    for (const box of existing) { x = Math.max(x, box.x + box.w); y = Math.min(y, box.y) }
    x += 160
  }
  return sizes.map(size => {
    const w = size.width * PX_PER_PT, h = size.height * PX_PER_PT
    const bounds = { x: x + (column - w) / 2, y, w, h }
    y += h + PAGE_GAP
    return bounds
  })
}

export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Imported worksheet pages in document order: by import, then by page number. */
export function worksheetPages(editor: Editor): WorksheetPage[] {
  const pages: WorksheetPage[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    const info = pdfPageInfo(shape), box = info && editor.getShapePageBounds(shape)
    if (info && box) pages.push({ id: shape.id, bounds: { x: box.x, y: box.y, w: box.w, h: box.h }, info })
  }
  return pages.sort((a, b) => a.info.at - b.info.at || a.info.doc.localeCompare(b.info.doc) || a.info.page - b.info.page)
}

/** Image characters the notebook holds; images no object shows are dropped with the next image, so they do not count. */
export function assetChars(editor: Editor): number {
  const records = editor.store.allRecords(), used = new Set<unknown>()
  for (const record of records) if (record.typeName === 'shape') used.add((record as { props?: { assetId?: unknown } }).props?.assetId)
  let total = 0
  for (const record of records) {
    const src = record.typeName === 'asset' && used.has(record.id) ? (record as { props?: { src?: unknown } }).props?.src : undefined
    if (typeof src === 'string') total += src.length
  }
  return total
}
