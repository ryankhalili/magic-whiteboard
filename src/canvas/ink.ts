export type InkPoint = { x: number; y: number; pressure?: number; z?: number }
const number = (value: number) => Number(value.toFixed(3))

/** Build a filled pressure-sensitive outline from samples, without a drawing SDK. */
export function inkOutlinePath(points: readonly InkPoint[], strokeWidth: number): string {
  if (!points.length) return ''
  const width = Number.isFinite(strokeWidth) ? Math.max(.1, strokeWidth) : 3.5
  const radius = (p: InkPoint) => width * (.4 + 1.2 * Math.max(.05, Math.min(1, p.pressure ?? p.z ?? .5))) / 2
  const p = points[0], r = radius(p)
  if (points.length === 1) return `M${number(p.x - r)},${number(p.y)}a${number(r)},${number(r)} 0 1 0 ${number(r * 2)},0a${number(r)},${number(r)} 0 1 0 ${number(-r * 2)},0Z`
  const left: InkPoint[] = [], right: InkPoint[] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i], before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)]
    const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy) || 1, r = radius(point)
    left.push({ x: point.x - dy / length * r, y: point.y + dx / length * r })
    right.push({ x: point.x + dy / length * r, y: point.y - dx / length * r })
  }
  const path = (point: InkPoint) => `${number(point.x)},${number(point.y)}`
  const lastRadius = number(radius(points[points.length - 1]))
  return `M${path(left[0])}${left.slice(1).map(point => `L${path(point)}`).join('')}A${lastRadius},${lastRadius} 0 0 0 ${path(right[right.length - 1])}${right.slice(0, -1).reverse().map(point => `L${path(point)}`).join('')}A${number(r)},${number(r)} 0 0 0 ${path(left[0])}Z`
}
