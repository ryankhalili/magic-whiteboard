import type { BoardObject, Bounds } from '../../shared/board'
import { FEATURE_WEIGHTS } from '../../shared/ranking'
import type { Spot } from '../library/types'

/** Board content to keep clear of. label names it in spot descriptions ("graph", "equation"). */
export type Obstacle = Bounds & { label?: string }
export type ContentKind = 'plot' | 'math' | 'text' | 'geometry'
export type SpotContext = { viewport: Bounds; obstacles: readonly Obstacle[] }
export type SpotInput = {
  viewport: Bounds; obstacles: readonly Obstacle[]; size: { w: number; h: number }
  /** empty board space kept free under the content for the teacher's work */
  workBelow?: number
  /** the selection or last created object */
  near?: Bounds | null
  max?: number
  /** page space rects covered by floating ui (reference panel, command dock); avoided but not content */
  avoid?: readonly Bounds[]
  /** board units kept clear inside the viewport edges; defaults scale with the viewport */
  insets?: { top?: number; right?: number; bottom?: number; left?: number }
}

// same natural sizes as getPlacementBounds in controller.ts
export const NATURAL_SIZES: Record<ContentKind, { w: number; h: number }> = {
  plot: { w: 440, h: 320 }, math: { w: 380, h: 145 }, geometry: { w: 270, h: 230 }, text: { w: 340, h: 150 },
}

const PAD = 24, GAP = 32, TOL = 2, MAX_LINES = 48, MAX_REFS = 16, LIMIT = 1e5
// tool rail on the left, command dock at the bottom
const DEFAULT_INSETS = { top: .04, right: .025, bottom: .15, left: .065 }
const FEATURES = ['inView', 'readingOrder', 'workSpace', 'nearFocus', 'centered', 'aligned'] as const

const clamp01 = (v: number) => v > 0 ? v < 1 ? v : 1 : 0
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const isBox = (b: unknown): b is Bounds => {
  const r = b as Bounds | null
  return !!r && typeof r === 'object' && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w >= 0 && r.h >= 0
}
// touching counts, so zero width strokes still count as in view
const touches = (a: Bounds, b: Bounds) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
const round10 = (v: number) => Math.max(0, Math.round(v / 10) * 10)

function overlapFrac(x: number, y: number, w: number, h: number, a: Bounds) {
  const ix = Math.min(x + w, a.x + a.w) - Math.max(x, a.x), iy = Math.min(y + h, a.y + a.h) - Math.max(y, a.y)
  return ix > 0 && iy > 0 && w > 0 && h > 0 ? ix * iy / (w * h) : 0
}

// inflated obstacles sorted by top, so a column can be merged in one pass
type Blockers = { x0: Float64Array; x1: Float64Array; y0: Float64Array; y1: Float64Array; n: number }
type Column = { tops: number[]; bottoms: number[] }

function makeBlockers(content: readonly Bounds[], avoid: readonly Bounds[]): Blockers {
  const rows = [...content.map(b => [b, PAD] as const), ...avoid.map(b => [b, PAD / 2] as const)]
    .map(([b, p]) => [b.x - p, b.x + b.w + p, b.y - p, b.y + b.h + p]).sort((a, b) => a[2] - b[2])
  const n = rows.length, bl = { x0: new Float64Array(n), x1: new Float64Array(n), y0: new Float64Array(n), y1: new Float64Array(n), n }
  rows.forEach((r, i) => { bl.x0[i] = r[0]; bl.x1[i] = r[1]; bl.y0[i] = r[2]; bl.y1[i] = r[3] })
  return bl
}

// merged vertical intervals blocked for a rect spanning lo..hi
function makeColumn(bl: Blockers, lo: number, hi: number): Column {
  const tops: number[] = [], bottoms: number[] = []
  let k = -1
  for (let i = 0; i < bl.n; i++) {
    if (bl.x0[i] >= hi || bl.x1[i] <= lo) continue
    if (k >= 0 && bl.y0[i] <= bottoms[k]) { if (bl.y1[i] > bottoms[k]) bottoms[k] = bl.y1[i] }
    else { tops.push(bl.y0[i]); bottoms.push(bl.y1[i]); k++ }
  }
  return { tops, bottoms }
}

function firstAfter(col: Column, y: number) {
  let lo = 0, hi = col.bottoms.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (col.bottoms[m] > y) hi = m; else lo = m + 1 }
  return lo
}
const fitsAt = (col: Column, y: number, h: number) => { const i = firstAfter(col, y); return i >= col.tops.length || col.tops[i] >= y + h }
function firstFree(col: Column, y: number, h: number) {
  for (let i = firstAfter(col, y); i < col.tops.length && col.tops[i] < y + h; i++) y = col.bottoms[i]
  return y
}
const roomBelow = (col: Column, y: number) => { const i = firstAfter(col, y); return i < col.tops.length ? col.tops[i] - y : Infinity }

function lowerBound(keys: readonly number[], v: number) {
  let lo = 0, hi = keys.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < v) lo = m + 1; else hi = m }
  return lo
}

function gridLines(lo: number, hi: number, step: number, extra: readonly number[]) {
  if (!(hi > lo)) return [lo]
  const s = Math.max(step, (hi - lo) / (MAX_LINES - 1)), out: number[] = []
  for (let v = lo; v < hi; v += s) out.push(v)
  out.push(hi)
  for (const e of extra) if (e >= lo && e <= hi) out.push(e)
  out.sort((a, b) => a - b)
  return out.filter((v, i) => i === 0 || v - out[i - 1] > .5)
}

function safeArea(v: Bounds, insets: SpotInput['insets']): Bounds {
  const pick = (key: keyof typeof DEFAULT_INSETS, size: number) => {
    const value = insets?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : size * DEFAULT_INSETS[key]
  }
  const left = pick('left', v.w), right = pick('right', v.w), top = pick('top', v.h), bottom = pick('bottom', v.h)
  const s = { x: v.x + left, y: v.y + top, w: v.w - left - right, h: v.h - top - bottom }
  return s.w > 1 && s.h > 1 ? s : v
}

/** Free rectangles for new content of `size`, best first, each with room `workBelow` under it. */
export function findSpots(input: SpotInput): Spot[] {
  const view = input?.viewport, size = input?.size
  if (!isBox(view) || !(view.w > 0) || !(view.h > 0) || !size || !(size.w > 0) || !(size.h > 0) || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return []
  const w = Math.min(size.w, LIMIT), h = Math.min(size.h, LIMIT)
  const wb = typeof input.workBelow === 'number' && input.workBelow > 0 ? Math.min(input.workBelow, LIMIT) : 0, reserve = h + wb
  const max = clamp(Math.round(typeof input.max === 'number' && Number.isFinite(input.max) ? input.max : 12), 1, 50)
  const safe = safeArea(view, input.insets), safeBottom = safe.y + safe.h
  const content = Array.isArray(input.obstacles) ? input.obstacles.filter(isBox) : []
  const near = isBox(input.near) ? input.near : null
  const blockers = makeBlockers(content, Array.isArray(input.avoid) ? input.avoid.filter(isBox) : [])
  const inView = content.filter(o => touches(o, view))
  let lowest: Bounds | null = null, rightmost: Bounds | null = null, minLeft = Infinity
  for (const o of inView) {
    if (!lowest || o.y + o.h > lowest.y + lowest.h) lowest = o
    if (!rightmost || o.x + o.w > rightmost.x + rightmost.w) rightmost = o
    if (o.x < minLeft) minLeft = o.x
  }
  const refs = inView.length > MAX_REFS ? [...inView].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_REFS) : [...inView]
  if (near) refs.push(near)

  const columns = new Map<number, Column>()
  const column = (x: number) => {
    let col = columns.get(x)
    if (!col) { col = makeColumn(blockers, x, x + w); columns.set(x, col) }
    return col
  }
  const xs: number[] = [], ys: number[] = [], seen = new Set<string>()
  const add = (x: number, y: number) => {
    const key = `${Math.round(x)},${Math.round(y)}`
    if (!seen.has(key)) { seen.add(key); xs.push(x); ys.push(y) }
  }

  // grid over the safe area, plus lines aligned with nearby content
  const step = Math.max(40, Math.max(view.w, view.h) / 40), xMax = Math.max(safe.x, safe.x + safe.w - w)
  const gridX = gridLines(safe.x, safe.x + safe.w - w, step, refs.flatMap(o => [o.x, o.x + o.w + GAP]))
  const gridY = gridLines(safe.y, safeBottom - h, step, refs.flatMap(o => [o.y, o.y + o.h + GAP]))
  for (const x of gridX) {
    const col = column(x)
    for (const y of gridY) if (fitsAt(col, y, reserve)) add(x, y)
  }
  // just below or right of the focus and the latest content, sliding down past anything in the way
  const slide = (x: number, y: number) => add(x, firstFree(column(x), y, reserve))
  const clampX = (x: number) => clamp(x, safe.x, xMax)
  const belowAll = Math.max(safe.y, lowest ? lowest.y + lowest.h + GAP : safe.y)
  if (near) { slide(clampX(near.x), near.y + near.h + GAP); slide(near.x + near.w + GAP, near.y) }
  if (rightmost) slide(rightmost.x + rightmost.w + GAP, Math.max(safe.y, rightmost.y))
  slide(Number.isFinite(minLeft) ? clampX(minLeft) : safe.x, belowAll)
  slide(clampX(safe.x + (safe.w - w) / 2), belowAll)

  // features
  const weights = FEATURE_WEIGHTS.placement ?? {}, weight = FEATURES.map(k => weights[k] ?? 0)
  const ref = near ?? lowest, centerX = safe.x + safe.w / 2, centerY = safe.y + safe.h / 2
  const halfDiag = Math.hypot(safe.w, safe.h) / 2, reach = Math.max(safe.w, safe.h) / 2, desired = wb > 0 ? wb * 1.5 : 160
  const byLeft = [...inView].sort((a, b) => a.x - b.x), leftKeys = byLeft.map(o => o.x)
  const byTop = [...inView].sort((a, b) => a.y - b.y), topKeys = byTop.map(o => o.y)
  const aligned = (x: number, y: number) => {
    for (let i = lowerBound(leftKeys, x - TOL), end = Math.min(byLeft.length, i + 64); i < end && leftKeys[i] <= x + TOL; i++) {
      const o = byLeft[i], gap = o.y + o.h <= y ? y - o.y - o.h : y + h <= o.y ? o.y - y - h : -1
      if (gap >= 0 && gap <= safe.h / 2) return 1
    }
    for (let i = lowerBound(topKeys, y - TOL), end = Math.min(byTop.length, i + 64); i < end && topKeys[i] <= y + TOL; i++) {
      const o = byTop[i], gap = o.x + o.w <= x ? x - o.x - o.w : x + w <= o.x ? o.x - x - w : -1
      if (gap >= 0 && gap <= safe.w / 2) return .8
    }
    return 0
  }
  const readingOrder = (x: number, y: number) => {
    if (!ref) return 1 - .6 * clamp01((y - safe.y) / safe.h)
    const bottom = ref.y + ref.h, right = ref.x + ref.w, xGap = Math.max(0, ref.x - x - w, x - right)
    if (y >= bottom - TOL) return 1 - .5 * clamp01((y - bottom) / safe.h) - .2 * clamp01(xGap / safe.w)
    if (x >= right - TOL) return .85 - .4 * clamp01(Math.abs(y - ref.y) / safe.h) - .2 * clamp01((x - right) / safe.w)
    return y + h <= ref.y + TOL ? .15 : .3
  }
  const count = xs.length, values = new Float64Array(count * FEATURES.length), scores = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i], shown = overlapFrac(x, y, w, h, safe)
    let inViewValue = shown >= .999 ? 1 : .6 * shown
    if (wb > 0) inViewValue *= .75 + .25 * overlapFrac(x, y + h, w, wb, safe)
    const free = Math.min(roomBelow(column(x), y + h), safeBottom - y - h)
    let nearValue = 0
    if (near) nearValue = clamp01(1 - Math.hypot(Math.max(0, near.x - x - w, x - near.x - near.w), Math.max(0, near.y - y - h, y - near.y - near.h)) / reach)
    const f = [inViewValue, readingOrder(x, y), clamp01(free / desired) * shown, nearValue, 1 - clamp01(Math.hypot(x + w / 2 - centerX, y + h / 2 - centerY) / halfDiag), aligned(x, y)]
    let score = 0
    for (let k = 0; k < f.length; k++) { values[i * f.length + k] = clamp01(f[k]); score += weight[k] * clamp01(f[k]) }
    scores[i] = score
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => scores[b] - scores[a] || ys[a] - ys[b] || xs[a] - xs[b])

  // drop near duplicates (iou > .5), keep the best
  const kept: number[] = [], area = w * h
  for (const i of order) {
    if (kept.length >= max) break
    const dup = kept.some(j => {
      const ix = w - Math.abs(xs[i] - xs[j]), iy = h - Math.abs(ys[i] - ys[j])
      if (ix <= 0 || iy <= 0) return false
      const inter = ix * iy
      return inter / (2 * area - inter) > .5
    })
    if (!dup) kept.push(i)
  }
  const context: SpotContext = { viewport: view, obstacles: content }
  return kept.map((i, n) => {
    const bounds = { x: xs[i], y: ys[i], w, h }
    const features: Record<string, number> = {}
    FEATURES.forEach((k, j) => { features[k] = Math.round(values[i * FEATURES.length + j] * 1000) / 1000 })
    return { id: `S${n + 1}`, bounds, description: describeSpot(bounds, context), features }
  })
}

function areaName(b: Bounds, v: Bounds) {
  const fx = (b.x + b.w / 2 - v.x) / v.w, fy = (b.y + b.h / 2 - v.y) / v.h
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return ''
  const row = fy < 1 / 3 ? 'top' : fy < 2 / 3 ? 'middle' : 'bottom', side = fx < 1 / 3 ? 'left' : fx < 2 / 3 ? 'center' : 'right'
  return row === 'middle' ? side === 'center' ? 'center of the view' : `${side} side of the view` : `${row} ${side} of the view`
}

/** One line a ranker can judge: "right of the graph, top aligned, 420 px free below". */
export function describeSpot(bounds: Bounds, context: SpotContext): string {
  const b = bounds, view = context?.viewport, obstacles = Array.isArray(context?.obstacles) ? context.obstacles.filter(isBox) : []
  if (!isBox(b) || !isBox(view) || !(view.w > 0) || !(view.h > 0)) return 'open area'
  const right = b.x + b.w, bottom = b.y + b.h, parts: string[] = []
  const gaps = (o: Bounds) => ({ dx: Math.max(0, o.x - right, b.x - o.x - o.w), dy: Math.max(0, o.y - bottom, b.y - o.y - o.h) })
  let best: Obstacle | null = null, bestGap = Infinity
  for (const o of obstacles) {
    if (!touches(o, view)) continue
    const { dx, dy } = gaps(o), gap = Math.hypot(dx, dy)
    if (gap < bestGap) { best = o; bestGap = gap }
  }
  if (best && bestGap <= .4 * Math.max(view.w, view.h)) {
    const o = best, name = (o.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'content'
    const { dx, dy } = gaps(o), tol = Math.max(4, Math.min(view.w, view.h) * .005)
    if (dx === 0 && dy === 0) parts.push(`over the ${name}`)
    else if (dy >= dx) {
      parts.push(`${b.y >= o.y + o.h ? 'below' : 'above'} the ${name}`)
      if (Math.abs(b.x - o.x) <= tol) parts.push('left aligned')
      else if (Math.abs(b.x + b.w / 2 - o.x - o.w / 2) <= tol) parts.push('centered')
    } else {
      parts.push(`${b.x >= o.x + o.w ? 'right' : 'left'} of the ${name}`)
      if (Math.abs(b.y - o.y) <= tol) parts.push('top aligned')
    }
  } else {
    const where = areaName(b, view)
    parts.push(where ? `open area, ${where}` : 'open area')
  }
  const shown = overlapFrac(b.x, b.y, b.w, b.h, view)
  if (shown <= 0) parts.push(b.y >= view.y + view.h ? 'below the view' : 'off screen')
  else if (shown < .999) parts.push('partly off screen')
  const viewBottom = view.y + view.h
  if (shown > 0 && bottom <= viewBottom) {
    let next = Infinity
    for (const o of obstacles) if (o.x < right && o.x + o.w > b.x && o.y + o.h > bottom) next = Math.min(next, Math.max(o.y, bottom))
    const visible = viewBottom - bottom, free = Math.min(next - bottom, visible)
    parts.push(next - bottom <= visible || visible >= 40 ? `${round10(free)} px free below` : 'more room below off screen')
  }
  return parts.join(', ')
}

const KIND_LABELS: Record<string, string> = {
  plot: 'graph', math: 'equation', text: 'note', geometry: 'figure', draw: 'handwriting', image: 'image',
  textbook_page: 'textbook page', textbook_item: 'textbook problem', pdf_page: 'PDF page',
}

/** Board objects as labeled obstacles for findSpots. */
export function obstaclesFromObjects(objects: readonly BoardObject[] | null | undefined): Obstacle[] {
  const out: Obstacle[] = []
  for (const o of objects ?? []) {
    if (!o || !isBox(o.bounds)) continue
    const { x, y, w, h } = o.bounds
    out.push({ x, y, w, h, label: KIND_LABELS[o.kind] ?? String(o.kind ?? 'object').replace(/_/g, ' ') })
  }
  return out
}

const PLOT = /\b(plot|plots|plotting|graph|graphs|graphing|curves?|parabolas?|hyperbolas?)\b/
const SHAPE = /\b(triangles?|rectangles?|squares?|circles?|ellipses?|ovals?|polygons?|pentagons?|hexagons?|octagons?|quadrilaterals?|parallelograms?|trapezoids?|trapezium|rhombus|kites?|arrows?|polylines?|shapes?)\b/
const DRAW = /\b(draw|sketch|construct)\b/
const TEXT = /\b(notes?|text|labels?|caption|title|heading|sentence|paragraph|reminder|list|bullets?|agenda|homework|definition|explain|explanation|words?)\b/
const MATH_WORDS = /\b(equations?|formulas?|formulae|expressions?|integrals?|derivatives?|limits?|fractions?|matrix|matrices|latex|identity|inequality|solve|simplify|factor|expand|evaluate|squared|cubed|sqrt|square root|summation|area|volume|perimeter)\b/
const MATH_SIGNS = /[=^\\√∫∑π≤≥±]|\d\s*[+*/]\s*\d/

/** Likely kind and natural size of what a typed command will create. */
export function guessContentSize(text: string): { kind: ContentKind; w: number; h: number } {
  const t = String(text ?? '').slice(0, 2000).toLowerCase().replace(/square roots?/g, 'sqrt')
  const mathWords = MATH_WORDS.test(t)
  const kind: ContentKind = PLOT.test(t) ? 'plot'
    : SHAPE.test(t) && (DRAW.test(t) || !mathWords) ? 'geometry'
      : TEXT.test(t) ? 'text'
        : mathWords || MATH_SIGNS.test(t) ? 'math' : 'text'
  return { kind, ...NATURAL_SIZES[kind] }
}
