import type { Editor, TLShapeId } from 'tldraw'
import type { BoardContext, Bounds, Focus, Point } from '../../shared/board'

export type PointerFollow = { ids: string[]; offsets: Map<string, Point>; historyMark: string; constraint?: Bounds }

export function startPointerFollow(editor: Editor, ids: string[], pointer: Point, historyMark: string, constraint?: Bounds): PointerFollow {
  const offsets = new Map<string, Point>()
  for (const id of ids) {
    const shape = editor.getShape(id as TLShapeId)
    if (!shape || shape.isLocked) continue
    const origin = editor.getShapeParentTransform(shape).applyToPoint({ x: shape.x, y: shape.y })
    offsets.set(id, { x: origin.x - pointer.x, y: origin.y - pointer.y })
  }
  return { ids: [...offsets.keys()], offsets, historyMark, ...(constraint ? { constraint: { ...constraint } } : {}) }
}

export function movePointerFollow(editor: Editor, follower: PointerFollow, point: Point) {
  if (follower.constraint) {
    // Clamp the common pointer destination, preserving every object's relative
    // position and respecting its actual rotated page-space bounds.
    const region = follower.constraint
    let minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity
    for (const id of follower.ids) {
      const shape = editor.getShape(id as TLShapeId), offset = follower.offsets.get(id)
      if (!shape || shape.isLocked || !offset) continue
      const box = editor.getShapePageBounds(shape)
      if (!box) return false
      const origin = editor.getShapeParentTransform(shape).applyToPoint({ x: shape.x, y: shape.y })
      const left = box.x - origin.x + offset.x, top = box.y - origin.y + offset.y
      minX = Math.max(minX, region.x - left); maxX = Math.min(maxX, region.x + region.w - left - box.w)
      minY = Math.max(minY, region.y - top); maxY = Math.min(maxY, region.y + region.h - top - box.h)
    }
    if (minX > maxX + 1e-6 || minY > maxY + 1e-6) return false
    point = { x: Math.min(maxX, Math.max(minX, point.x)), y: Math.min(maxY, Math.max(minY, point.y)) }
  }
  editor.updateShapes(follower.ids.flatMap(id => {
    const shape = editor.getShape(id as TLShapeId), offset = follower.offsets.get(id)
    if (!shape || shape.isLocked || !offset) return []
    const local = editor.getPointInParentSpace(shape, { x: point.x + offset.x, y: point.y + offset.y })
    return [{ id: shape.id, type: shape.type, x: local.x, y: local.y }]
  }))
  return true
}

export function finishPointerFollow(editor: Editor, follower: PointerFollow) {
  editor.squashToMark(follower.historyMark)
  editor.markHistoryStoppingPoint('Place with pointer')
}

/** The latest gesture is usable before pen-up, including while a voice turn is ending. */
export function focusFromGesture(editor: Editor, gesture: NonNullable<BoardContext['gesture']>): Focus {
  const zoom = editor.getZoomLevel()
  const isRegion = gesture.bounds.w * zoom > 24 && gesture.bounds.h * zoom > 24
  const bounds = isRegion ? gesture.bounds : { ...gesture.start, w: 0, h: 0 }
  const targetIds = isRegion ? editor.getCurrentPageShapes().filter(shape => {
    if (shape.isLocked) return false
    const box = editor.getShapePageBounds(shape)
    return box && box.x + box.w >= bounds.x && box.x <= bounds.x + bounds.w && box.y + box.h >= bounds.y && box.y <= bounds.y + bounds.h
  }).map(shape => shape.id) : (() => {
    const hit = editor.getShapeAtPoint(gesture.start, { hitInside: true, margin: 12 / zoom, filter: shape => !shape.isLocked })
    return hit ? [hit.id] : []
  })()
  return { kind: isRegion ? 'region' : 'point', bounds, targetIds }
}
