import type { BoardContext, BoardOperation, Bounds } from '../../shared/board'
import { IMAGE_SIZES, type ImageSize } from '../../shared/image-generation'
import { findSpots, obstaclesFromObjects } from '../board/placementSpots'

export type { ImageSize } from '../../shared/image-generation'
export function validImageBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Bounds
  return [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
    && Math.abs(bounds.x) <= 1e6 && Math.abs(bounds.y) <= 1e6
    && bounds.w > 0 && bounds.h > 0 && bounds.w <= 10000 && bounds.h <= 10000
}

const AREA = { w: 560, h: 440 }

/**
 * With nothing pointed at, a free area fully in view that keeps clear of textbook pages, problems
 * and other content (a smaller one when a full size area does not fit); the one nearest the model's
 * placementOption when it chose one. null when none fits.
 */
function freeImageArea(context: BoardContext, operation: BoardOperation): Bounds | null {
  const view = context.viewport
  if (!view || ![view.x, view.y, view.w, view.h].every(Number.isFinite) || view.w <= 0 || view.h <= 0) return null
  const obstacles = obstaclesFromObjects(context.objects)
  const option = operation.placementOption ? context.placementOptions?.find(o => o.id === operation.placementOption)?.bounds : undefined
  for (const scale of [1, .75, .5]) {
    const spots = findSpots({ viewport: view, obstacles, size: { w: AREA.w * scale, h: AREA.h * scale }, max: 8 })
      .filter(spot => (spot.features.inView ?? 0) >= .999)
    const best = option ? [...spots].sort((a, b) => Math.hypot(a.bounds.x - option.x, a.bounds.y - option.y) - Math.hypot(b.bounds.x - option.x, b.bounds.y - option.y))[0] : spots[0]
    if (best) return { ...best.bounds }
  }
  return null
}

/** Capture the containing area once so format changes do not progressively shrink it. */
export function imagePlacementArea(context: BoardContext, operation: BoardOperation): Bounds {
  const literal = context.focusMode === 'literal'
  const region = literal && context.focus?.kind === 'region' ? context.focus.bounds : null
  if (literal && !region) throw new Error('Circle an area for the image, or choose Reference mode.')
  const pointer = operation.placement === 'pointer' && context.pointer
  const free = operation.bounds || region || pointer || context.focus ? null : freeImageArea(context, operation)
  const cue = pointer ? context.pointer!
    : context.focus ? { x: context.focus.bounds.x + context.focus.bounds.w / 2, y: context.focus.bounds.y + context.focus.bounds.h / 2 }
      : { x: context.viewport.x + context.viewport.w / 2, y: context.viewport.y + context.viewport.h / 2 }
  const target = operation.bounds ?? region ?? free ?? { x: cue.x - AREA.w / 2, y: cue.y - AREA.h / 2, ...AREA }
  if (!validImageBounds(target) || target.w < 48 || target.h < 48) throw new Error('Choose an image area at least 48 pixels wide and tall.')
  if (region && (target.x < region.x || target.y < region.y || target.x + target.w > region.x + region.w || target.y + target.h > region.y + region.h)) throw new Error('The image preview must stay inside the literal work area.')
  return { ...target }
}

export function fitImageInArea(target: Bounds, size: ImageSize): Bounds {
  if (!validImageBounds(target) || !IMAGE_SIZES.includes(size)) throw new Error('Choose a valid image area and format.')
  const [width, height] = size.split('x').map(Number)
  const scale = Math.min(target.w / width, target.h / height)
  return { x: target.x + (target.w - width * scale) / 2, y: target.y + (target.h - height * scale) / 2, w: width * scale, h: height * scale }
}

/** Recheck the current work-area policy at the human confirmation boundary. */
export function validateImageConfirmation(context: BoardContext, bounds: Bounds): void {
  if (!validImageBounds(bounds)) throw new Error('The image placement is no longer valid. Choose a new work area.')
  if (context.focusMode !== 'literal') return
  const region = context.focus?.kind === 'region' ? context.focus.bounds : null
  if (!region || !validImageBounds(region)) throw new Error('Circle an area for the image, or choose Reference mode before confirming.')
  const epsilon = 1e-7
  if (bounds.x < region.x - epsilon || bounds.y < region.y - epsilon
    || bounds.x + bounds.w > region.x + region.w + epsilon || bounds.y + bounds.h > region.y + region.h + epsilon) {
    throw new Error('The reviewed image must fit inside the current Literal work area. Choose Use current work area before confirming.')
  }
}

export function imagePlacement(context: BoardContext, operation: BoardOperation, size: ImageSize): Bounds {
  return fitImageInArea(imagePlacementArea(context, operation), size)
}
