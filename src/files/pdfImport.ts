import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { AssetRecordType, createShapeId, type Editor, type TLImageShape } from '../canvas/editor'
import type { AppSettings, Bounds } from '../../shared/board'
import { hasPdfHeader, openPdf } from '../library/pdfjs'
import { PAGE_BOUNDS } from './boardFiles'
import { pdfKey, putPdfSource } from './pdfSources'
import {
  ASSET_CHAR_LIMIT, PX_PER_PT, RASTER_BUDGET,
  assetChars, boardImportLimit, joinTextItems, layoutPdfPages, worksheetPages, type PdfPageInfo,
} from './pdfPages'

export { boardImportLimit } from './pdfPages'

export type PdfImportOptions = {
  mode: AppSettings['mode']
  onProgress?: (page: number, pages: number) => void
  /** Move the camera to the first page afterwards (default true). */
  zoom?: boolean
}
export type PdfImportResult = {
  ids: string[]; pages: number; first: Bounds; layout: Bounds[]; doc: string; at: number;
  /** Content key of the original PDF. `keptSource` says whether its bytes are stored on this device. */
  source: string | null
  switchToInfinite: boolean; keptSource: boolean; hasText: boolean
}
type RenderedPage = { src: string; mimeType: string; w: number; h: number; width: number; height: number; text: string }

const STEPS = [[1, 0.9], [0.75, 0.84], [0.5, 0.78], [0.35, 0.72]] as const

/**
 * Rasterize one page for the board. Text pages stay sharp as PNG; photos and dense slides
 * use JPEG. A small share of storage (a long deck) starts from a smaller render right away,
 * so each page is drawn once or twice, not four times.
 */
async function rasterPage(page: PDFPageProxy, budget: number): Promise<{ src: string; mimeType: string; w: number; h: number }> {
  const natural = page.getViewport({ scale: 1 })
  const base = Math.min(2 * PX_PER_PT, 2400 / Math.max(natural.width, natural.height, 1))
  const start = budget >= 900_000 ? 0 : budget >= 300_000 ? 1 : budget >= 150_000 ? 2 : 3
  for (const [factor, quality] of STEPS.slice(start)) {
    const viewport = page.getViewport({ scale: base * factor })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    try {
      // the print intent renders without requestAnimationFrame, so imports keep going in background tabs
      try { await page.render({ canvas, viewport, background: '#ffffff', intent: 'print' }).promise }
      catch { throw new Error(`Page ${page.pageNumber} of this PDF could not be drawn.`) }
      for (const [type, q] of [['image/png', undefined], ['image/jpeg', quality]] as const) {
        const src = canvas.toDataURL(type, q)
        if (src.startsWith(`data:${type};base64,`) && src.length <= budget) return { src, mimeType: type, w: canvas.width, h: canvas.height }
      }
    } finally {
      // iPad Safari keeps canvas memory until the backing store is released
      canvas.width = 0; canvas.height = 0
    }
  }
  throw new Error('A page of this PDF is too detailed to store in this notebook. Save it to the library instead.')
}

async function readPage(pdf: PDFDocumentProxy, number: number, budget: number): Promise<RenderedPage> {
  let page: PDFPageProxy
  try { page = await pdf.getPage(number) }
  catch { throw new Error(`Page ${number} of this PDF could not be read.`) }
  try {
    const natural = page.getViewport({ scale: 1 })
    const image = await rasterPage(page, budget)
    let text = ''
    try { text = joinTextItems((await page.getTextContent()).items) } catch { /* pages without a text layer */ }
    return { ...image, width: natural.width, height: natural.height, text }
  } finally { page.cleanup() }
}

/** Best effort: keep the original on this device, but never let storage stall the import. */
async function keepSource(bytes: Uint8Array): Promise<{ source: string | null; stored: boolean }> {
  const source = await pdfKey(bytes).catch(() => null)
  if (!source) return { source: null, stored: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const stored = await Promise.race([
    putPdfSource(bytes).then(() => true, () => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 8000) }),
  ]).finally(() => clearTimeout(timer))
  return { source, stored }
}

/**
 * Import every page as a locked background image, stacked like a document. The page text
 * goes into the shape metadata so the assistant can read the worksheet. Long books belong
 * in the library instead (see boardImportLimit).
 */
export async function importPdfFile(editor: Editor, file: File, options: PdfImportOptions): Promise<PdfImportResult> {
  const tooBig = boardImportLimit(0, file.size)
  if (tooBig) throw new Error(tooBig)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!hasPdfHeader(bytes)) throw new Error('This file is not a PDF. Choose a .pdf file, or an image.')
  const pdf = await openPdf(bytes)
  try {
    const count = pdf.numPages
    if (count < 1) throw new Error('This PDF has no pages.')
    const tooLong = boardImportLimit(count, file.size)
    if (tooLong) throw new Error(tooLong)

    const room = Math.min(RASTER_BUDGET, ASSET_CHAR_LIMIT - assetChars(editor) - 500_000)
    const perPage = Math.min(2_400_000, Math.floor(room / count))
    if (perPage < 60_000) throw new Error('This notebook is too full for this PDF. Create a new notebook and import it there.')

    // a failed store (private browsing, full disk) still imports
    const { source, stored } = await keepSource(bytes)
    // the same file gives the same page image ids, so importing it again reuses the images
    const imageId = (page: number) => source ? `asset:pdf-${source.slice(7, 31)}-p${page}` : AssetRecordType.createId()
    const name = file.name.replace(/\.pdf$/i, '').trim().slice(0, 120) || 'Worksheet'
    const doc = crypto.randomUUID(), at = Date.now()
    const rendered: RenderedPage[] = []
    for (let number = 1; number <= count; number++) {
      options.onProgress?.(number, count)
      rendered.push(await readPage(pdf, number, perPage))
    }

    const existing = editor.getCurrentPageShapes()
    const fitA4 = options.mode === 'page' && count === 1 && !worksheetPages(editor).length
    const others = existing.map(shape => editor.getShapePageBounds(shape))
      .filter(box => !!box && [box.x, box.y, box.w, box.h].every(Number.isFinite))
      .map(box => ({ x: box!.x, y: box!.y, w: box!.w, h: box!.h }))
    const layout = layoutPdfPages(rendered, fitA4 ? [] : others, fitA4 ? PAGE_BOUNDS : undefined)
    const ids = rendered.map(() => createShapeId())

    editor.markHistoryStoppingPoint('Import PDF')
    editor.run(() => {
      // in A4 mode a one page PDF becomes the page background, like an image background
      if (fitA4) editor.deleteShapes(existing.filter(shape => shape.meta.marginaliaBackground === true).map(shape => shape.id))
      rendered.forEach((page, index) => {
        const assetId = imageId(index + 1), bounds = layout[index]
        const info: PdfPageInfo = { doc, name, page: index + 1, pages: count, at, source, width: page.width, height: page.height, text: page.text }
        if (!editor.getAsset(assetId)) editor.createAssets([{
          id: assetId, typeName: 'asset', type: 'image', meta: {},
          props: { name: `${name} page ${index + 1}`, src: page.src, w: page.w, h: page.h, mimeType: page.mimeType, isAnimated: false },
        }])
        editor.createShape<TLImageShape>({
          id: ids[index], type: 'image', x: bounds.x, y: bounds.y, isLocked: true,
          props: { assetId, w: bounds.w, h: bounds.h, altText: `${name}, page ${index + 1} of ${count}` },
          meta: { marginaliaBackground: true, pdf: info },
        })
      })
      editor.sendToBack(ids).selectNone()
    }, { ignoreShapeLock: true })
    if (options.zoom !== false) {
      // fit the first page's width so its opening lines are readable right away
      const screen = editor.getViewportScreenBounds(), first = layout[0]
      editor.zoomToBounds({ ...first, h: Math.min(first.h, first.w * screen.h / screen.w) }, { inset: 24, animation: { duration: 250 } })
    }
    return {
      ids, pages: count, first: layout[0], layout, doc, at, source,
      switchToInfinite: options.mode === 'page' && !fitA4,
      keptSource: stored, hasText: rendered.some(page => page.text.length > 0),
    }
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}
