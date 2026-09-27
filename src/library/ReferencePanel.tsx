import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { CornerDownLeft, Crop, GripHorizontal, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { getAnchors, getPages } from './store'
import { renderPage } from './render'
import type { Anchor, AnchorKind, BookRecord, PageBox, PageRecord, RankedCandidate, RenderedImage } from './types'
import './library.css'

type Props = {
  book: BookRecord; highlight: RankedCandidate[] | null
  onInsertPage(index: number): void; onInsertCrop(index: number, box: PageBox): void; onInsertCandidate(c: RankedCandidate): void
  onSearch(text: string): void; onClose(): void; busy: boolean; message?: string | null
  /** changes with every lookup, so the same matches show and scroll again after the teacher hid them */
  lookup?: number
  /** the teacher hid the matches */
  onDismiss?(): void
  /** the page in the middle of the view */
  onPageChange?(index: number): void
}
type Point = { x: number; y: number }
export type PanelRect = { x: number; y: number; w: number; h: number }
/** the part of the window the panel may use (below the app header) */
export type PanelArea = { left: number; top: number; width: number; height: number }
/** a window rectangle the panel must stay above, like the typing bar */
export type KeepOut = { left: number; top: number; right: number; bottom: number }
type CropState = { index: number; start: Point | null; end: Point | null; box: PageBox | null }

export const PANEL_DEFAULT = { w: 380, h: 560 }
export const PANEL_MIN = { w: 300, h: 320 }
export const DEFAULT_ASPECT = 11 / 8.5
const PANEL_KEY = 'magic-whiteboard-reference-panel-v1'
const EDGE = 8, SIDE = 12, GAP = 14, RENDER_TIMEOUT = 20_000, FULL: PageBox = { x: 0, y: 0, w: 1, h: 1 }
const KIND_NAMES: Record<AnchorKind, string> = { example: 'Example', exercise: 'Exercise', problem: 'Problem', checkpoint: 'Checkpoint', section: 'Section', theorem: 'Theorem', definition: 'Definition', question: 'Question', figure: 'Figure', table: 'Table' }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * keeps the panel fully inside the area and at least the minimum size (or the area, when smaller).
 * Over the typing bar (keepOut) the panel moves up, then gets shorter, so the bar stays uncovered.
 */
export function clampPanel(rect: Partial<PanelRect>, area: PanelArea, min = PANEL_MIN, keepOut?: KeepOut | null): PanelRect {
  const maxW = Math.max(120, area.width - EDGE * 2), maxH = Math.max(120, area.height - EDGE * 2)
  const w = clamp(finite(rect.w, PANEL_DEFAULT.w), Math.min(min.w, maxW), maxW)
  let h = clamp(finite(rect.h, PANEL_DEFAULT.h), Math.min(min.h, maxH), maxH)
  const x = clamp(finite(rect.x, area.left + 80), area.left + EDGE, Math.max(area.left + EDGE, area.left + area.width - EDGE - w))
  let y = clamp(finite(rect.y, area.top + 80), area.top + EDGE, Math.max(area.top + EDGE, area.top + area.height - EDGE - h))
  if (keepOut && [keepOut.left, keepOut.top, keepOut.right].every(Number.isFinite) && x < keepOut.right && x + w > keepOut.left) {
    const limit = keepOut.top - EDGE, top = area.top + EDGE
    if (y + h > limit && limit - top >= 120) {
      y = Math.max(top, limit - h)
      h = Math.min(h, limit - y)
    }
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** beside the tool rail (left 18, width 52), level with its top */
export const defaultPanelRect = (area: PanelArea): PanelRect => clampPanel({ x: area.left + 80, y: area.top + 80, ...PANEL_DEFAULT }, area)

/** the rectangle between two drag points as page fractions, null when it is too small to be a crop */
export function normalizeCrop(a: Point, b: Point, min = .01): PageBox | null {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null
  const x0 = clamp(Math.min(a.x, b.x), 0, 1), x1 = clamp(Math.max(a.x, b.x), 0, 1)
  const y0 = clamp(Math.min(a.y, b.y), 0, 1), y1 = clamp(Math.max(a.y, b.y), 0, 1)
  if (x1 - x0 < min || y1 - y0 < min || x1 - x0 <= 0 || y1 - y0 <= 0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const safeAspect = (width: number, height: number) => width > 0 && height > 0 && Number.isFinite(width / height) ? clamp(height / width, .2, 5) : DEFAULT_ASPECT

/** vertical layout of the page list: each page is a toolbar of `bar` px plus the sheet at `width` */
export function layoutPages(aspects: number[], width: number, bar: number, gap = GAP) {
  const tops: number[] = [], heights: number[] = [], sheets: number[] = []
  let y = 6
  for (const aspect of aspects) {
    const sheet = Math.max(40, Math.round(width * (Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT)))
    tops.push(y); sheets.push(sheet); heights.push(bar + sheet); y += bar + sheet + gap
  }
  return { tops, heights, sheets, total: y }
}

/** first and last page index that intersect the scroll window, plus overscan */
export function visibleRange(tops: number[], heights: number[], scrollTop: number, viewHeight: number, overscan = 1): [number, number] {
  const n = tops.length
  if (!n) return [0, -1]
  const top = Math.max(0, finite(scrollTop, 0)), bottom = top + Math.max(1, finite(viewHeight, 1))
  let low = 0, high = n - 1
  while (low < high) { const mid = (low + high) >> 1; if (tops[mid] + heights[mid] < top) low = mid + 1; else high = mid }
  const first = low
  low = first; high = n - 1
  while (low < high) { const mid = (low + high + 1) >> 1; if (tops[mid] <= bottom) low = mid; else high = mid - 1 }
  return [Math.max(0, first - overscan), Math.min(n - 1, Math.max(first, low) + overscan)]
}

type Layout = { tops: number[]; heights: number[]; total?: number }
/** the page at a height in the list */
export const pageAt = (layout: Layout, y: number) => visibleRange(layout.tops, layout.heights, y, 1, 0)[0]

/** the scroll position that keeps the page at the top of the view in place when the page sizes change */
export function anchoredScroll(before: Layout, after: Layout, scrollTop: number): number {
  const n = Math.min(before.tops.length, after.tops.length)
  if (!n || !Number.isFinite(scrollTop)) return 0
  const index = Math.min(n - 1, pageAt(before, scrollTop))
  const offset = scrollTop - before.tops[index]
  const scale = before.heights[index] > 0 ? after.heights[index] / before.heights[index] : 1
  return Math.max(0, after.tops[index] + (offset > 0 ? offset * scale : offset))
}

/** the matches the panel shows as badges 1, 2, 3 */
export function panelHits(highlight: readonly RankedCandidate[] | null | undefined, book: Pick<BookRecord, 'id' | 'pageCount'>): RankedCandidate[] {
  const count = Math.max(0, Math.floor(finite(book.pageCount, 0)))
  return (highlight ?? []).filter(c => c.bookId === book.id && c.pageIndex >= 0 && c.pageIndex < count).slice(0, 3)
}

/** longest edge in pixels to render a page shown `cssWidth` wide, in steps so resizing reuses renders */
export function renderEdge(cssWidth: number, aspect: number, pixelRatio = 1): number {
  const pixels = Math.max(1, finite(cssWidth, 360)) * clamp(finite(pixelRatio, 1), 1, 2)
  const width = clamp(Math.ceil(pixels / 160) * 160, 320, 1280)
  return Math.round(width * Math.max(1, finite(aspect, DEFAULT_ASPECT)))
}

export const pageLabelText = (labels: (string | null)[], index: number) => labels[index] ? `p. ${labels[index]}` : `file page ${index + 1}`
const pageName = (labels: (string | null)[], index: number) => labels[index] ? `page ${labels[index]}` : `file page ${index + 1}`

export function pageFromQuery(labels: (string | null)[], text: string): number | null {
  const match = /^\s*(?:page|pg\.?|p\.?)\s*(\d{1,4}|[ivxlcdm]{1,8})\s*$/i.exec(text)
  if (!match) return null
  const wanted = match[1].toLowerCase(), index = labels.findIndex(label => label != null && label.toLowerCase() === wanted)
  return index >= 0 ? index : null
}

export function anchorTitle(anchor: Anchor): string {
  const name = KIND_NAMES[anchor.kind] ?? 'Item'
  if (anchor.label) return `${name} ${anchor.label}`
  return anchor.heading ? anchor.heading.slice(0, 48) : name
}

/** a candidate for an item the teacher clicked directly in the panel */
export function anchorCandidate(book: BookRecord, anchor: Anchor): RankedCandidate {
  const label = book.labels[anchor.pageIndex] ?? null
  const description = `${anchorTitle(anchor)} on ${pageName(book.labels, anchor.pageIndex)}: ${anchor.heading}`.slice(0, 300)
  return { id: anchor.id, bookId: book.id, pageIndex: anchor.pageIndex, label, kind: 'item', anchor, description, features: {}, p: 1 }
}

export function candidateTitle(c: RankedCandidate, labels: (string | null)[]): string {
  const where = pageLabelText(labels, c.pageIndex)
  return c.kind === 'item' && c.anchor ? `${anchorTitle(c.anchor)}, ${where}` : `Whole page, ${where}`
}

// rendered page images shared across panel instances, most recent last
const images = new Map<string, string>()
const IMAGE_LIMIT = 90
const imageKey = (bookId: string, index: number, edge: number) => `${bookId}:${index}:${edge}`
function remember(key: string, src: string) {
  images.delete(key); images.set(key, src)
  while (images.size > IMAGE_LIMIT) { const oldest = images.keys().next().value; if (oldest === undefined) break; images.delete(oldest) }
}
function cachedImage(bookId: string, index: number, edge: number): string | undefined {
  const exact = images.get(imageKey(bookId, index, edge))
  if (exact) return exact
  const prefix = `${bookId}:${index}:`
  for (const [key, src] of images) if (key.startsWith(prefix)) return src
  return undefined
}
const scrollMemory = new Map<string, number>()
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Delete', 'Backspace'])

function panelArea(): PanelArea {
  if (typeof window === 'undefined') return { left: 0, top: 64, width: 1280, height: 736 }
  const bottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0
  const top = bottom > 0 && bottom < window.innerHeight / 2 ? bottom : 0
  return { left: 0, top, width: window.innerWidth, height: window.innerHeight - top }
}
// the typing bar (or voice controls) and the caption under it
const DOCK = '.command-dock .command-bar, .command-dock .command-caption, .command-dock .voice-panel'
function dockRect(): KeepOut | null {
  if (typeof document === 'undefined') return null
  let out: KeepOut | null = null
  for (const element of document.querySelectorAll(DOCK)) {
    const r = element.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out = out ? { left: Math.min(out.left, r.left), top: Math.min(out.top, r.top), right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  return out
}
const fitPanel = (rect: Partial<PanelRect>) => clampPanel(rect, panelArea(), PANEL_MIN, dockRect())
const samePanel = (a: PanelRect, b: PanelRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
function savedRect(): Partial<PanelRect> | null {
  if (typeof window === 'undefined') return null
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(PANEL_KEY) || 'null')
    return saved && typeof saved === 'object' ? saved as Partial<PanelRect> : null
  } catch { return null }
}
function initialRect(): PanelRect {
  const saved = savedRect(), area = panelArea()
  return fitPanel(saved ?? defaultPanelRect(area))
}
function saveRect(rect: PanelRect) { try { window.localStorage.setItem(PANEL_KEY, JSON.stringify(rect)) } catch { /* storage can be blocked */ } }
const media = (query: string) => { try { return typeof window !== 'undefined' && window.matchMedia(query).matches } catch { return false } }
const boxStyle = (box: PageBox): React.CSSProperties => ({ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` })
const fractionOf = (event: React.PointerEvent<HTMLElement>): Point => {
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.width ? (event.clientX - rect.left) / rect.width : 0, y: rect.height ? (event.clientY - rect.top) / rect.height : 0 }
}

export function ReferencePanel({ book, highlight, onInsertPage, onInsertCrop, onInsertCandidate, onSearch, onClose, busy, message, lookup = 0, onDismiss, onPageChange }: Props) {
  const [rect, setRect] = useState<PanelRect>(initialRect)
  const [dragging, setDragging] = useState<'move' | 'resize' | null>(null)
  const [coarse, setCoarse] = useState(false)
  const [aspects, setAspects] = useState<number[] | null>(null)
  const [anchors, setAnchors] = useState<Map<number, Anchor[]>>(() => new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [view, setView] = useState(() => ({ w: rect.w - 2, h: Math.max(200, rect.h - 140) }))
  const [query, setQuery] = useState('')
  const [crop, setCrop] = useState<CropState | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [pulse, setPulse] = useState<string | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const list = useRef<HTMLDivElement>(null)
  const rectRef = useRef(rect); rectRef.current = rect
  const drag = useRef<{ kind: 'move' | 'resize'; x: number; y: number; rect: PanelRect; id: number } | null>(null)
  const bookId = useRef(book.id); bookId.current = book.id
  const want = useRef<{ index: number; edge: number }[]>([])
  const running = useRef(new Set<string>()), failed = useRef(new Set<string>())
  const alive = useRef(true), scrollFrame = useRef(0), pumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restored = useRef<string | null>(null), scrolledFor = useRef<string | null>(null)
  // the list position as last scrolled, before a layout change can clamp it
  const scrollAt = useRef(0), shownPage = useRef('')
  const pageChanged = useRef(onPageChange); pageChanged.current = onPageChange

  const count = Math.max(0, Math.floor(finite(book.pageCount, 0)))
  const bar = coarse ? 52 : 38
  const sheetWidth = Math.max(120, view.w - SIDE * 2)
  const [renderWidth, setRenderWidth] = useState(sheetWidth)
  const layout = useMemo(() => layoutPages(aspects ?? new Array<number>(count).fill(DEFAULT_ASPECT), sheetWidth, bar), [aspects, count, sheetWidth, bar])
  const layoutRef = useRef(layout); layoutRef.current = layout
  const [first, last] = visibleRange(layout.tops, layout.heights, scrollTop, view.h, 1)
  const hits = useMemo(() => panelHits(highlight, { id: book.id, pageCount: count }), [highlight, book.id, count])
  const hitKey = hits.map(c => c.id).join('|')
  const shownHits = hitKey && hitKey === dismissed ? [] : hits

  useEffect(() => { alive.current = true; setCoarse(media('(pointer: coarse)')); return () => { alive.current = false; cancelAnimationFrame(scrollFrame.current); clearTimeout(pumpTimer.current) } }, [])
  useEffect(() => { const t = setTimeout(() => setRenderWidth(sheetWidth), 220); return () => clearTimeout(t) }, [sheetWidth])
  useEffect(() => {
    const resize = () => setRect(current => { const next = fitPanel(current); return samePanel(next, current) ? current : next })
    // the header may not have been measurable on the first render
    setRect(initialRect())
    window.addEventListener('resize', resize)
    // the typing bar grows in voice mode; stay above it
    const dock = document.querySelector('.command-dock'), observer = dock && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    if (dock) observer?.observe(dock)
    return () => { window.removeEventListener('resize', resize); observer?.disconnect() }
  }, [])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () => setView(current => current.w === element.clientWidth && current.h === element.clientHeight ? current : { w: element.clientWidth, h: element.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // a different book starts fresh
  useEffect(() => { setAspects(null); setAnchors(new Map()); setCrop(null); failed.current.clear() }, [book.id, count])
  // page sizes, loaded once per book and again when its import finishes
  useEffect(() => {
    let current = true
    getPages(book.id).then((pages: PageRecord[]) => {
      if (!current) return
      const next = new Array<number>(count).fill(DEFAULT_ASPECT)
      for (const page of pages) if (page.index >= 0 && page.index < count) next[page.index] = safeAspect(page.width, page.height)
      setAspects(next)
    }).catch(() => { if (current) setAspects(prev => prev ?? new Array<number>(count).fill(DEFAULT_ASPECT)) })
    return () => { current = false }
  }, [book.id, count, book.indexed])
  // detected items, loaded again after the book is read again
  useEffect(() => {
    let current = true
    getAnchors(book.id).then((found: Anchor[]) => {
      if (!current) return
      const byPage = new Map<number, Anchor[]>()
      for (const anchor of found) {
        if (anchor.kind === 'section' || !anchor.box || !(anchor.box.w > 0 && anchor.box.h > 0)) continue
        const items = byPage.get(anchor.pageIndex) ?? []
        items.push(anchor); byPage.set(anchor.pageIndex, items)
      }
      for (const items of byPage.values()) items.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
      setAnchors(byPage)
    }).catch(() => { /* outlines are optional */ })
    return () => { current = false }
  }, [book.id, count, book.indexed, book.indexVersion])

  const scrollToY = useCallback((top: number) => {
    const element = list.current
    if (!element) return
    const target = Math.max(0, top), far = Math.abs(element.scrollTop - target) > element.clientHeight * 3
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: target, behavior: far || media('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' })
    else element.scrollTop = target
  }, [])
  const scrollToHit = useCallback((c: RankedCandidate) => {
    const { tops, sheets } = layoutRef.current
    if (tops[c.pageIndex] === undefined) return
    const box = c.kind === 'item' && c.anchor ? c.anchor.box : null
    scrollToY(tops[c.pageIndex] + (box ? bar + box.y * sheets[c.pageIndex] - 56 : 0))
    setPulse(c.id)
  }, [bar, scrollToY])
  useEffect(() => { if (!pulse) return; const t = setTimeout(() => setPulse(null), 1400); return () => clearTimeout(t) }, [pulse])

  // restore where the teacher was in this book, unless a highlight wants a spot
  useLayoutEffect(() => {
    if (!aspects || restored.current === book.id) return
    restored.current = book.id
    if (hits.length) return
    const top = scrollMemory.get(book.id) ?? 0
    if (list.current) list.current.scrollTop = top
    scrollAt.current = top; setScrollTop(top)
  }, [aspects, book.id, hits.length])
  // resizing changes every page height; keep the page at the top of the view where it was
  const before = useRef<{ layout: typeof layout; bookId: string } | null>(null)
  useLayoutEffect(() => {
    const prev = before.current
    before.current = aspects ? { layout, bookId: book.id } : null
    const element = list.current
    if (!prev || !aspects || !element || prev.bookId !== book.id || prev.layout === layout) return
    const top = Math.round(anchoredScroll(prev.layout, layout, scrollAt.current))
    if (Math.abs(top - scrollAt.current) < 1 && Math.abs(top - element.scrollTop) < 1) return
    element.scrollTop = top; scrollAt.current = top
    scrollMemory.set(book.id, top); setScrollTop(top)
  }, [layout, aspects, book.id])
  useEffect(() => {
    const index = count ? pageAt(layout, scrollTop + view.h / 2) : -1, key = `${book.id}:${index}`
    if (index < 0 || key === shownPage.current) return
    shownPage.current = key
    pageChanged.current?.(index)
  }, [layout, scrollTop, view.h, count, book.id])
  // a new lookup may return the same matches, so show and scroll to them again
  useEffect(() => { scrolledFor.current = null; setDismissed(null) }, [lookup])
  useEffect(() => {
    if (!aspects || !hits.length || scrolledFor.current === hitKey) return
    scrolledFor.current = hitKey
    scrollToHit(hits[0])
  }, [aspects, hitKey, hits, scrollToHit, lookup])
  useEffect(() => {
    if (!crop) return
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') setCrop(null) }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [crop])

  // render visible pages, at most two at a time, nearest the middle of the view first
  const pump = useCallback(() => {
    while (running.current.size < 2) {
      const id = bookId.current
      const next = want.current.find(item => { const key = imageKey(id, item.index, item.edge); return !images.has(key) && !running.current.has(key) && !failed.current.has(key) })
      if (!next) return
      const key = imageKey(id, next.index, next.edge)
      running.current.add(key)
      let timer: ReturnType<typeof setTimeout> | undefined
      const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Page render timed out.')), RENDER_TIMEOUT) })
      Promise.race([renderPage(id, next.index, { maxEdge: next.edge }), slow])
        .then((image: RenderedImage) => { if (image?.src) remember(key, image.src); else failed.current.add(key) })
        .catch(() => { failed.current.add(key) })
        .finally(() => { clearTimeout(timer); running.current.delete(key); if (alive.current) { redraw(); pump() } })
    }
  }, [])
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const edgeFor = (index: number) => renderEdge(renderWidth, aspects?.[index] ?? DEFAULT_ASPECT, ratio)
  useEffect(() => {
    const middle = scrollTop + view.h / 2, items: { index: number; edge: number; distance: number }[] = []
    for (let index = first; index <= last; index++) items.push({ index, edge: edgeFor(index), distance: Math.abs(layout.tops[index] + layout.heights[index] / 2 - middle) })
    want.current = items.sort((a, b) => a.distance - b.distance)
    clearTimeout(pumpTimer.current)
    pumpTimer.current = setTimeout(pump, 60)
  }, [first, last, renderWidth, aspects, book.id, pump])

  const scrolled = () => {
    scrollAt.current = list.current?.scrollTop ?? 0
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const top = list.current?.scrollTop ?? 0
      scrollMemory.set(bookId.current, top); setScrollTop(top)
    })
  }

  const startDrag = (kind: 'move' | 'resize') => (event: React.PointerEvent<HTMLElement>) => {
    if (kind === 'move' && (event.target as HTMLElement).closest('button,input,a')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
    drag.current = { kind, x: event.clientX, y: event.clientY, rect: rectRef.current, id: event.pointerId }
    setDragging(kind)
  }
  const dragged = (event: React.PointerEvent<HTMLElement>): PanelRect | null => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return null
    const dx = event.clientX - d.x, dy = event.clientY - d.y, area = panelArea(), dock = dockRect()
    if (d.kind === 'move') return clampPanel({ ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }, area, PANEL_MIN, dock)
    return clampPanel({ ...d.rect, w: Math.min(d.rect.w + dx, area.left + area.width - EDGE - d.rect.x), h: Math.min(d.rect.h + dy, area.top + area.height - EDGE - d.rect.y) }, area, PANEL_MIN, dock)
  }
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => { const next = dragged(event); if (next) setRect(next) }
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return
    const next = (event.type === 'pointercancel' ? null : dragged(event)) ?? rectRef.current
    drag.current = null; setDragging(null); setRect(next); saveRect(next)
  }
  const dragHandlers = (kind: 'move' | 'resize') => ({ onPointerDown: startDrag(kind), onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag })

  const submit = () => {
    const text = query.trim()
    if (!text || busy) return
    const index = pageFromQuery(book.labels, text)
    if (index !== null && layout.tops[index] !== undefined) scrollToY(layout.tops[index])
    onSearch(text)
  }
  const cropDown = (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
    const point = fractionOf(event)
    setCrop({ index, start: point, end: point, box: null })
  }
  const cropMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!crop?.start) return
    const end = fractionOf(event)
    setCrop({ ...crop, end })
  }
  const cropUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!crop?.start) return
    setCrop({ index: crop.index, start: null, end: null, box: normalizeCrop(crop.start, fractionOf(event)) })
  }

  const page = (index: number) => {
    const label = book.labels[index] ?? null, folio = pageLabelText(book.labels, index)
    const edge = edgeFor(index), src = cachedImage(book.id, index, edge)
    const broken = !src && failed.current.has(imageKey(book.id, index, edge))
    const cropping = crop?.index === index
    const liveBox = cropping && crop ? crop.start && crop.end ? normalizeCrop(crop.start, crop.end, 0) : crop.box : null
    const pageHits = shownHits.map((c, n) => ({ c, n: n + 1 })).filter(({ c }) => c.pageIndex === index)
    const box = cropping && crop && !crop.start ? crop.box : null
    const below = box ? box.y + box.h < .86 : true
    return <section key={index} className={`ref-page ${cropping ? 'is-cropping' : ''}`} style={{ top: layout.tops[index], height: layout.heights[index] }} aria-label={label ? `Page ${label}` : `File page ${index + 1}`}>
      <div className="ref-page-bar" style={{ height: bar }}>
        <span className={`ref-folio ${label ? '' : 'is-file'}`}>{folio}</span>
        <span className="ref-page-actions">
          {cropping ? <button type="button" onClick={() => setCrop(null)}>Cancel crop</button> : <button type="button" onClick={() => setCrop({ index, start: null, end: null, box: null })} disabled={busy}><Crop size={14}/>Crop</button>}
          <button type="button" className="ref-insert" onClick={() => onInsertPage(index)} disabled={busy}><Plus size={14}/>Insert page</button>
        </span>
      </div>
      <div className="ref-sheet" style={{ height: layout.sheets[index] }}>
        {src ? <img src={src} alt="" draggable={false}/> : <div className="ref-sheet-empty">{broken ? <><span>This page could not be shown.</span><button type="button" onClick={() => { failed.current.delete(imageKey(book.id, index, edge)); redraw(); pump() }}>Try again</button></> : <span>{folio}</span>}</div>}
        {!cropping && (anchors.get(index) ?? []).map(anchor => <button type="button" key={anchor.id} className="ref-anchor" style={boxStyle(anchor.box)} aria-label={`Insert ${anchorTitle(anchor)}`} onClick={() => { if (!busy) onInsertCandidate(anchorCandidate(book, anchor)) }}><span><Plus size={11}/>{anchorTitle(anchor)}</span></button>)}
        {!cropping && pageHits.map(({ c, n }) => <button type="button" key={c.id} className={`ref-hit ${c.kind === 'page' || !c.anchor ? 'is-page' : ''} ${pulse === c.id ? 'is-pulsing' : ''}`} style={boxStyle(c.kind === 'item' && c.anchor ? c.anchor.box : FULL)} aria-label={`Insert match ${n}: ${candidateTitle(c, book.labels)}`} title={c.description} onClick={() => { if (!busy) onInsertCandidate(c) }}><b>{n}</b></button>)}
        {cropping && <div className="ref-crop-layer" onPointerDown={cropDown(index)} onPointerMove={cropMove} onPointerUp={cropUp} onPointerCancel={cropUp}>
          {liveBox ? <div className="ref-crop-box" style={boxStyle(liveBox)}/> : <span className="ref-crop-hint">Drag over the part you want</span>}
        </div>}
        {box && <div className="ref-crop-actions" style={{ top: below ? `calc(${(box.y + box.h) * 100}% + 8px)` : `max(8px, calc(${box.y * 100}% - 44px))`, ...(box.x > .5 ? { right: `${Math.max(0, 1 - box.x - box.w) * 100}%` } : { left: `${box.x * 100}%` }) }}>
          <button type="button" className="ref-crop-insert" disabled={busy} onClick={() => { onInsertCrop(index, box); setCrop(null) }}><Plus size={14}/>Insert crop</button>
          <button type="button" onClick={() => setCrop({ index, start: null, end: null, box: null })}>Redo</button>
        </div>}
      </div>
    </section>
  }
  const pages: React.ReactNode[] = []
  for (let index = first; index <= last; index++) pages.push(page(index))

  return <aside className={`reference-panel ${dragging ? `is-${dragging === 'move' ? 'moving' : 'resizing'}` : ''}`} aria-label={`Reference: ${book.title}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onKeyDown={event => { if (NAV_KEYS.has(event.code) && !(event.target as HTMLElement).closest('input,textarea')) event.stopPropagation() }}>
    <div className="reference-header" {...dragHandlers('move')}>
      <GripHorizontal className="reference-grip" size={16} aria-hidden="true"/>
      <span className="reference-title"><strong title={book.title}>{book.title}</strong><small>{`${count} ${count === 1 ? 'page' : 'pages'}${book.indexed ? '' : ' · still indexing'}`}</small></span>
      <button type="button" aria-label="Close book" title="Close book" onClick={onClose}><X size={16}/></button>
    </div>
    <form className="reference-search" role="search" onSubmit={event => { event.preventDefault(); submit() }}>
      <Search size={14} aria-hidden="true"/>
      <input aria-label="Search this book" value={query} onChange={event => setQuery(event.target.value)} placeholder="page 22, problem 3.2, chain rule" enterKeyHint="search" autoComplete="off" spellCheck={false}/>
      <button type="submit" aria-label="Search" disabled={busy || !query.trim()}>{busy ? <LoaderCircle className="spin" size={15}/> : <CornerDownLeft size={15}/>}</button>
    </form>
    {message && <p className="reference-status" role="status">{message}</p>}
    {shownHits.length > 0 && <div className="reference-legend">
      <div className="reference-legend-top"><b>Tap the one you meant</b><button type="button" aria-label="Hide matches" onClick={() => { setDismissed(hitKey); onDismiss?.() }}><X size={13}/></button></div>
      <div className="reference-legend-list">{shownHits.map((c, n) => <button type="button" key={c.id} title={c.description} onClick={() => scrollToHit(c)}><i>{n + 1}</i><span>{candidateTitle(c, book.labels)}</span></button>)}</div>
    </div>}
    <div ref={list} className="reference-pages" onScroll={scrolled} tabIndex={0}>
      {count ? <div className="reference-spacer" style={{ height: layout.total }}>{pages}</div> : <p className="reference-empty">This book has no pages.</p>}
    </div>
    <div className="reference-resize" aria-hidden="true" {...dragHandlers('resize')}/>
  </aside>
}
