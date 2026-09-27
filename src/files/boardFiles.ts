import {
  AssetRecordType, Box, createShapeId,
  type Editor, type TLEditorSnapshot, type TLImageShape, type TLShapeId,
} from '../canvas/editor'
import { normalizeSnapshot } from '../canvas/migration'
import { exportTimeout } from './exportTimeout'
import { loadOriginalNotebookSnapshot } from '../notebooks/canvasBackup'
import { PDFDocument } from 'pdf-lib'
import { DEFAULT_SETTINGS, type AppSettings, type Bounds } from '../../shared/board'

export const PAGE_BOUNDS: Bounds = { x: 0, y: 0, w: 794, h: 1123 }
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
// a notebook holds up to 56 million characters of images; the rest of the file is its objects as JSON
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024
const TOO_BIG_PROJECT = 'Choose a project smaller than 64 MB.'
const MAX_EXPORT_EDGE = 8192
const MAX_EXPORT_PIXELS = 24_000_000

/** Keep the renderer lazy so plain project validation never initializes browser UI code. */
export function installBoardImageExporter(editor: Editor): void {
  editor.setImageExporter(async (instance, ids, options) => {
    const { renderShapesToImage } = await exportTimeout(import('./imageExporter'), 'loading the image renderer')
    return renderShapesToImage(instance, ids, options)
  })
}

type ProjectFile = {
  format: 'marginalia'; version: 1; savedAt: string;
  settings: AppSettings; snapshot: TLEditorSnapshot;
}

function baseName(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || 'Magic Whiteboard'
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Safari may not start reading the URL until after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('This image could not be read.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('This image could not be decoded. Try a PNG or JPEG.'))
    image.src = src
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('The image could not be exported.')),
    'image/png',
  ))
}

/** Store image bytes in the document, so backgrounds survive reloads and project downloads. */
export async function importImageFile(
  editor: Editor,
  file: File,
  options: { asBackground: boolean; mode: AppSettings['mode']; focus?: Bounds | null },
): Promise<TLShapeId> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose an image smaller than 12 MB.')
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP, or GIF image. You can also paste a screenshot.')
  }
  let src = await readDataUrl(file)
  const image = await loadImage(src)
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
    throw new Error('Choose an image with fewer than 40 million pixels.')
  }
  // Keep imported homework legible without filling IndexedDB with huge camera photographs.
  const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(1, Math.round(image.naturalWidth * scale))
  const h = Math.max(1, Math.round(image.naturalHeight * scale))
  let mimeType = file.type
  if (scale < 1 || file.type === 'image/gif') {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image processing is unavailable in this browser.')
    context.drawImage(image, 0, 0, w, h)
    mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    src = canvas.toDataURL(mimeType, 0.92)
  }

  const viewport = editor.getViewportPageBounds()
  const target: Bounds = options.asBackground && options.mode === 'page'
    ? PAGE_BOUNDS
    : options.focus && options.focus.w > 40 && options.focus.h > 40
      ? options.focus
      : { x: viewport.center.x - 380, y: viewport.center.y - 280, w: 760, h: 560 }
  const fit = Math.min(target.w / w, target.h / h)
  const width = w * fit
  const height = h * fit
  const assetId = AssetRecordType.createId()
  const id = createShapeId()
  editor.markHistoryStoppingPoint(options.asBackground ? 'Set homework background' : 'Insert image')
  editor.run(() => {
    if (options.asBackground) {
      const oldBackgrounds = editor.getCurrentPageShapes().filter(shape => shape.meta.marginaliaBackground === true)
      editor.deleteShapes(oldBackgrounds.map(shape => shape.id))
    }
    editor.createAssets([{
      id: assetId, typeName: 'asset', type: 'image', meta: {},
      props: { name: file.name || 'Screenshot', src, w, h, mimeType, isAnimated: false },
    }])
    editor.createShape<TLImageShape>({
      id, type: 'image', x: target.x + (target.w - width) / 2, y: target.y + (target.h - height) / 2,
      isLocked: options.asBackground,
      props: { assetId, w: width, h: height, altText: file.name || 'Imported screenshot' },
      meta: { marginaliaBackground: options.asBackground },
    })
    if (options.asBackground) editor.sendToBack([id]).selectNone()
    else editor.select(id)
  }, { ignoreShapeLock: true })
  if (options.asBackground) editor.zoomToBounds(target, { inset: 80, animation: { duration: 250 } })
  return id
}

export function getExportBounds(editor: Editor, settings: AppSettings): Box {
  if (settings.mode === 'page') return new Box(PAGE_BOUNDS.x, PAGE_BOUNDS.y, PAGE_BOUNDS.w, PAGE_BOUNDS.h)
  const boxes = editor.getCurrentPageShapes().map(shape => editor.getShapePageBounds(shape)).filter((box): box is Box => !!box)
  if (!boxes.length) return new Box(0, 0, PAGE_BOUNDS.w, PAGE_BOUNDS.h)
  const x = Math.min(...boxes.map(box => box.x)) - 32
  const y = Math.min(...boxes.map(box => box.y)) - 32
  const right = Math.max(...boxes.map(box => box.maxX)) + 32
  const bottom = Math.max(...boxes.map(box => box.maxY)) + 32
  return new Box(x, y, Math.max(1, right - x), Math.max(1, bottom - y))
}

function drawPaper(context: CanvasRenderingContext2D, bounds: Bounds, settings: AppSettings) {
  context.fillStyle = settings.backgroundColor
  context.fillRect(0, 0, bounds.w, bounds.h)
  if (settings.paper === 'plain') return
  const step = settings.paper === 'ruled' ? 32 : 24
  // At overview scale these marks collapse into noise; bound the work for huge canvases.
  if (bounds.w * bounds.h / (step * step) > 200_000) return
  const startX = ((-bounds.x % step) + step) % step
  const startY = ((-bounds.y % step) + step) % step
  context.strokeStyle = settings.paper === 'ruled' ? '#b8c3cc80' : '#c6c4bd80'
  context.fillStyle = '#b2b0a780'
  context.lineWidth = 0.6
  if (settings.paper === 'dots') {
    for (let x = startX; x < bounds.w; x += step) {
      for (let y = startY; y < bounds.h; y += step) {
        context.beginPath()
        context.arc(x, y, 0.75, 0, Math.PI * 2)
        context.fill()
      }
    }
    return
  }
  context.beginPath()
  for (let y = startY; y < bounds.h; y += step) {
    context.moveTo(0, y)
    context.lineTo(bounds.w, y)
  }
  if (settings.paper === 'grid') {
    for (let x = startX; x < bounds.w; x += step) {
      context.moveTo(x, 0)
      context.lineTo(x, bounds.h)
    }
  }
  context.stroke()
}

/** Current page objects whose bounds touch the region, locked pages included. */
export function regionShapeIds(editor: Editor, bounds: Bounds): TLShapeId[] {
  return editor.getCurrentPageShapes().filter(shape => {
    const box = editor.getShapePageBounds(shape)
    return !!box && box.maxX > bounds.x && box.maxY > bounds.y && box.x < bounds.x + bounds.w && box.y < bounds.y + bounds.h
  }).map(shape => shape.id)
}

/** The selected objects plus a margin, or null when nothing is selected. */
export function regionFromSelection(editor: Editor, padding = 24): Bounds | null {
  const boxes = editor.getSelectedShapes().map(shape => editor.getShapePageBounds(shape))
    .filter((box): box is Box => !!box && [box.x, box.y, box.w, box.h].every(Number.isFinite))
  if (!boxes.length) return null
  const all = Box.Common(boxes)
  return { x: all.x - padding, y: all.y - padding, w: all.w + padding * 2, h: all.h + padding * 2 }
}

/** One region of the board as a PNG: the paper, then the objects (by default everything that touches it). */
export async function renderRegionPng(editor: Editor, settings: AppSettings, bounds: Bounds, ids: TLShapeId[] = regionShapeIds(editor, bounds)): Promise<Blob> {
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) throw new Error('The export area is invalid.')
  // Export very large boards without exceeding iPad canvas memory limits.
  const pixelRatio = Math.min(2, MAX_EXPORT_EDGE / bounds.w, MAX_EXPORT_EDGE / bounds.h,
    Math.sqrt(MAX_EXPORT_PIXELS / (bounds.w * bounds.h)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bounds.w * pixelRatio))
  canvas.height = Math.max(1, Math.round(bounds.h * pixelRatio))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image export is unavailable in this browser.')
  context.scale(canvas.width / bounds.w, canvas.height / bounds.h)
  drawPaper(context, bounds, settings)
  if (ids.length) {
    const exported = await editor.toImage(ids, {
      format: 'png', bounds, padding: 0, background: false, pixelRatio, darkMode: false,
    })
    const url = URL.createObjectURL(exported.blob)
    try { context.drawImage(await loadImage(url), 0, 0, bounds.w, bounds.h) }
    finally { URL.revokeObjectURL(url) }
  }
  return canvasBlob(canvas)
}

/** Export every object, including locked homework images, with the board's paper treatment. */
export async function renderBoardPng(editor: Editor, settings: AppSettings): Promise<{ blob: Blob; bounds: Box }> {
  const bounds = getExportBounds(editor, settings)
  return { blob: await renderRegionPng(editor, settings, bounds, [...editor.getCurrentPageShapeIds()]), bounds }
}

/** Board pixels at 96 dpi become points at 72 dpi, kept under the PDF page size limit. */
export function pdfPageSize(bounds: Bounds): [number, number] {
  const maxPdfEdge = 14_400
  const pdfScale = Math.min(0.75, maxPdfEdge / bounds.w, maxPdfEdge / bounds.h)
  return [bounds.w * pdfScale, bounds.h * pdfScale]
}

async function pngPdf(blob: Blob, title: string, [width, height]: [number, number]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator('Magic Whiteboard')
  const image = await pdf.embedPng(await blob.arrayBuffer())
  const page = pdf.addPage([width, height])
  page.drawImage(image, { x: 0, y: 0, width, height })
  return pdf.save()
}

export async function exportBoard(editor: Editor, format: 'png' | 'pdf', settings: AppSettings): Promise<void> {
  const { blob, bounds } = await renderBoardPng(editor, settings)
  if (format === 'png') {
    downloadBlob(blob, `${baseName(settings.name)}.png`)
    return
  }
  // An infinite board uses a content-sized sheet; page mode is a true portrait A4 page.
  const bytes = await pngPdf(blob, settings.name, settings.mode === 'page' ? [595.28, 841.89] : pdfPageSize(bounds))
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${baseName(settings.name)}.pdf`)
}

/** One PDF page of exactly this area of the board, paper and locked pages included. */
export async function buildRegionPdf(editor: Editor, bounds: Bounds, settings: AppSettings): Promise<Uint8Array> {
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || Math.abs(bounds.x) > 1e7 || Math.abs(bounds.y) > 1e7) {
    throw new Error('The export area is invalid.')
  }
  if (bounds.w < 8 || bounds.h < 8) throw new Error('The area to export is too small.')
  const region = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
  const ids = regionShapeIds(editor, region)
  if (!ids.length) throw new Error('Nothing on the board is inside that area.')
  return pngPdf(await renderRegionPng(editor, settings, region, ids), settings.name, pdfPageSize(region))
}

export async function exportRegionPdf(editor: Editor, bounds: Bounds, settings: AppSettings, name?: string): Promise<void> {
  const bytes = await buildRegionPdf(editor, bounds, settings)
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${baseName(name ?? `${settings.name} area`)}.pdf`)
}

/** The downloadable notebook file (unused images left out), refused when Open notebook file could not read it back. */
export function projectFileBlob(editor: Editor, settings: AppSettings): Blob {
  const project: ProjectFile = {
    format: 'marginalia', version: 1, savedAt: new Date().toISOString(),
    settings: { ...settings, focusMode: settings.focusMode === 'literal' ? 'literal' : 'reference' },
    snapshot: editor.getSnapshot(),
  }
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' })
  if (blob.size > MAX_PROJECT_BYTES) throw new Error('This notebook is too large to save as one file. Remove some images or split it into two notebooks.')
  return blob
}

export function saveProject(editor: Editor, settings: AppSettings): void {
  downloadBlob(projectFileBlob(editor, settings), `${baseName(settings.name)}.marginalia.json`)
}

/** Download the untouched pre-migration checkpoint for inspection; never restore it automatically. */
export async function downloadOriginalNotebook(id: string, settings: AppSettings): Promise<void> {
  const snapshot = await loadOriginalNotebookSnapshot(id)
  if (!snapshot) throw new Error('No original pre-migration checkpoint was found for this notebook. Its current contents have not changed.')
  const project: ProjectFile = {
    format: 'marginalia', version: 1, savedAt: new Date().toISOString(), settings: { ...settings }, snapshot,
  }
  downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${baseName(settings.name)} - original checkpoint.marginalia.json`)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseProjectFile(text: string): ProjectFile {
  const project: unknown = JSON.parse(text)
  if (!object(project) || project.format !== 'marginalia' || project.version !== 1 || !object(project.snapshot)) {
    throw new Error('This is not a supported Magic Whiteboard project file.')
  }
  const snapshot = project.snapshot
  if (!object(snapshot.document) || !object(snapshot.document.store) || !object(snapshot.document.schema)) {
    throw new Error('The project is missing its board data.')
  }
  const records = Object.values(snapshot.document.store)
  if (records.length > 20_000) throw new Error('This project is too large to open in the prototype.')
  for (const record of records) {
    if (!object(record)) throw new Error('This project contains an invalid object.')
    if (record.typeName === 'shape') {
      if (['embed', 'bookmark', 'video'].includes(String(record.type))) {
        throw new Error('This project contains unsupported online content. Use embedded screenshot images.')
      }
      for (const coordinate of ['x', 'y', 'rotation']) {
        if (typeof record[coordinate] !== 'number' || !Number.isFinite(record[coordinate]) || Math.abs(record[coordinate] as number) > 10_000_000) {
          throw new Error('This project has an invalid object position.')
        }
      }
      if (object(record.props)) for (const dimension of ['w', 'h']) {
        const value = record.props[dimension]
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000)) {
          throw new Error('This project has an invalid object size.')
        }
      }
    }
    // Exported projects carry local raster bytes; opening a project never fetches external assets.
    if (record.typeName === 'asset') {
      if (record.type !== 'image' || !object(record.props) || typeof record.props.src !== 'string' ||
          !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(record.props.src)) {
        throw new Error('This project contains an unsupported external asset. Use embedded screenshot images.')
      }
    }
  }
  const input = object(project.settings) ? project.settings : {}
  const settings: AppSettings = {
    name: typeof input.name === 'string' ? input.name.slice(0, 120) : DEFAULT_SETTINGS.name,
    mode: input.mode === 'page' ? 'page' : 'infinite',
    focusMode: input.focusMode === 'literal' ? 'literal' : 'reference',
    paper: ['dots', 'grid', 'plain', 'ruled'].includes(String(input.paper)) ? input.paper as AppSettings['paper'] : 'dots',
    backgroundColor: typeof input.backgroundColor === 'string' && /^#[\da-f]{6}$/i.test(input.backgroundColor)
      ? input.backgroundColor : DEFAULT_SETTINGS.backgroundColor,
  }
  return { format: 'marginalia', version: 1, savedAt: String(project.savedAt || ''), settings, snapshot: normalizeSnapshot(snapshot) }
}

/** Validate the complete data file before replacing the user's current board. */
export async function loadProject(editor: Editor, file: File): Promise<AppSettings> {
  if (file.size > MAX_PROJECT_BYTES) throw new Error(TOO_BIG_PROJECT)
  const project = parseProjectFile(await file.text())
  const previous = editor.getSnapshot()
  try { editor.loadSnapshot(project.snapshot) }
  catch {
    editor.loadSnapshot(previous)
    throw new Error('The project could not be opened. Your previous board has been restored.')
  }
  return project.settings
}
