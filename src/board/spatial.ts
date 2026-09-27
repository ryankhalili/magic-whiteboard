import type { Editor, TLShape } from '../canvas/editor'
import type { Bounds } from '../../shared/board'

export function containsBounds(outer: Bounds, inner: Bounds) {
  const epsilon = 1e-6
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon &&
    inner.x + inner.w <= outer.x + outer.w + epsilon && inner.y + inner.h <= outer.y + outer.h + epsilon
}

/** Computes bounds from the candidate shape, including uncommitted transforms. */
export function shapePageBounds(editor: Editor, shape: TLShape): Bounds {
  const props = shape.props as { w?: number; h?: number }
  const box = shape.type !== 'draw' && typeof props.w === 'number' && typeof props.h === 'number'
    ? { x: 0, y: 0, w: props.w, h: props.h } : editor.getShapeGeometry(shape).bounds
  const parent = shape.parentId?.startsWith('shape:') ? editor.getShapeParentTransform(shape) : null
  const cosine = Math.cos(shape.rotation), sine = Math.sin(shape.rotation)
  const points = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => {
    const point = { x: shape.x + cosine * x - sine * y, y: shape.y + sine * x + cosine * y }
    return parent ? parent.applyToPoint(point) : point
  })
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
  return { x, y, w: Math.max(...points.map(p => p.x)) - x, h: Math.max(...points.map(p => p.y)) - y }
}
