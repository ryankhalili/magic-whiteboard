import type { BoardContext, BoardOperation, Bounds } from '../../shared/board'
import { freeSpots, onSheet } from '../appLogic'
import { getPlacementBounds } from '../board/controller'
import { NATURAL_SIZES } from '../board/placementSpots'

/** Manual inserts use the same free-space planner as voice, without asking a model. */
export function placeStudioOperation(operation: BoardOperation, context: BoardContext, options: {
  zoom: number
  sheet?: Bounds | null
  avoid?: readonly Bounds[]
  isBackground?: (id: string) => boolean
}): BoardOperation {
  if (operation.type !== 'create_math' && operation.type !== 'create_plot') return operation
  const kind = operation.type === 'create_math' ? 'math' : 'plot'
  const { sheet, zoom, avoid = [] } = options
  // A circled region is an explicit placement request. Keep Reference/Literal sizing
  // semantics; an ordinary object selection only guides the next free spot.
  if (operation.bounds || context.focus?.kind === 'region') {
    const bounds = getPlacementBounds(operation, context, kind)
    if (sheet && !onSheet(bounds, sheet)) throw new Error('That area extends beyond the current page. Circle an area on the page or switch to Infinite canvas.')
    return { ...operation, bounds }
  }
  const selected = context.objects.find(o => context.selectedIds.includes(o.id))
    ?? context.objects.find(o => context.lastCreatedIds.includes(o.id))
  const input = {
    viewport: context.viewport, objects: context.objects, zoom, sheet,
    size: NATURAL_SIZES[kind], workBelow: 0,
    near: context.focus?.bounds ?? selected?.bounds,
    isBackground: (id: string) => options.isBackground?.(id) === true
      || context.objects.some(o => o.id === id && o.kind === 'pdf_page' && o.locked),
  }
  // Floating controls may cover most of a small page. It is safe to reveal the
  // inserted object there, but never to escape the page or overlap its annotations.
  const bounds = freeSpots({ ...input, avoid })[0]?.bounds
    ?? (avoid.length ? freeSpots(input)[0]?.bounds : undefined)
  if (!bounds) throw new Error(sheet
    ? 'There is no free space for this on the current page. Move existing work, circle a placement area, or switch to Infinite canvas.'
    : 'No free placement area was found. Circle an area for this math.')
  return { ...operation, bounds }
}
