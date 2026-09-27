import { Editor, createShapeId, getStrokeWidth, strokePoints, type TLShape, type TLShapeId, type TLShapePartial } from './editor'
import { eraserProtectedIds } from './excalidrawScene'

export type Point = { x: number; y: number }
export type Rect = Point & { w: number; h: number }
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type CanvasPointer = Point & { id: number; pointerType?: string; pressure?: number; button?: number; shift?: boolean; handle?: ResizeHandle | 'rotate' }
export type SelectionFrame = Rect & { rotation: number }

export function rotatePoint(point: Point, angle: number): Point {
  const c = Math.cos(angle), s = Math.sin(angle)
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c }
}
export function framePoint(frame: SelectionFrame, point: Point): Point {
  const rotated = rotatePoint(point, frame.rotation)
  return { x: frame.x + rotated.x, y: frame.y + rotated.y }
}
export function rectangleBetween(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}
export function rectanglesOverlap(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
}
export function selectionFrame(editor: Editor, shapes = editor.getSelectedShapes().filter(shape => !shape.isLocked)): SelectionFrame | null {
  if (!shapes.length) return null
  if (shapes.length === 1) {
    const shape = shapes[0], b = editor.getShapeGeometry(shape).bounds, matrix = editor.getShapePageTransform(shape)
    const origin = matrix.applyToPoint(b), direction = matrix.applyToPoint({ x: b.x + 1, y: b.y })
    return { x: origin.x, y: origin.y, w: Math.max(1, b.w), h: Math.max(1, b.h), rotation: Math.atan2(direction.y - origin.y, direction.x - origin.x) }
  }
  const boxes = shapes.map(shape => editor.getShapePageBounds(shape)).filter((box): box is NonNullable<typeof box> => !!box)
  if (!boxes.length) return null
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y))
  return { x, y, w: Math.max(1, Math.max(...boxes.map(b => b.x + b.w)) - x), h: Math.max(1, Math.max(...boxes.map(b => b.y + b.h)) - y), rotation: 0 }
}

/** Resize in the selection's own coordinate frame; the opposite edge stays fixed. */
export function resizeFrame(frame: SelectionFrame, handle: ResizeHandle, pointer: Point, preserveAspect = false): Rect {
  const p = rotatePoint({ x: pointer.x - frame.x, y: pointer.y - frame.y }, -frame.rotation)
  const minimum = 12
  let left = 0, top = 0, right = frame.w, bottom = frame.h
  if (handle.includes('w')) left = Math.min(p.x, right - minimum)
  if (handle.includes('e')) right = Math.max(p.x, left + minimum)
  if (handle.includes('n')) top = Math.min(p.y, bottom - minimum)
  if (handle.includes('s')) bottom = Math.max(p.y, top + minimum)
  if (preserveAspect && handle.length === 2) {
    const ratio = frame.w / frame.h
    let w = right - left, h = bottom - top
    if (w / h > ratio) h = w / ratio
    else w = h * ratio
    if (handle.includes('w')) left = right - w; else right = left + w
    if (handle.includes('n')) top = bottom - h; else bottom = top + h
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

type Gesture = {
  kind: 'draw' | 'erase' | 'move' | 'marquee' | 'pan' | 'resize' | 'rotate'
  id: number; start: Point; last: Point; screen: Point; mark: string; originals: TLShape[]
  selection: TLShapeId[]; camera: { x: number; y: number; z: number }; frame: SelectionFrame | null
  handle?: ResizeHandle; drawId?: TLShapeId; shifted: boolean; moved: boolean
}
type Pinch = { distance: number; zoom: number; anchor: Point }
export type InteractionView = { marquee: Rect | null; active: string | null }

/** Original pointer state machine, independent of React and browser event timing. */
export class CanvasInteractions {
  private gesture: Gesture | null = null
  private touches = new Map<number, Point>()
  private pinch: Pinch | null = null
  private penId: number | null = null
  private spacePressed = false
  private view: InteractionView = { marquee: null, active: null }
  constructor(private editor: Editor, private changed: (view: InteractionView) => void = () => {}) {}
  getView() { return this.view }
  setSpacePressed(pressed: boolean) { this.spacePressed = pressed }
  private display(view: InteractionView) { this.view = view; this.changed(view) }
  private page(input: Point) { return this.editor.screenToPage(input) }
  private canEdit(shape: TLShape) { return !this.editor.isShapeOrAncestorLocked(shape) && shape.type !== 'group' }
  private hit(point: Point, margin = 5) {
    return this.editor.getShapeAtPoint(point, { hitInside: true, margin: margin / this.editor.getZoomLevel(), filter: shape => this.canEdit(shape) })
  }
  private captureGesture(kind: Gesture['kind'], input: CanvasPointer, originals: TLShape[] = []) {
    const point = this.page(input)
    this.gesture = {
      kind, id: input.id, start: point, last: point, screen: { x: input.x, y: input.y },
      mark: this.editor.markHistoryStoppingPoint(`Begin ${kind}`), originals: structuredClone(originals),
      selection: [...this.editor.getSelectedShapeIds()], camera: { ...this.editor.getCamera() },
      frame: selectionFrame(this.editor, originals), shifted: !!input.shift, moved: false,
    }
    this.display({ marquee: kind === 'marquee' ? { ...point, w: 0, h: 0 } : null, active: kind })
    return this.gesture
  }
  pointerDown(input: CanvasPointer): boolean {
    if (input.pointerType === 'touch') {
      if (this.penId !== null) return false
      this.touches.set(input.id, { x: input.x, y: input.y })
      if (this.touches.size >= 2) {
        this.cancelGesture()
        const [a, b] = [...this.touches.values()]
        this.pinch = { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: this.editor.getZoomLevel(), anchor: this.page({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) }
        this.display({ marquee: null, active: 'pinch' })
        return true
      }
    }
    if (input.pointerType === 'pen') {
      // A stylus takes priority over a finger/palm that touched the screen first.
      if (this.gesture && this.touches.has(this.gesture.id)) { this.cancelGesture(); this.touches.clear(); this.pinch = null }
      this.penId = input.id
    }
    if (this.gesture || (input.button ?? 0) > 1) return false
    const tool = this.editor.getCurrentToolId().split('.')[0]
    const point = this.page(input)
    if (tool === 'hand' || input.button === 1 || this.spacePressed) { this.captureGesture('pan', input); return true }
    this.editor.setEditingShape(null)
    if (tool === 'draw') {
      const gesture = this.captureGesture('draw', input)
      const style = this.editor.getStyleForNextShapes()
      const size = style.size || 'm', strokeWidth = typeof size === 'number' ? size : ({ s: 2, m: 3.5, l: 5, xl: 7 }[size as 's' | 'm' | 'l' | 'xl'] ?? 3.5)
      const pressure = this.pressure(input)
      gesture.drawId = createShapeId()
      this.editor.selectNone().createShape({ id: gesture.drawId, type: 'draw', x: point.x, y: point.y, props: { points: [{ x: 0, y: 0, pressure, z: pressure }], w: 1, h: 1, color: style.color || 'black', size, strokeWidth } })
      return true
    }
    if (tool === 'eraser') { this.captureGesture('erase', input); this.erase(point, point); return true }
    if (tool !== 'select') return false
    const selected = this.editor.getSelectedShapes().filter(shape => this.canEdit(shape))
    if (input.handle && selected.length) {
      const gesture = this.captureGesture(input.handle === 'rotate' ? 'rotate' : 'resize', input, selected)
      if (input.handle !== 'rotate') gesture.handle = input.handle
      return true
    }
    const hit = this.hit(point)
    if (hit) {
      const selectedIds = this.editor.getSelectedShapeIds()
      if (input.shift && selectedIds.includes(hit.id)) {
        this.editor.select(...selectedIds.filter(id => id !== hit.id))
        return true
      }
      if (!selectedIds.includes(hit.id)) this.editor.select(...(input.shift ? selectedIds : []), hit.id)
      this.captureGesture('move', input, this.editor.getSelectedShapes().filter(shape => this.canEdit(shape)))
    } else {
      // Capture the previous selection before replacing it for a new marquee.
      this.captureGesture('marquee', input)
      if (!input.shift) this.editor.selectNone()
    }
    return true
  }
  private pressure(input: CanvasPointer) {
    return input.pointerType === 'pen' && input.pressure && input.pressure > 0 ? Math.max(.05, Math.min(1, input.pressure)) : .5
  }
  pointerMove(input: CanvasPointer) {
    if (this.touches.has(input.id)) this.touches.set(input.id, { x: input.x, y: input.y })
    if (this.pinch && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()], viewport = this.editor.getViewportScreenBounds()
      const z = Math.max(.1, Math.min(5, this.pinch.zoom * Math.hypot(b.x - a.x, b.y - a.y) / this.pinch.distance))
      this.editor.setCamera({ x: ((a.x + b.x) / 2 - viewport.x) / z - this.pinch.anchor.x, y: ((a.y + b.y) / 2 - viewport.y) / z - this.pinch.anchor.y, z })
      return
    }
    const gesture = this.gesture
    if (!gesture || gesture.id !== input.id) return
    const point = this.page(input)
    if (Math.hypot(input.x - gesture.screen.x, input.y - gesture.screen.y) > 3) gesture.moved = true
    if (gesture.kind === 'pan') {
      this.editor.setCamera({ ...gesture.camera, x: gesture.camera.x + (input.x - gesture.screen.x) / gesture.camera.z, y: gesture.camera.y + (input.y - gesture.screen.y) / gesture.camera.z })
    } else if (gesture.kind === 'draw') {
      const shape = this.editor.getShape(gesture.drawId!)
      if (shape?.type !== 'draw') return
      const points = strokePoints(shape.props)
      const next = { x: point.x - shape.x, y: point.y - shape.y, pressure: this.pressure(input), z: this.pressure(input) }
      const last = points[points.length - 1]
      if (points.length < 20000 && Math.hypot(next.x - last.x, next.y - last.y) * this.editor.getZoomLevel() > .6) {
        this.editor.updateShape({ id: shape.id, type: shape.type, props: { points: [...points, next] } })
      }
    } else if (gesture.kind === 'erase') this.erase(gesture.last, point)
    else if (gesture.kind === 'move' && gesture.moved) {
      const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y }
      this.editor.updateShapes(gesture.originals.map(shape => {
        const inverse = this.editor.getShapeParentTransform(shape).clone().invert()
        const a = inverse.applyToPoint({ x: 0, y: 0 }), b = inverse.applyToPoint(delta)
        return { id: shape.id, type: shape.type, x: shape.x + b.x - a.x, y: shape.y + b.y - a.y }
      }))
    } else if (gesture.kind === 'marquee' && gesture.moved) {
      const rect = rectangleBetween(gesture.start, point)
      const ids = this.editor.getCurrentPageShapes().filter(shape => this.canEdit(shape) && rectanglesOverlap(rect, this.editor.getShapePageBounds(shape)!)).map(shape => shape.id)
      this.editor.select(...new Set([...(gesture.shifted ? gesture.selection : []), ...ids]))
      this.display({ marquee: rect, active: 'marquee' })
    } else if (gesture.kind === 'resize' && gesture.frame && gesture.handle) this.resize(gesture, point, !!input.shift)
    else if (gesture.kind === 'rotate' && gesture.frame) this.rotate(gesture, point, !!input.shift)
    gesture.last = point
  }
  private erase(from: Point, to: Point) {
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const steps = Math.min(100, Math.max(1, Math.ceil(length * this.editor.getZoomLevel() / 6)))
    const ids = new Set<TLShapeId>()
    for (let step = 0; step <= steps; step++) {
      const hit = this.hit({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }, 8)
      if (hit) ids.add(hit.id)
    }
    const kept = new Set(eraserProtectedIds(this.editor, [...ids]))
    this.editor.deleteShapes([...ids].filter(id => !kept.has(id)))
  }
  private resize(gesture: Gesture, point: Point, preserveAspect: boolean) {
    const frame = gesture.frame!, rect = resizeFrame(frame, gesture.handle!, point, preserveAspect)
    const sx = rect.w / frame.w, sy = rect.h / frame.h
    const updates = gesture.originals.map(shape => {
      const matrix = this.editor.getShapeParentTransform(shape)
      const originalOrigin = matrix.applyToPoint(shape)
      const local = rotatePoint({ x: originalOrigin.x - frame.x, y: originalOrigin.y - frame.y }, -frame.rotation)
      const page = framePoint(frame, { x: rect.x + local.x * sx, y: rect.y + local.y * sy })
      const origin = matrix.clone().invert().applyToPoint(page)
      const props: Record<string, unknown> = {}
      if (typeof shape.props.w === 'number') props.w = Math.max(1, shape.props.w * sx)
      if (typeof shape.props.h === 'number') props.h = Math.max(1, shape.props.h * sy)
      if (shape.type === 'draw') {
        props.points = shape.props.points.length ? shape.props.points.map(p => ({ ...p, x: p.x * sx, y: p.y * sy })) : []
        if (shape.props.segments?.length) props.segments = shape.props.segments.map(segment => ({ ...segment, points: segment.points.map(p => ({ ...p, x: p.x * sx, y: p.y * sy })) }))
        props.strokeWidth = getStrokeWidth(shape.props) * Math.sqrt(sx * sy)
      }
      return { id: shape.id, type: shape.type, x: origin.x, y: origin.y, props } as TLShapePartial
    })
    this.editor.updateShapes(updates)
  }
  private rotate(gesture: Gesture, point: Point, snap: boolean) {
    const frame = gesture.frame!, center = framePoint(frame, { x: frame.w / 2, y: frame.h / 2 })
    let delta = Math.atan2(point.y - center.y, point.x - center.x) - Math.atan2(gesture.start.y - center.y, gesture.start.x - center.x)
    if (snap) delta = Math.round(delta / (Math.PI / 12)) * Math.PI / 12
    this.editor.updateShapes(gesture.originals.map(shape => {
      const parent = this.editor.getShapeParentTransform(shape), originalOrigin = parent.applyToPoint(shape)
      const offset = rotatePoint({ x: originalOrigin.x - center.x, y: originalOrigin.y - center.y }, delta)
      const origin = parent.clone().invert().applyToPoint({ x: center.x + offset.x, y: center.y + offset.y })
      return { id: shape.id, type: shape.type, x: origin.x, y: origin.y, rotation: shape.rotation + delta }
    }))
  }
  pointerUp(input: CanvasPointer) {
    if (this.penId === input.id) this.penId = null
    this.touches.delete(input.id)
    if (this.pinch) {
      if (this.touches.size < 2) { this.pinch = null; this.display({ marquee: null, active: null }) }
      return
    }
    const gesture = this.gesture
    if (!gesture || gesture.id !== input.id) return
    this.pointerMove(input)
    this.finishGesture()
  }
  private normalizeInk(id: TLShapeId) {
    const shape = this.editor.getShape(id)
    if (shape?.type !== 'draw') return
    const points = strokePoints(shape.props)
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
    const w = Math.max(1, Math.max(...points.map(p => p.x)) - x), h = Math.max(1, Math.max(...points.map(p => p.y)) - y)
    this.editor.updateShape({ id, type: 'draw', x: shape.x + x, y: shape.y + y, props: { points: points.map(p => ({ ...p, x: p.x - x, y: p.y - y })), w, h } })
  }
  private cancelGesture() {
    const gesture = this.gesture
    this.gesture = null
    if (gesture && gesture.kind !== 'pan' && gesture.kind !== 'marquee') this.editor.bailToMark(gesture.mark)
    if (gesture?.kind === 'marquee') this.editor.select(...gesture.selection)
    this.display({ marquee: null, active: null })
  }
  private finishGesture() {
    const gesture = this.gesture
    this.gesture = null
    if (gesture?.kind === 'draw') this.normalizeInk(gesture.drawId!)
    if (gesture) this.editor.markHistoryStoppingPoint(`Finish ${gesture.kind}`)
    this.display({ marquee: null, active: null })
  }
  /** Commit the visible native gesture before voice commands or document undo run. */
  complete() {
    this.finishGesture()
    this.touches.clear(); this.pinch = null; this.penId = null; this.spacePressed = false
  }
  cancel() { this.cancelGesture(); this.touches.clear(); this.pinch = null; this.penId = null; this.spacePressed = false }
  doubleClick(input: Point) {
    if (!this.editor.getCurrentToolId().startsWith('select')) return
    const shape = this.hit(this.page(input))
    if (shape?.type === 'magic' && shape.props.kind !== 'geometry') {
      this.editor.select(shape.id).setEditingShape(shape.id)
      this.editor.markHistoryStoppingPoint('Edit content')
    }
  }
  wheel(input: Point & { deltaX: number; deltaY: number; zoom: boolean; shift?: boolean }) {
    const camera = this.editor.getCamera()
    if (input.zoom) {
      const anchor = this.page(input), viewport = this.editor.getViewportScreenBounds()
      const z = Math.max(.1, Math.min(5, camera.z * Math.exp(-input.deltaY * .006)))
      this.editor.setCamera({ x: (input.x - viewport.x) / z - anchor.x, y: (input.y - viewport.y) / z - anchor.y, z })
    } else {
      const dx = input.shift && !input.deltaX ? input.deltaY : input.deltaX, dy = input.shift && !input.deltaX ? 0 : input.deltaY
      this.editor.setCamera({ ...camera, x: camera.x - dx / camera.z, y: camera.y - dy / camera.z })
    }
  }
}
