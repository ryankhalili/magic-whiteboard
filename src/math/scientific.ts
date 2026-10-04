import type { AxisRange } from '../../shared/board'
import { visualizationSchema, type VisualizationSpec } from '../../shared/visualization'
import { normalizeExpression, validateDomain, validateExpression } from '../board/expression'

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

export function meshProjection(mesh: Mesh, spec: VisualizationSpec, w: number, h: number) {
  const yaw = (spec.yaw ?? -35) * Math.PI / 180, pitch = (spec.pitch ?? 28) * Math.PI / 180
  const center = { x: (mesh.bounds.min.x + mesh.bounds.max.x) / 2, y: (mesh.bounds.min.y + mesh.bounds.max.y) / 2, z: (mesh.bounds.min.z + mesh.bounds.max.z) / 2 }
  const rotate = (p: Vec3) => {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z
    const u = x * Math.cos(yaw) - y * Math.sin(yaw), v = x * Math.sin(yaw) + y * Math.cos(yaw)
    return { x: u, y: v * Math.sin(pitch) - z * Math.cos(pitch), depth: v * Math.cos(pitch) + z * Math.sin(pitch) }
  }
  const corners = [mesh.bounds.min.x, mesh.bounds.max.x].flatMap(x => [mesh.bounds.min.y, mesh.bounds.max.y].flatMap(y => [mesh.bounds.min.z, mesh.bounds.max.z].map(z => rotate({ x, y, z }))))
  const lowX = Math.min(...corners.map(p => p.x)), highX = Math.max(...corners.map(p => p.x))
  const lowY = Math.min(...corners.map(p => p.y)), highY = Math.max(...corners.map(p => p.y))
  // Fit the rotated box, using one shared scale to preserve geometric proportions.
  const scale = Math.min(Math.max(1, w - 90) / Math.max(highX - lowX, 1e-6), Math.max(1, h - 100) / Math.max(highY - lowY, 1e-6))
  return (p: Vec3) => {
    const v = rotate(p)
    return { x: w / 2 + v.x * scale, y: (h + 15) / 2 + v.y * scale, depth: v.depth }
  }
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
