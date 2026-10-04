import { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib'
import { Editor, type TLImageShape } from '../canvas/editor'
import { Matrix2d } from '../canvas/geometry'
import { imageCrop } from '../canvas/imageCrop'
import { downloadBlob } from './boardFiles'
import { overlaps, PX_PER_PT, worksheetPages, type WorksheetPage } from './pdfPages'
import { getPdfSource } from './pdfSources'
import type { SceneExportOptions } from './imageExporter'

export type WorksheetExportOptions = {
  /** Omit to export all imported worksheets, in import order. */
  docId?: string
  title?: string
  onProgress?: (done: number, total: number) => void
}
export type WorksheetExportResult = { bytes: Uint8Array; pages: number; rasterizedPages: number }

/** Undo the page's canvas rotation/size/crop before compositing work over the original. */
export function worksheetOverlayOptions(editor: Editor, worksheet: WorksheetPage): SceneExportOptions {
  const shape = editor.getShape<TLImageShape>(worksheet.id)
  if (!shape || shape.type !== 'image') throw new Error('A worksheet page is no longer on the board.')
  const crop = imageCrop(shape.props) ?? { x: 0, y: 0, w: 1, h: 1 }
  const width = worksheet.info.width > 0 ? worksheet.info.width * PX_PER_PT : shape.props.w / crop.w
  const height = worksheet.info.height > 0 ? worksheet.info.height * PX_PER_PT : shape.props.h / crop.h
  const scale = Array.isArray(shape.props.excalidrawScale) ? shape.props.excalidrawScale : [1, 1]
  const sx = crop.w * width / shape.props.w, sy = crop.h * height / shape.props.h
  const sceneTransform = new Matrix2d(
    scale[0] < 0 ? -sx : sx, 0, 0, scale[1] < 0 ? -sy : sy,
    (crop.x + (scale[0] < 0 ? crop.w : 0)) * width,
    (crop.y + (scale[1] < 0 ? crop.h : 0)) * height,
  ).multiply(editor.getShapePageTransform(shape).clone().invert())
  return {
    bounds: { x: 0, y: 0, w: width, h: height }, padding: 0, pixelRatio: 2, background: false,
    sceneTransform, clip: { x: crop.x * width, y: crop.y * height, w: crop.w * width, h: crop.h * height },
  }
}

/** Only visible work touching this page; other worksheets and group containers are never overlays. */
export function worksheetAnnotationIds(editor: Editor, worksheet: WorksheetPage): string[] {
  const pageIds = new Set(worksheetPages(editor).map(page => page.id))
  return editor.getCurrentPageShapesSorted().filter(shape => {
    if (pageIds.has(shape.id) || shape.type === 'group') return false
    const bounds = editor.getShapePageBounds(shape)
    return bounds && overlaps(bounds, worksheet.bounds)
  }).map(shape => shape.id)
}

/** Map a displayed page (origin bottom-left) back into the source CropBox and /Rotate. */
export function displayedPageTransform(page: PDFPage): { matrix: [number, number, number, number, number, number]; width: number; height: number } {
  const { x, y, width, height } = page.getCropBox()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  if (rotation === 90) return { matrix: [0, 1, -1, 0, x + width, y], width: height, height: width }
  if (rotation === 180) return { matrix: [-1, 0, 0, -1, x + width, y + height], width, height }
  if (rotation === 270) return { matrix: [0, -1, 1, 0, x, y + height], width: height, height: width }
  if (rotation !== 0) throw new Error('This PDF uses an unsupported page rotation.')
  return { matrix: [1, 0, 0, 1, x, y], width, height }
}

async function addWork(editor: Editor, worksheet: WorksheetPage, pdf: PDFDocument, page: PDFPage) {
  const ids = worksheetAnnotationIds(editor, worksheet)
  if (!ids.length) return
  const { renderShapesToImage } = await import('./imageExporter')
  const { blob } = await renderShapesToImage(editor, ids, worksheetOverlayOptions(editor, worksheet))
  const image = await pdf.embedPng(await blob.arrayBuffer())
  const { matrix, width, height } = displayedPageTransform(page)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix))
  page.drawImage(image, { x: 0, y: 0, width, height })
  page.pushOperators(popGraphicsState())
}

/** Legacy/portable boards without an original still export one correctly sized page per raster. */
async function addRasterPage(editor: Editor, worksheet: WorksheetPage, pdf: PDFDocument) {
  const shape = editor.getShape<TLImageShape>(worksheet.id)!
  const asset = editor.getAsset(shape.props.assetId)
  if (!asset) throw new Error('A worksheet image is missing. Restore a notebook backup before exporting.')
  const options = worksheetOverlayOptions(editor, worksheet), bounds = options.bounds!
  const page = pdf.addPage([worksheet.info.width || bounds.w / PX_PER_PT, worksheet.info.height || bounds.h / PX_PER_PT])
  const image = /^data:image\/jpeg;/i.test(asset.props.src) ? await pdf.embedJpg(asset.props.src) : await pdf.embedPng(asset.props.src)
  page.drawImage(image, { x: 0, y: 0, ...page.getSize() })
  await addWork(editor, worksheet, pdf, page)
}

/**
 * Preserve page count, ordering, boxes, rotation and original vector/text content when available.
 * Annotation layers alone are rasterized, in page coordinates, so side scratchwork cannot leak in.
 */
export async function buildWorksheetPdf(editor: Editor, options: WorksheetExportOptions = {}): Promise<WorksheetExportResult> {
  editor.completeInteraction()
  // Export a stable checkpoint while the live board remains editable.
  const frozen = new Editor().loadSnapshot(editor.getSnapshot())
  try {
    const pages = worksheetPages(frozen).filter(page => !options.docId || page.info.doc === options.docId)
    if (!pages.length) throw new Error('Import a homework PDF onto the board first.')
    const groups = new Map<string, WorksheetPage[]>()
    for (const page of pages) {
      const group = groups.get(page.info.doc) ?? []
      if (group.some(other => other.info.page === page.info.page)) throw new Error('This worksheet has duplicate page numbers. Export a single intact copy.')
      group.push(page); groups.set(page.info.doc, group)
    }
    let output = await PDFDocument.create(), rasterizedPages = 0, done = 0
    const total = [...groups.values()].reduce((count, group) => count + group[0].info.pages, 0)
    for (const group of groups.values()) {
      const info = group[0].info
      if (group.some(page => page.info.source !== info.source || page.info.pages !== info.pages)) throw new Error('This worksheet has inconsistent page metadata. Reimport the original PDF.')
      const bytes = info.source ? await getPdfSource(info.source).catch(() => null) : null
      if (bytes) {
        const original = await PDFDocument.load(bytes)
        if (original.getPageCount() !== info.pages) throw new Error('The original PDF no longer matches these worksheet pages. Reimport it before exporting.')
        // Loading the entire document preserves interactive fields and document-level resources.
        if (groups.size === 1) output = original
        else if (original.getForm().getFields().length) throw new Error('Export worksheets with fillable forms separately to keep their fields editable.')
        const copied = groups.size === 1 ? original.getPages() : await output.copyPages(original, original.getPageIndices())
        for (let index = 0; index < copied.length; index++) {
          const page = groups.size === 1 ? copied[index] : output.addPage(copied[index])
          const worksheet = group.find(item => item.info.page === index + 1)
          if (worksheet) await addWork(frozen, worksheet, output, page)
          options.onProgress?.(++done, total)
        }
      } else {
        if (group.length !== info.pages) throw new Error('Some original worksheet pages are missing. Reimport the PDF to export its complete page sequence.')
        for (const worksheet of group) {
          await addRasterPage(frozen, worksheet, output)
          rasterizedPages++; options.onProgress?.(++done, total)
        }
      }
    }
    if (options.title) output.setTitle(options.title)
    output.setCreator('MagiBoard')
    return { bytes: await output.save(), pages: output.getPageCount(), rasterizedPages }
  } finally { frozen.dispose() }
}

export async function exportWorksheetPdf(editor: Editor, options: WorksheetExportOptions = {}): Promise<WorksheetExportResult> {
  const result = await buildWorksheetPdf(editor, options)
  const name = (options.title || 'Homework').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100)
  downloadBlob(new Blob([new Uint8Array(result.bytes)], { type: 'application/pdf' }), `${name}.pdf`)
  return result
}
