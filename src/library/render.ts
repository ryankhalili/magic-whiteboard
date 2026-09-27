import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { withBookPdf } from './pdfjs'
import { getBookBytes, getThumb, putThumb } from './store'
import type { PageBox, RenderedImage } from './types'

type Canvas = HTMLCanvasElement

function makeCanvas(width: number, height: number): Canvas {
  if (typeof document === 'undefined') throw new Error('Pages can only be drawn in the browser.')
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height))
  return canvas
}

// iPad Safari keeps canvas memory until the backing store is released
function release(canvas: Canvas) { canvas.width = 0; canvas.height = 0 }

// a few renders at a time keeps memory flat when many thumbnails scroll into view
let running = 0
const waiting: Array<() => void> = []
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try { return await work() }
  finally { running--; waiting.shift()?.() }
}

function checkIndex(doc: PDFDocumentProxy, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) throw new Error('That page is not in this book.')
}

async function withPage<T>(bookId: string, index: number, use: (page: PDFPageProxy) => Promise<T>): Promise<T> {
  return limited(() => withBookPdf(bookId, () => getBookBytes(bookId), async doc => {
    checkIndex(doc, index)
    const page = await doc.getPage(index + 1)
    try { return await use(page) }
    finally { page.cleanup() }
  }))
}

// the print intent renders without requestAnimationFrame, so it also finishes in a background tab
async function draw(page: PDFPageProxy, scale: number, box?: PageBox): Promise<Canvas> {
  const viewport = page.getViewport({ scale })
  const crop = box ?? { x: 0, y: 0, w: 1, h: 1 }
  const canvas = makeCanvas(crop.w * viewport.width, crop.h * viewport.height)
  try {
    await page.render({
      canvas, viewport, background: '#ffffff', intent: 'print',
      ...(box ? { transform: [1, 0, 0, 1, -crop.x * viewport.width, -crop.y * viewport.height] } : {}),
    }).promise
    return canvas
  } catch (error) {
    release(canvas)
    throw error
  }
}

function encode(canvas: Canvas, mimeType: RenderedImage['mimeType'], quality?: number): RenderedImage {
  const src = canvas.toDataURL(mimeType, quality)
  if (!src.startsWith(`data:${mimeType};base64,`)) throw new Error('This device could not draw the page. Try a smaller crop.')
  return { src, w: canvas.width, h: canvas.height, mimeType }
}

/** A whole page as a JPEG, the longest edge maxEdge pixels (default 1800). */
export async function renderPage(bookId: string, index: number, opts: { maxEdge?: number } = {}): Promise<RenderedImage> {
  const maxEdge = Math.min(4096, Math.max(64, Math.round(opts.maxEdge ?? 1800)))
  return withPage(bookId, index, async page => {
    const natural = page.getViewport({ scale: 1 })
    const canvas = await draw(page, maxEdge / Math.max(natural.width, natural.height, 1))
    try { return encode(canvas, 'image/jpeg', 0.86) }
    finally { release(canvas) }
  })
}

/** Clamps a crop box to the page, at least 1 percent on each side. */
export function clampBox(box: PageBox): PageBox {
  const num = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const w = Math.min(1, Math.max(0.01, num(box?.w, 1))), h = Math.min(1, Math.max(0.01, num(box?.h, 1)))
  const x = Math.min(1 - w, Math.max(0, num(box?.x, 0))), y = Math.min(1 - h, Math.max(0, num(box?.y, 0)))
  return { x, y, w, h }
}

/** Scale that makes the crop about targetWidth pixels wide, at most 4x and at most 16M pixels. */
export function cropScale(page: { width: number; height: number }, box: PageBox, targetWidth = 1400): number {
  const cropW = Math.max(1, box.w * page.width), cropH = Math.max(1, box.h * page.height)
  const scale = Math.min(4, Math.max(0.25, targetWidth / cropW))
  return Math.min(scale, Math.sqrt(16_000_000 / (cropW * cropH)))
}

/**
 * Where the ink ends: trailing blank rows, separator rules under the item and blank columns on the right
 * are dropped. data is RGBA; returns the kept width and height and the top row to start from.
 */
export function inkBounds(data: Uint8ClampedArray, width: number, height: number, margin = 12): { top: number; w: number; h: number } {
  const inkRow = new Float64Array(height), ink = (i: number) => data[i + 3] > 16 && (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235)
  for (let y = 0; y < height; y++) {
    let count = 0
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) if (ink(i)) count++
    inkRow[y] = count / width
  }
  // a thin rule across the top edge belongs to the item above (a shaded box is thicker and stays)
  const thin = Math.max(4, height * 0.01)
  let top = 0
  const zone = Math.min(height, Math.max(3, Math.round(height * 0.06)))
  let first = 0
  while (first < zone && inkRow[first] < 0.6) first++
  if (first < zone) {
    let end = first
    while (end < height && inkRow[end] >= 0.6) end++
    if (end - first <= thin) top = end
  }
  let bottom = height - 1
  // ink cut by the bottom edge after a blank gap is the top of whatever comes next
  if (inkRow[bottom] > 0) {
    let band = bottom
    while (band > top && inkRow[band] > 0) band--
    let gap = band
    while (gap > top && inkRow[gap] === 0) gap--
    if (bottom - band <= height * 0.25 && band - gap >= 3 && gap > top) bottom = gap
  }
  const tail = Math.max(24, Math.round(height * 0.12))
  for (let pass = 0; pass < 3; pass++) {
    while (bottom > top && inkRow[bottom] === 0) bottom--
    // a thin line across the crop with space above it is a separator; anything under it (the next item's label) goes too
    let low = bottom
    while (low > top && bottom - low < tail && inkRow[low] < 0.6) low--
    if (inkRow[low] < 0.6) break
    let band = low
    while (band > top && inkRow[band] >= 0.6) band--
    if (low - band > thin) break
    let gap = band
    while (gap > top && inkRow[gap] === 0) gap--
    if (band - gap < 3 || gap <= top) break
    bottom = gap
  }
  let right = 0
  for (let y = top; y <= bottom; y++) {
    for (let x = width - 1, i = (y * width + x) * 4; x > right; x--, i -= 4) if (ink(i)) { right = x; break }
  }
  if (bottom <= top || right === 0) return { top: 0, w: width, h: height }
  return { top, w: Math.min(width, right + 1 + margin), h: Math.min(height - top, bottom - top + 1 + margin) }
}

/** A crisp PNG of part of a page. trim drops blank space and separator rules around an item. */
export async function renderCrop(bookId: string, index: number, box: PageBox, opts: { targetWidth?: number; trim?: boolean } = {}): Promise<RenderedImage> {
  const crop = clampBox(box)
  const target = Math.min(3000, Math.max(200, Math.round(opts.targetWidth ?? 1400)))
  return withPage(bookId, index, async page => {
    const natural = page.getViewport({ scale: 1 })
    const canvas = await draw(page, cropScale(natural, crop, target), crop)
    try {
      if (!opts.trim) return encode(canvas, 'image/png')
      const context = canvas.getContext('2d')
      if (!context) return encode(canvas, 'image/png')
      const kept = inkBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      if (kept.top === 0 && kept.w === canvas.width && kept.h === canvas.height) return encode(canvas, 'image/png')
      const out = makeCanvas(kept.w, kept.h)
      try {
        const target2d = out.getContext('2d')
        if (!target2d) return encode(canvas, 'image/png')
        target2d.fillStyle = '#ffffff'; target2d.fillRect(0, 0, out.width, out.height)
        target2d.drawImage(canvas, 0, kept.top, kept.w, kept.h, 0, 0, kept.w, kept.h)
        return encode(out, 'image/png')
      } finally { release(out) }
    } finally { release(canvas) }
  })
}

/** A small JPEG of a page from an open page, width pixels wide. */
export async function thumbFromPage(page: PDFPageProxy, width = 240): Promise<string> {
  const natural = page.getViewport({ scale: 1 })
  const canvas = await draw(page, Math.max(16, Math.min(1200, width)) / Math.max(1, natural.width))
  try { return encode(canvas, 'image/jpeg', 0.8).src }
  finally { release(canvas) }
}

export async function renderThumb(bookId: string, index: number, width = 240): Promise<string> {
  const size = Math.max(16, Math.min(1200, Math.round(width)))
  const key = `${bookId}:${index}:${size}`
  const cached = await getThumb(key).catch(() => null)
  if (cached) return cached
  const src = await withPage(bookId, index, page => thumbFromPage(page, size))
  await putThumb(key, src).catch(() => undefined)
  return src
}
