import { Box, getStrokeRadius } from './geometry'
import type { DrawProps, StrokePoint, TLShape } from './types'

/** Separate source paths must never become one Excalidraw freedraw polyline. */
export type DisconnectedInk = TLShape<'draw'> & { props: DrawProps & { segments: NonNullable<DrawProps['segments']> } }
export function isDisconnectedInk(shape: TLShape): shape is DisconnectedInk {
  return shape.type === 'draw' && (shape.props.segments?.filter(segment => segment.points.length).length ?? 0) > 1
}

export function disconnectedInkBounds(shape: TLShape<'draw'>): Box {
  const points = shape.props.segments?.flatMap(segment => segment.points) ?? shape.props.points
  const bounds = Box.From(points), padding = getStrokeRadius({ ...shape.props, points })
  return new Box(bounds.x - padding, bounds.y - padding, Math.max(.1, bounds.w) + padding * 2, Math.max(.1, bounds.h) + padding * 2)
}

/** Resize each original path independently, retaining pressure and constant ink width. */
export function resizeDisconnectedInk(shape: DisconnectedInk, width: number, height: number, flip: readonly number[] = [1, 1]): DisconnectedInk['props'] {
  const bounds = disconnectedInkBounds(shape)
  if (Math.abs(width - bounds.w) < 1e-7 && Math.abs(height - bounds.h) < 1e-7 && flip[0] >= 0 && flip[1] >= 0) return shape.props
  const points = shape.props.segments!.flatMap(segment => segment.points)
  const padding = getStrokeRadius({ ...shape.props, points })
  const pointWidth = Math.max(.1, bounds.w - padding * 2), pointHeight = Math.max(.1, bounds.h - padding * 2)
  const nextWidth = Math.max(.1, width - padding * 2), nextHeight = Math.max(.1, height - padding * 2)
  const origin = { x: bounds.x + padding, y: bounds.y + padding }
  const transform = (point: StrokePoint): StrokePoint => {
    let x = (point.x - origin.x) / pointWidth, y = (point.y - origin.y) / pointHeight
    if (flip[0] < 0) x = 1 - x
    if (flip[1] < 0) y = 1 - y
    return { ...point, x: origin.x + x * nextWidth, y: origin.y + y * nextHeight }
  }
  const segments = shape.props.segments!.map(segment => ({ ...segment, points: segment.points.map(transform) }))
  return {
    ...shape.props, segments, points: segments.flatMap(segment => segment.points),
    ...(shape.props.w !== undefined ? { w: nextWidth + padding * 2 } : {}),
    ...(shape.props.h !== undefined ? { h: nextHeight + padding * 2 } : {}),
  }
}
