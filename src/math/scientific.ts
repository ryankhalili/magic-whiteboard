import type { AxisRange } from '../../shared/board'
import { visualizationSchema, type VisualizationSpec } from '../../shared/visualization'
import { niceTicks, normalizeExpression, validateDomain, validateExpression } from '../board/expression'

export type Vec3 = { x: number; y: number; z: number }
export type Mesh = { faces: Vec3[][]; bounds: { min: Vec3; max: Vec3 } }
export function scalarField(source: string) {
  const expression = normalizeExpression(source).replace(/^z\s*=\s*/, '')
  if (!expression || expression.length > 240 || expression.includes('=')) throw new Error('Use an expression in x and y, such as sin(x)*cos(y).')
  const parsed = validateExpression(`(${expression})=0`)
  return { expression, evaluate: parsed.evaluateImplicit }
}
export function validateScientific(expression: string, spec: VisualizationSpec): { expression: string; spec: VisualizationSpec } {
  const checked = visualizationSchema.parse(spec)
  if (checked.type === 'axes') {
    if ((checked.zMin ?? -10) >= (checked.zMax ?? 10)) throw new Error('Z maximum must exceed Z minimum.')
    return { expression: '0', spec: checked }
  }
  if (checked.type === 'revolution') {
    const parsed = validateExpression(expression)
    if (parsed.kind !== 'explicit') throw new Error('A revolution needs a radius function in x, such as sqrt(x).')
    return { expression: parsed.expression, spec: checked }
  }
  const primary = scalarField(expression)
  if (checked.type === 'phase') {
    if (!checked.secondaryExpression) throw new Error('Provide both dx/dt and dy/dt for a phase portrait.')
    checked.secondaryExpression = scalarField(checked.secondaryExpression).expression
  }
  return { expression: primary.expression, spec: checked }
}

/** Fixed mesh budget; omit undefined and sharply discontinuous sampled cells. */
export function scientificMesh(expression: string, spec: VisualizationSpec, range: AxisRange): Mesh {
  const checked = validateScientific(expression, spec)
  validateDomain(range.xMin, range.xMax, range.yMin, range.yMax)
  if (checked.spec.type === 'phase') throw new Error('Phase portraits use a vector field, not a surface mesh.')
  if (checked.spec.type === 'axes') return { faces: [], bounds: { min: { x: range.xMin, y: range.yMin, z: checked.spec.zMin ?? -10 }, max: { x: range.xMax, y: range.yMax, z: checked.spec.zMax ?? 10 } } }
  const evaluate = checked.spec.type === 'surface' ? scalarField(checked.expression).evaluate : validateExpression(checked.expression).evaluate
  const steps = 28, vertices: (Vec3 | null)[][] = []
  for (let i = 0; i <= steps; i++) {
    const t = range.xMin + (range.xMax - range.xMin) * i / steps
    vertices[i] = []
    for (let j = 0; j <= steps; j++) {
      let p: Vec3
      if (checked.spec.type === 'surface') {
        const y = range.yMin + (range.yMax - range.yMin) * j / steps
        p = { x: t, y, z: evaluate(t, y) }
      } else {
        const r = Math.abs(evaluate(t, 0)), theta = (checked.spec.sweep ?? 360) * Math.PI / 180 * j / steps
        p = checked.spec.axis === 'y' ? { x: r * Math.cos(theta), y: t, z: r * Math.sin(theta) }
          : { x: t, y: r * Math.cos(theta), z: r * Math.sin(theta) }
      }
      vertices[i][j] = Object.values(p).every(n => Number.isFinite(n) && Math.abs(n) <= 1e7) ? p : null
    }
  }
  const valid = vertices.flat().filter((p): p is Vec3 => p !== null)
  if (!valid.length) throw new Error('This expression has no finite surface in the selected domain.')
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const p of valid) for (const axis of ['x', 'y', 'z'] as const) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]) }
  const faces: Vec3[][] = []
  for (let i = 0; i < steps; i++) for (let j = 0; j < steps; j++) {
    const face = [vertices[i][j], vertices[i + 1][j], vertices[i + 1][j + 1], vertices[i][j + 1]]
    if (face.every((p): p is Vec3 => p !== null)) {
      if (checked.spec.type === 'surface') {
        const span = Math.max(max.z - min.z, 1e-6)
        const midpoint = evaluate((face[0].x + face[2].x) / 2, (face[0].y + face[2].y) / 2)
        if (!Number.isFinite(midpoint) || Math.abs(midpoint - face.reduce((n, p) => n + p.z, 0) / 4) > span * .5
          || face.some((p, n) => Math.abs(p.z - face[(n + 1) % 4].z) > span * .65)) continue
      } else {
        const t0 = range.xMin + (range.xMax - range.xMin) * i / steps
        const t1 = range.xMin + (range.xMax - range.xMin) * (i + 1) / steps
        const r0 = evaluate(t0, 0), r1 = evaluate(t1, 0), rm = evaluate((t0 + t1) / 2, 0)
        const span = Math.max(checked.spec.axis === 'y' ? max.x - min.x : max.y - min.y, max.z - min.z, 1e-6)
        if (!Number.isFinite(rm) || Math.abs(rm - (r0 + r1) / 2) > span * .5 || Math.abs(r0 - r1) > span * .65) continue
      }
      faces.push(face)
    }
  }
  return { faces, bounds: { min, max } }
}

// Existing stored camera angles retain their meaning; this default looks from +X,
// with +Y to the right and +Z up. Pitch is negative above the XY plane.
export const DEFAULT_VIEW_YAW = -110
export const DEFAULT_VIEW_PITCH = -28

export function meshViewBounds(mesh: Mesh) {
  const min = { ...mesh.bounds.min }, max = { ...mesh.bounds.max }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (min[axis] === max[axis]) { const padding = Math.max(1, Math.abs(min[axis]) * .1); min[axis] -= padding; max[axis] += padding }
    const step = 10 ** Math.floor(Math.log10((max[axis] - min[axis]) / 2))
    min[axis] = Math.floor(min[axis] / step) * step
    max[axis] = Math.ceil(max[axis] / step) * step
  }
  return { min, max }
}

export function meshProjection(mesh: Mesh, spec: VisualizationSpec, w: number, h: number) {
  const yaw = (spec.yaw ?? DEFAULT_VIEW_YAW) * Math.PI / 180, pitch = (spec.pitch ?? DEFAULT_VIEW_PITCH) * Math.PI / 180
  const bounds = meshViewBounds(mesh)
  const center = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 }
  const rotate = (p: Vec3) => {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z
    const u = x * Math.cos(yaw) - y * Math.sin(yaw), v = x * Math.sin(yaw) + y * Math.cos(yaw)
    return { x: u, y: v * Math.sin(pitch) - z * Math.cos(pitch), depth: -v * Math.cos(pitch) - z * Math.sin(pitch) }
  }
  const corners = [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y => [bounds.min.z, bounds.max.z].map(z => rotate({ x, y, z }))))
  const lowX = Math.min(...corners.map(p => p.x)), highX = Math.max(...corners.map(p => p.x))
  const lowY = Math.min(...corners.map(p => p.y)), highY = Math.max(...corners.map(p => p.y))
  // Fit the rotated box, using one shared scale to preserve geometric proportions.
  const scale = Math.min(Math.max(1, w - 90) / Math.max(highX - lowX, 1e-6), Math.max(1, h - 100) / Math.max(highY - lowY, 1e-6))
  return (p: Vec3) => {
    const v = rotate(p)
    return { x: w / 2 + v.x * scale, y: (h + 15) / 2 + v.y * scale, depth: v.depth }
  }
}

/** Readable ticks, bounded even for flat surfaces and near edge-on views. */
export function meshAxes(mesh: Mesh, project: ReturnType<typeof meshProjection>) {
  const { min, max } = meshViewBounds(mesh)
  // Label the front edges of the coordinate box, rather than laying numbers
  // over the surface. The ticks still show actual coordinates, not distances.
  const origin = { x: max.x, y: min.y, z: min.z }
  return (['z', 'x', 'y'] as const).map(axis => {
    const start = project({ ...origin, [axis]: min[axis] }), end = project({ ...origin, [axis]: max[axis] })
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    const values = niceTicks(min[axis], max[axis], Math.max(2, Math.min(8, Math.floor(length / 42))))
    // Avoid dropping all labels when the interval contains no nice multiple.
    const ticks: { value: number; point: ReturnType<typeof project> }[] = []
    for (const value of values.length ? values : [min[axis], max[axis]]) {
      const point = project({ ...origin, [axis]: value }), last = ticks.at(-1)
      if (!last || Math.hypot(point.x - last.point.x, point.y - last.point.y) >= 20) ticks.push({ value, point })
    }
    return { axis, start, end, ticks }
  })
}

/** Two-sided diffuse lighting; independent of mesh, grid and axis visibility. */
export function faceLight(face: Vec3[], project: ReturnType<typeof meshProjection>) {
  const a = face[0], b = face[1], c = face[2]
  if (!a || !b || !c) return .5
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
  const length = Math.hypot(n.x, n.y, n.z)
  if (length < 1e-20) return .5
  const facing = project({ x: a.x + n.x / length, y: a.y + n.y / length, z: a.z + n.z / length }).depth - project(a).depth
  const direction = facing >= 0 ? 1 : -1
  const diffuse = Math.max(0, direction * (n.x * .35 - n.y * .45 + n.z) / (length * Math.hypot(.35, -.45, 1)))
  return .28 + .6 * diffuse
}

export type PhaseField = { arrows: { x: number; y: number; dx: number; dy: number }[]; paths: { x: number; y: number }[][] }
/** RK4 with a bounded step count; stop at nonfinite fields or when leaving the view. */
export function phaseField(expression: string, spec: VisualizationSpec, range: AxisRange): PhaseField {
  const checked = validateScientific(expression, spec)
  if (checked.spec.type !== 'phase') throw new Error('Expected a phase portrait.')
  validateDomain(range.xMin, range.xMax, range.yMin, range.yMax)
  const f = scalarField(checked.expression).evaluate, g = scalarField(checked.spec.secondaryExpression!).evaluate
  const spanX = range.xMax - range.xMin, spanY = range.yMax - range.yMin
  const at = (x: number, y: number) => ({ x: f(x, y), y: g(x, y) })
  const inside = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= range.xMin && p.x <= range.xMax && p.y >= range.yMin && p.y <= range.yMax
  const arrows: PhaseField['arrows'] = []
  for (let i = 1; i < 14; i++) for (let j = 1; j < 11; j++) {
    const x = range.xMin + spanX * i / 14, y = range.yMin + spanY * j / 11, d = at(x, y)
    const n = Math.hypot(d.x / spanX, d.y / spanY)
    if (n > 1e-10 && Number.isFinite(n)) arrows.push({ x, y, dx: d.x / n * .024, dy: d.y / n * .024 })
  }
  const seeds = checked.spec.seeds ?? [{ x: .25, y: .5 }, { x: .5, y: .25 }, { x: .7, y: .7 }, { x: .8, y: .4 }].map(p => ({ x: range.xMin + p.x * spanX, y: range.yMin + p.y * spanY }))
  const paths: PhaseField['paths'] = []
  for (const seed of seeds) for (const direction of [-1, 1]) {
    let p = { ...seed }, elapsed = 0
    const path = [p], duration = checked.spec.duration ?? 8
    for (let i = 0; i < 800 && elapsed < duration && inside(p); i++) {
      const a = at(p.x, p.y), speed = Math.hypot(a.x / spanX, a.y / spanY)
      if (!Number.isFinite(speed) || speed < 1e-12) break
      const dt = Math.min(.025, .01 / speed, duration - elapsed) * direction
      const b = at(p.x + a.x * dt / 2, p.y + a.y * dt / 2), c = at(p.x + b.x * dt / 2, p.y + b.y * dt / 2), d = at(p.x + c.x * dt, p.y + c.y * dt)
      const next = { x: p.x + dt / 6 * (a.x + 2 * b.x + 2 * c.x + d.x), y: p.y + dt / 6 * (a.y + 2 * b.y + 2 * c.y + d.y) }
      if (!inside(next)) break
      p = next; path.push(p); elapsed += Math.abs(dt)
    }
    if (path.length > 1) paths.push(path)
  }
  return { arrows, paths }
}
