import type { Bounds, Point } from '../../shared/board'
import type { DrawProps, StrokePoint } from './types'

export class Box implements Bounds {
  constructor(public x = 0, public y = 0, public w = 0, public h = 0) {}
  get minX() { return this.x }
  get minY() { return this.y }
  get maxX() { return this.x + this.w }
  get maxY() { return this.y + this.h }
  get center() { return { x: this.x + this.w / 2, y: this.y + this.h / 2 } }
  clone() { return new Box(this.x, this.y, this.w, this.h) }
  containsPoint(p: Point, margin = 0) { return p.x >= this.x - margin && p.y >= this.y - margin && p.x <= this.maxX + margin && p.y <= this.maxY + margin }
  static From(points: Point[]) {
    if (!points.length) return new Box()
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
    for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
    return new Box(x, y, right - x, bottom - y)
  }
  static Common(boxes: Bounds[]) {
    return Box.From(boxes.flatMap(b => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]))
  }
}

/** Affine transforms use standard SVG matrix ordering. Written for this application's coordinate system. */
export class Matrix2d {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  applyToPoint(p: Point): Point { return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f } }
  clone() { return new Matrix2d(this.a, this.b, this.c, this.d, this.e, this.f) }
  multiply(right: Matrix2d) {
    const { a, b, c, d, e, f } = this
    this.a = a * right.a + c * right.b; this.b = b * right.a + d * right.b
    this.c = a * right.c + c * right.d; this.d = b * right.c + d * right.d
    this.e = a * right.e + c * right.f + e; this.f = b * right.e + d * right.f + f
    return this
  }
  invert() {
    const { a, b, c, d, e, f } = this, det = a * d - b * c
    if (Math.abs(det) < 1e-12) throw new Error('This object has an invalid transform.')
    this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det
    this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det
    return this
  }
  toCssString() { return `matrix(${this.a},${this.b},${this.c},${this.d},${this.e},${this.f})` }
  static From(x: number, y: number, rotation = 0) { return new Matrix2d(Math.cos(rotation), Math.sin(rotation), -Math.sin(rotation), Math.cos(rotation), x, y) }
}

export function transformBounds(bounds: Bounds, matrix: Matrix2d) {
  return Box.From([{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y }, { x: bounds.x, y: bounds.y + bounds.h }, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }].map(p => matrix.applyToPoint(p)))
}
export function getStrokeWidth(props: Pick<DrawProps, 'size' | 'strokeWidth'>) {
  return typeof props.strokeWidth === 'number' ? props.strokeWidth : typeof props.size === 'number' ? props.size : ({ s: 2, m: 3.5, l: 5, xl: 7 }[props.size] ?? 3.5)
}
export function colorValue(color: string) {
  return ({ black: '#202124', blue: '#2563eb', red: '#dc2626', green: '#15803d', violet: '#7c3aed', grey: '#64748b', white: '#ffffff', yellow: '#eab308', orange: '#ea580c' } as Record<string, string>)[color] ?? color
}
export function strokePoints(props: DrawProps): StrokePoint[] { return props.points?.length ? props.points : props.segments?.flatMap(s => s.points) ?? [] }
export function getStrokeRadius(props: DrawProps) {
  const pressures = strokePoints(props).map(p => Math.max(0, Math.min(1, p.pressure ?? p.z ?? .5)))
  const maximum = pressures.reduce((result, pressure) => Math.max(result, pressure), .5)
  return getStrokeWidth(props) * (.4 + maximum * 1.2) / 2
}
export function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function hitStroke(p: Point, points: StrokePoint[], tolerance: number) {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y) <= tolerance
  for (let i = 1; i < points.length; i++) if (distanceToSegment(p, points[i - 1], points[i]) <= tolerance) return true
  return false
}
