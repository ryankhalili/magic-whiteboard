import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { withBookPdf } from './pdfjs'
import { getBookBytes, getThumb, putThumb } from './store'
import type { Anchor, PageBox, RenderedImage } from './types'

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
export function inkBounds(data: Uint8ClampedArray, width: number, height: number, margin = 12, blankTop = false, preserveHeading = false): { top: number; w: number; h: number } {
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
  if (first < zone && !preserveHeading) {
    let end = first
    while (end < height && inkRow[end] >= 0.6) end++
    if (end - first <= thin) top = end
  }
  // the second part of a split item starts at its first ink, not at the page margin
  if (blankTop) {
    while (top < height - 1 && inkRow[top] === 0) top++
    top = Math.max(0, top - Math.min(margin, 6))
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

/** False when a drawn part is blank. */
function hasInk(canvas: Canvas): boolean {
  const context = canvas.getContext('2d')
  if (!context) return true
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 16 && (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235)) return true
  return false
}

/** Paints the bits of neighbouring items that fall inside a crop white. */
function paintOut(canvas: Canvas, box: PageBox, mask: PageBox[] | undefined) {
  const context = mask?.length ? canvas.getContext('2d') : null
  if (!context || !mask) return
  const sx = canvas.width / box.w, sy = canvas.height / box.h
  context.fillStyle = '#ffffff'
  for (const m of mask) {
    if (![m?.x, m?.y, m?.w, m?.h].every(value => typeof value === 'number' && Number.isFinite(value))) continue
    const x0 = Math.max(0, Math.floor((m.x - box.x) * sx)), y0 = Math.max(0, Math.floor((m.y - box.y) * sy))
    const x1 = Math.min(canvas.width, Math.ceil((m.x + m.w - box.x) * sx)), y1 = Math.min(canvas.height, Math.ceil((m.y + m.h - box.y) * sy))
    if (x1 > x0 && y1 > y0) context.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
}

/** The light gray or pastel fill of a shaded box. */
function isTint(data: Uint8ClampedArray, i: number) {
  const r = data[i], g = data[i + 1], b = data[i + 2]
  return data[i + 3] > 200 && Math.min(r, g, b) >= 200 && Math.max(r, g, b) <= 250 && Math.max(r, g, b) - Math.min(r, g, b) <= 24
}

/**
 * What each row starts with at the crop's left edge: the tint of a shaded box, ink, or nothing.
 * A few pixels of page margin before the box are looked past.
 */
function leftEdge(data: Uint8ClampedArray, width: number, height: number): Array<'tint' | 'ink' | 'white'> {
  const span = Math.min(width, Math.max(6, Math.round(width * 0.06)))
  const at = (x: number, y: number) => (y * width + x) * 4
  const white = (i: number) => data[i + 3] <= 16 || (data[i] >= 252 && data[i + 1] >= 252 && data[i + 2] >= 252)
  const tinted = (i: number) => isTint(data, i)
  const kinds: Array<'tint' | 'ink' | 'white'> = []
  for (let y = 0; y < height; y++) {
    let first = 0
    while (first < span && white(at(first, y))) first++
    let tint = 0
    for (let x = first; x < span; x++) if (tinted(at(x, y))) tint++
    // a thin border line before the tint still counts as the box
    kinds.push(first >= span ? 'white' : tint >= 0.6 * (span - first) ? 'tint' : 'ink')
  }
  return kinds
}

/** The first row of a shaded box the crop starts in, after blank rows; null when it starts on white or ink. */
function shadedStart(kinds: Array<'tint' | 'ink' | 'white'>): number | null {
  let start = 0
  while (start < kinds.length * 0.6 && kinds[start] === 'white') start++
  return start + 3 < kinds.length && kinds.slice(start, start + 3).every(kind => kind === 'tint') ? start : null
}

/**
 * Where a shaded box (a theorem or definition) that the crop starts in ends: the first white rows at its left edge.
 * Whatever follows the box, like a figure, stays out. null when the crop does not start in a shaded box, or when
 * the shade holds fewer than lines rows of text (a shaded title bar over a white item is not a box).
 */
export function shadedEnd(data: Uint8ClampedArray, width: number, height: number, lines = 1, kinds = leftEdge(data, width, height)): number | null {
  const start = shadedStart(kinds)
  if (start === null) return null
  let end: number | null = null
  for (let y = start, run = 0; y < height && end === null; y++) {
    run = kinds[y] === 'white' ? run + 1 : 0
    if (run >= 4) end = y - run + 1
  }
  if (end === null) return null
  let rows = 0, inText = false
  for (let y = start; y < end; y++) {
    let dark = false
    for (let x = 0, i = y * width * 4; x < width && !dark; x++, i += 4) dark = data[i + 3] > 16 && Math.min(data[i], data[i + 1], data[i + 2]) < 180
    if (dark && !inText) rows++
    inText = dark
  }
  return rows >= lines ? end : null
}

/**
 * The fill of a shaded box near the foot of a kept part: its most common color and the columns it spans,
 * so the space between two parts of a split box can be filled the same. null when those rows hold no box.
 */
export function shadeBand(data: Uint8ClampedArray, width: number, height: number, rows = 12): { color: string; x0: number; x1: number } | null {
  for (let y = height - 1; y >= 0 && y >= height - rows; y--) {
    let x0 = -1, x1 = -1
    const counts = new Map<string, number>()
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      if (!isTint(data, i)) continue
      if (x0 < 0) x0 = x
      x1 = x
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (x0 < 0 || x1 - x0 < width * 0.5) continue
    const color = [...counts.entries()].reduce((best, next) => next[1] > best[1] ? next : best)[0]
    return { color: `rgb(${color})`, x0, x1 }
  }
  return null
}

/** Trims a drawn part the way item crops are trimmed; null when nothing is left. */
function trimmed(canvas: Canvas, blankTop: boolean): { canvas: Canvas; top: number; w: number; h: number; shaded: boolean } | null {
  const context = canvas.getContext('2d')
  if (!context) return { canvas, top: 0, w: canvas.width, h: canvas.height, shaded: false }
  if (blankTop && !hasInk(canvas)) return null
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  const kinds = leftEdge(data, canvas.width, canvas.height)
  // the first part must show a box of at least two rows of text; the rest of a split item may hold just a formula
  const end = shadedEnd(data, canvas.width, canvas.height, blankTop ? 1 : 2, kinds)
  const kept = inkBounds(data, canvas.width, end ?? canvas.height, 12, blankTop, !blankTop)
  return { canvas, ...kept, shaded: shadedStart(kinds) !== null }
}

/**
 * A crisp PNG of a detected item: neighbours painted out, blank space and separator rules trimmed,
 * and the rest of an item split across pages stitched underneath at the same scale.
 */
export async function renderAnchor(bookId: string, anchor: Anchor, opts: { targetWidth?: number } = {}): Promise<RenderedImage> {
  const box = clampBox(anchor.box)
  const target = Math.min(3000, Math.max(200, Math.round(opts.targetWidth ?? 1400)))
  const tail = anchor.continues && Number.isInteger(anchor.continues.pageIndex) && anchor.continues.pageIndex >= 0 && anchor.continues.box
    ? { index: anchor.continues.pageIndex, box: clampBox(anchor.continues.box) } : null
  return limited(() => withBookPdf(bookId, () => getBookBytes(bookId), async doc => {
    checkIndex(doc, anchor.pageIndex)
    const page = await doc.getPage(anchor.pageIndex + 1)
    const next = tail && tail.index < doc.numPages ? (tail.index === anchor.pageIndex ? page : await doc.getPage(tail.index + 1).catch(() => null)) : null
    const parts: Canvas[] = []
    try {
      const natural = page.getViewport({ scale: 1 })
      const second = next ? next.getViewport({ scale: 1 }) : null
      const area = box.w * natural.width * box.h * natural.height + (second && tail ? tail.box.w * second.width * tail.box.h * second.height : 0)
      // both parts share one scale so the text lines up, and together stay under 16M pixels
      const scale = Math.min(cropScale(natural, box, target), Math.sqrt(16_000_000 / Math.max(1, area)))
      const first = await draw(page, scale, box)
      parts.push(first)
      paintOut(first, box, anchor.mask)
      const head = trimmed(first, false)!
      let rest: ReturnType<typeof trimmed> = null
      if (next && tail) {
        const drawn = await draw(next, scale, tail.box)
        parts.push(drawn)
        rest = trimmed(drawn, true)
        // a boxed theorem goes on inside the same kind of box; anything else at the top of the next page is not its rest
        if (rest && rest.shaded !== head.shaded) rest = null
      }
      const gap = rest ? Math.round(0.6 * 12 * scale) : 0
      // both parts keep the same width so a shaded box looks whole
      const width = Math.max(head.w, rest?.w ?? 0)
      // a split shaded box stays one box: the space between its parts gets its fill, not white
      const foot = Math.min(12, head.h)
      const headData = rest?.shaded ? head.canvas.getContext('2d')?.getImageData(0, head.top + head.h - foot, head.canvas.width, foot) : null
      const band = headData ? shadeBand(headData.data, head.canvas.width, foot) : null
      const out = makeCanvas(width, head.h + gap + (rest?.h ?? 0))
      parts.push(out)
      const context = out.getContext('2d')
      if (!context) return encode(first, 'image/png')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, out.width, out.height)
      const w1 = Math.min(width, head.canvas.width)
      context.drawImage(head.canvas, 0, head.top, w1, head.h, 0, 0, w1, head.h)
      if (rest) {
        if (band && band.x0 < width) { context.fillStyle = band.color; context.fillRect(band.x0, head.h, Math.min(width, band.x1 + 1) - band.x0, gap) }
        const w2 = Math.min(width, rest.canvas.width)
        context.drawImage(rest.canvas, 0, rest.top, w2, rest.h, 0, head.h + gap, w2, rest.h)
      }
      return encode(out, 'image/png')
    } finally {
      parts.forEach(release)
      page.cleanup()
      if (next && next !== page) next.cleanup()
    }
  }))
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
