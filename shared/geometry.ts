import type { Bounds, Point } from './board'

export type GeometryKind = 'triangle' | 'right_triangle' | 'rectangle' | 'ellipse' | 'arrow' | 'polygon' | 'polyline'
export type GeometryInput = { geometry?: GeometryKind; vertices?: Point[]; angles?: number[]; sides?: number }
export type ResolvedGeometry = { geometry: GeometryKind; vertices?: Point[]; angles?: number[]; aspectRatio?: number }
export const MAX_GEOMETRY_VERTICES = 16
const EPSILON = 1e-9
const ANGLE_TOLERANCE = 0.02
const radians = (degrees: number) => degrees * Math.PI / 180
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

function signedArea(points: Point[]): number {
  return points.reduce((sum, p, i) => { const next = points[(i + 1) % points.length]; return sum + p.x * next.y - next.x * p.y }, 0) / 2
}

function extents(points: Point[]) {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
  return { x, y, w: Math.max(...points.map(p => p.x)) - x, h: Math.max(...points.map(p => p.y)) - y }
}

/** Use one coordinate scale: independent X/Y normalization would change the angles. */
function normalizeVertices(points: Point[]): Point[] {
  const box = extents(points), size = Math.max(box.w, box.h)
  if (!Number.isFinite(size) || size < EPSILON) throw new Error('The vertices must describe a shape with nonzero size.')
  return points.map(p => ({ x: (p.x - box.x) / size + (1 - box.w / size) / 2, y: (p.y - box.y) / size + (1 - box.h / size) / 2 }))
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.abs(cross(a, b, p)) <= EPSILON && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  return ((abC > EPSILON && abD < -EPSILON || abC < -EPSILON && abD > EPSILON) &&
    (cdA > EPSILON && cdB < -EPSILON || cdA < -EPSILON && cdB > EPSILON)) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
}

/** Validate explicit normalized coordinates without executing or repairing malformed geometry. */
export function validateGeometryVertices(vertices: Point[], closed = true): Point[] {
  const minimum = closed ? 3 : 2
  if (!Array.isArray(vertices) || vertices.length < minimum || vertices.length > MAX_GEOMETRY_VERTICES) throw new Error(`Use ${minimum}–${MAX_GEOMETRY_VERTICES} vertices${closed ? ' for a polygon' : ' for a polyline'}.`)
  const points = vertices.map(point => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < -EPSILON || point.x > 1 + EPSILON || point.y < -EPSILON || point.y > 1 + EPSILON) throw new Error('Vertex coordinates must be finite numbers between 0 and 1.')
    return { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }
  })
  const edgeCount = closed ? points.length : points.length - 1
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    if (distance(a, b) < 1e-6) throw new Error('Adjacent vertices must be distinct; remove repeated points.')
    for (let j = i + 1; j < edgeCount; j++) {
      if (j === i + 1 || closed && i === 0 && j === edgeCount - 1) continue
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) throw new Error('The edges intersect. List vertices in order around the outline without crossing edges.')
    }
  }
  if (closed) {
    if (Math.abs(signedArea(points)) < 1e-7) throw new Error('The polygon has no usable area. Move the vertices away from a straight line.')
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(cross(points[(i + points.length - 1) % points.length], points[i], points[(i + 1) % points.length])) < 1e-9) throw new Error('A polygon corner lies on a straight line. Remove that vertex or give it a nonzero turn.')
    }
  }
  return points
}

/** Interior angles in vertex order, including reflex corners for a simple concave polygon. */
export function polygonInteriorAngles(vertices: Point[]): number[] {
  const orientation = Math.sign(signedArea(vertices))
  return vertices.map((vertex, i) => {
    const previous = vertices[(i + vertices.length - 1) % vertices.length], next = vertices[(i + 1) % vertices.length]
    const u = { x: previous.x - vertex.x, y: previous.y - vertex.y }, v = { x: next.x - vertex.x, y: next.y - vertex.y }
    const dot = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))
    const minor = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI
    return cross(previous, vertex, next) * orientation >= 0 ? minor : 360 - minor
  })
}

function validateAngles(angles: number[], sides?: number): number[] {
  if (!Array.isArray(angles) || angles.length < 3 || angles.length > MAX_GEOMETRY_VERTICES) throw new Error(`Provide one interior angle per corner, for 3–${MAX_GEOMETRY_VERTICES} corners.`)
  if (sides !== undefined && angles.length !== sides) throw new Error(`A ${sides}-sided polygon needs ${sides} interior angles; received ${angles.length}.`)
  if (angles.some(angle => !Number.isFinite(angle) || angle < 0.1 || angle > 179.9)) throw new Error('Convex polygon angles must be between 0.1° and 179.9°. Use explicit vertices for a concave polygon.')
  const expected = (angles.length - 2) * 180, sum = angles.reduce((a, b) => a + b, 0)
  if (Math.abs(sum - expected) > 1e-6) throw new Error(`These ${angles.length} interior angles add to ${Number(sum.toFixed(6))}°; they must add to ${expected}°. Correct the angles and try again.`)
  return [...angles]
}

/**
 * Interior angles alone leave edge lengths underdetermined. Choose the convex
 * polygon tangent to a unit circle. Adjacent outward normals differ by each
 * exterior angle; intersecting their supporting lines closes all positive edges.
 */
function polygonFromAngles(angles: number[]): Point[] {
  const normals: Point[] = [{ x: 0, y: -1 }]
  let direction = -Math.PI / 2
  for (let i = 1; i < angles.length; i++) { direction += radians(180 - angles[i]); normals.push({ x: Math.cos(direction), y: Math.sin(direction) }) }
  const points = normals.map((normal, i) => {
    const previous = normals[(i + normals.length - 1) % normals.length]
    const determinant = previous.x * normal.y - normal.x * previous.y
    if (Math.abs(determinant) < 1e-10) throw new Error('These angles produce a numerically degenerate corner. Move the angles farther from 0° or 180°.')
    return { x: (normal.y - previous.y) / determinant, y: (previous.x - normal.x) / determinant }
  })
  const normalized = validateGeometryVertices(normalizeVertices(points))
  const actual = polygonInteriorAngles(normalized)
  if (actual.some((angle, i) => Math.abs(angle - angles[i]) > ANGLE_TOLERANCE)) throw new Error('These angle constraints could not be drawn accurately. Try less extreme angles or provide explicit vertices.')
  return normalized
}

export function resolveGeometry(input: GeometryInput): ResolvedGeometry {
  const geometry = input.geometry ?? (input.vertices || input.angles || input.sides !== undefined ? 'polygon' : 'triangle')
  if (!['triangle', 'right_triangle', 'rectangle', 'ellipse', 'arrow', 'polygon', 'polyline'].includes(geometry)) throw new Error('Choose a supported geometry type, polygon, or polyline.')
  if (input.sides !== undefined && (!Number.isInteger(input.sides) || input.sides < 3 || input.sides > MAX_GEOMETRY_VERTICES)) throw new Error(`A polygon must have 3–${MAX_GEOMETRY_VERTICES} sides.`)
  const namedSides = geometry === 'triangle' || geometry === 'right_triangle' ? 3 : geometry === 'rectangle' ? 4 : undefined
  if (namedSides && input.sides !== undefined && input.sides !== namedSides) throw new Error(`${geometry.replace('_', ' ')} has ${namedSides} sides. Use polygon for a different number of sides.`)
  if ((geometry === 'ellipse' || geometry === 'arrow' || geometry === 'polyline') && (input.angles || input.sides !== undefined)) throw new Error('Interior-angle constraints apply to closed polygons. Use polygon, or provide polyline vertices without interior angles.')
  if ((geometry === 'ellipse' || geometry === 'arrow') && input.vertices) throw new Error('Use polygon or polyline for explicit vertices.')
  if (geometry === 'polyline') {
    if (!input.vertices) throw new Error('A polyline needs at least two normalized vertices.')
    const vertices = validateGeometryVertices(input.vertices, false), box = extents(vertices)
    return { geometry, vertices, aspectRatio: box.h > EPSILON ? box.w / box.h : undefined }
  }
  const angles = input.angles ? validateAngles(input.angles, input.sides ?? namedSides) : undefined
  if (geometry === 'rectangle' && angles?.some(angle => Math.abs(angle - 90) > ANGLE_TOLERANCE)) throw new Error('A rectangle has four 90° angles. Use polygon for a quadrilateral with other angles.')
  if (geometry === 'right_triangle' && angles && !angles.some(angle => Math.abs(angle - 90) <= ANGLE_TOLERANCE)) throw new Error('A right triangle needs a 90° angle. Use triangle for other triangle angles.')
  let vertices = input.vertices ? validateGeometryVertices(input.vertices) : angles ? polygonFromAngles(angles) : undefined
  if (vertices && (input.sides ?? namedSides) !== undefined && vertices.length !== (input.sides ?? namedSides)) throw new Error(`The vertex count must equal the requested ${input.sides ?? namedSides} sides.`)
  if (vertices && angles) {
    if (vertices.length !== angles.length) throw new Error('Provide exactly one angle for every polygon vertex.')
    const measured = polygonInteriorAngles(vertices)
    if (measured.some((angle, i) => Math.abs(angle - angles[i]) > ANGLE_TOLERANCE)) throw new Error('The supplied vertices do not match the requested interior angles. Adjust the vertices or omit them to construct a matching polygon.')
  }
  if (!vertices && geometry === 'polygon') {
    const count = input.sides ?? 4
    vertices = normalizeVertices(Array.from({ length: count }, (_, i) => ({ x: Math.cos(-Math.PI / 2 + i * 2 * Math.PI / count), y: Math.sin(-Math.PI / 2 + i * 2 * Math.PI / count) })))
  }
  if (!vertices) return { geometry }
  const box = extents(vertices)
  return { geometry: 'polygon', vertices, ...(angles ? { angles } : {}), aspectRatio: box.w / box.h }
}

/** Uniform fitting is essential: independent stretch-to-box would falsify angle labels. */
export function fitGeometryVertices(vertices: Point[], bounds: Bounds): Point[] {
  const box = extents(vertices)
  const scale = Math.min(box.w > EPSILON ? bounds.w / box.w : Infinity, box.h > EPSILON ? bounds.h / box.h : Infinity)
  if (!Number.isFinite(scale) || scale <= 0) return vertices.map(() => ({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }))
  return vertices.map(p => ({ x: bounds.x + (bounds.w - box.w * scale) / 2 + (p.x - box.x) * scale, y: bounds.y + (bounds.h - box.h * scale) / 2 + (p.y - box.y) * scale }))
}
