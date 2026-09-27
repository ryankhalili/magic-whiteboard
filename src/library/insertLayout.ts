import type { BoardContext, BoardOperation, Bounds } from '../../shared/board'
import { getPlacementBounds } from '../board/controller'
import type { MagicShapeProps } from '../board/MagicShape'
import type { BookRecord, LibraryMatch } from './types'

/** a rectangle on screen in css pixels; soft ones (where the inspector opens) are better to cover than the rest */
export type ScreenRect = { left: number; top: number; right: number; bottom: number; soft?: boolean }

/** floating ui that new board content should not land under */
export const FLOATING_UI = '.reference-panel, .object-inspector, .reopen-inspector, .history-panel, .popover, .image-generation-panel, .pair-banner, .command-dock'
export const INSPECTOR_UI = '.object-inspector, .reopen-inspector'

const finiteRect = (r: ScreenRect) => [r.left, r.top, r.right, r.bottom].every(Number.isFinite)
function overlapArea(a: ScreenRect, b: ScreenRect) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** where the object inspector opens (.object-inspector in styles.css), for new content that will be selected */
export function inspectorZone(stage: ScreenRect, windowWidth: number): ScreenRect {
  const small = windowWidth <= 760
  const right = stage.right - (small ? 10 : 18), top = stage.top + (small ? 57 : 64)
  // max-height is the board height less 210 (220 on a phone)
  return { left: right - (small ? 242 : 278), top, right, bottom: Math.max(top, top + stage.bottom - stage.top - (small ? 220 : 210)), soft: true }
}

/**
 * How far to move an item on screen so it is fully inside area and clear of the floating panels.
 * null when it already is. Items bigger than the area show their top left.
 */
export function revealShift(item: ScreenRect, area: ScreenRect, blockers: readonly ScreenRect[] = [], gap = 16): { dx: number; dy: number } | null {
  if (!finiteRect(item) || !finiteRect(area)) return null
  const w = item.right - item.left, h = item.bottom - item.top
  if (!(w > 0 && h > 0) || area.right <= area.left || area.bottom <= area.top) return null
  const solid = blockers.filter(b => finiteRect(b) && b.right > b.left && b.bottom > b.top)
  const hidden = (left: number, top: number) => {
    const at = { left, top, right: left + w, bottom: top + h }
    return w * h - overlapArea(at, area) + solid.reduce((sum, b) => sum + overlapArea(at, b) * (b.soft ? .2 : 1), 0)
  }
  if (hidden(item.left, item.top) < 1) return null
  const wide = w > area.right - area.left, tall = h > area.bottom - area.top
  const xs = wide ? [area.left, ...solid.map(b => b.right + gap)] : [item.left, area.left, area.right - w, ...solid.flatMap(b => [b.right + gap, b.left - gap - w])]
  const ys = tall ? [area.top, ...solid.map(b => b.bottom + gap)] : [item.top, area.top, area.bottom - h, ...solid.flatMap(b => [b.bottom + gap, b.top - gap - h])]
  let best = { x: item.left, y: item.top }, score = Infinity
  for (const x of xs) for (const y of ys) {
    // least hidden first, then the shortest move
    const s = hidden(x, y) * 1000 + Math.hypot(x - item.left, y - item.top)
    if (s < score) { score = s; best = { x, y } }
  }
  const dx = best.x - item.left, dy = best.y - item.top
  return Math.abs(dx) < .5 && Math.abs(dy) < .5 ? null : { dx, dy }
}

/** Reference panel buttons are explicit, like the inspector: with nothing circled they place like reference mode, even in Literal. */
export const manualOverride = (context: BoardContext): Partial<BoardContext> | null => context.focusMode === 'literal' && context.focus?.kind !== 'region' ? { focusMode: 'reference' } : null

/** smooth start and stop for camera glides */
export const easeInOut = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

const CREATE_KINDS: Partial<Record<BoardOperation['type'], MagicShapeProps['kind']>> = { create_plot: 'plot', create_math: 'math', create_text: 'text', create_geometry: 'geometry' }

/**
 * Where the board will put a create operation that comes before a library insert in the same request,
 * so the insert can keep clear of it. A missing option means A when options are offered (see getPlacementBounds).
 */
export function createBoundsFor(op: BoardOperation, context: BoardContext, priors: readonly Bounds[] = []): Bounds | null {
  const kind = CREATE_KINDS[op.type]
  if (!kind) return null
  const offered = !!context.placementOptions?.length && !context.focus
  const placed = offered && !op.bounds && !op.placementOption && op.placement !== 'pointer' ? { ...op, placementOption: 'A' as const } : op
  try { return getPlacementBounds(placed, context, kind, priors.length, priors) } catch { return null }
}

/** One insert at a time across typing, voice and the reference panel; later ones wait their turn. */
export function createInsertLock(onChange?: (held: boolean) => void) {
  let current: Promise<void> | null = null
  return {
    held: () => current !== null,
    async run<T>(task: () => Promise<T>): Promise<T> {
      while (current) await current
      let release = () => {}
      current = new Promise<void>(resolve => { release = resolve })
      onChange?.(true)
      try { return await task() }
      finally { current = null; release(); onChange?.(false) }
    },
  }
}

type Match = LibraryMatch | { error: string; books?: BookRecord[]; code?: string; bookId?: string }
/** the book to update when a lookup answered with code 'reindex' */
export function reindexTarget(match: unknown): string | null {
  const m = match as { error?: unknown; code?: unknown; bookId?: unknown } | null
  return m && typeof m.error === 'string' && m.code === 'reindex' && typeof m.bookId === 'string' && m.bookId ? m.bookId : null
}
/** runs a lookup; a book that needs a fresh index is updated once and the lookup tried again */
export async function matchWithReindex<M extends Match>(lookup: () => Promise<M>, reindex: (bookId: string) => Promise<unknown>): Promise<M | { error: string }> {
  const first = await lookup()
  const bookId = reindexTarget(first)
  if (!bookId) return first
  await reindex(bookId)
  const second = await lookup()
  return reindexTarget(second) ? { error: 'This book could not be updated. Import it again.' } : second
}
