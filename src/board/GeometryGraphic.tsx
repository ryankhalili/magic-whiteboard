import type { Point } from '../../shared/board'
import { fitGeometryVertices, resolveGeometry, type GeometryKind } from '../../shared/geometry'
import type { MagicShape } from './MagicShape'

type GeometryProps = Omit<MagicShape['props'], 'geometry'> & {
  geometry: GeometryKind; vertices?: Point[]; angles?: number[]; sides?: number;
  fill?: string; fillOpacity?: number; strokeWidth?: number;
}

function AngleMark({ previous, vertex, next, angle, color, fontSize }: { previous: Point; vertex: Point; next: Point; angle: number; color: string; fontSize: number }) {
  const a = Math.hypot(previous.x - vertex.x, previous.y - vertex.y), b = Math.hypot(next.x - vertex.x, next.y - vertex.y)
  const u = { x: (previous.x - vertex.x) / a, y: (previous.y - vertex.y) / a }, v = { x: (next.x - vertex.x) / b, y: (next.y - vertex.y) / b }
  const sum = Math.hypot(u.x + v.x, u.y + v.y) || 1
  const inward = { x: (u.x + v.x) / sum, y: (u.y + v.y) / sum }
  const radius = Math.max(3, Math.min(20, a * 0.16, b * 0.16))
  const labelDistance = Math.max(radius + fontSize * 0.85, Math.min(40, a * 0.3, b * 0.3))
  const start = { x: vertex.x + u.x * radius, y: vertex.y + u.y * radius }, end = { x: vertex.x + v.x * radius, y: vertex.y + v.y * radius }
  const right = Math.abs(angle - 90) < 0.02
  const path = right
    ? `M${start.x},${start.y} L${start.x + v.x * radius},${start.y + v.y * radius} L${end.x},${end.y}`
    : `M${start.x},${start.y} A${radius},${radius} 0 0 ${u.x * v.y - u.y * v.x > 0 ? 1 : 0} ${end.x},${end.y}`
  return <g>
    <path d={path} stroke={color} strokeWidth={1.15} fill="none" opacity={0.8}/>
    <text x={vertex.x + inward.x * labelDistance} y={vertex.y + inward.y * labelDistance} dominantBaseline="middle" textAnchor="middle" fill={color} fontFamily="Arial, sans-serif" fontSize={fontSize}>{Number(angle.toFixed(2))}°</text>
  </g>
}
export function GeometryGraphic({ shape }: { shape: MagicShape }) {
  const p = shape.props as GeometryProps, { w, h, color } = p
  const left = Math.min(24, w * .12), right = w - left, top = Math.min(25, h * .12), bottom = h - Math.min(34, h * .16)
  const candidateLabels = p.text.split(',').map(label => label.trim())
  const labelsFor = (count: number) => candidateLabels.length === count && candidateLabels.every(label => label.length > 0 && label.length <= 12)
  const hasCornerLabels = (p.geometry === 'triangle' || p.geometry === 'right_triangle') && labelsFor(3)
  const corners = hasCornerLabels ? candidateLabels : ['A', 'B', 'C']
  const fill = !p.fill || p.fill === 'none' ? 'none' : p.fill === 'solid' ? color : p.fill
  const fillOpacity = Math.max(0, Math.min(1, p.fillOpacity ?? 0.15))
  const strokeWidth = Math.max(.25, Math.min(30, p.strokeWidth ?? 2.6))
  const line = { stroke: color, strokeWidth, strokeLinejoin: 'round' as const, fill, fillOpacity }
  const label = (x: number, y: number, text: string) => <text x={x} y={y} fill={color} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 22)} textAnchor="middle">{text}</text>
  const custom = p.geometry === 'polygon' || p.geometry === 'polyline' || !!p.vertices || !!p.angles
  if (custom) {
    try {
      const resolved = resolveGeometry({ geometry: p.geometry, vertices: p.vertices, angles: p.angles, sides: p.sides })
      if (!resolved.vertices) throw new Error('No polygon vertices are available.')
      const vertices = fitGeometryVertices(resolved.vertices, { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) })
      const closed = resolved.geometry !== 'polyline', vertexLabels = labelsFor(vertices.length)
      const center = { x: vertices.reduce((sum, point) => sum + point.x, 0) / vertices.length, y: vertices.reduce((sum, point) => sum + point.y, 0) / vertices.length }
      const path = vertices.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ') + (closed ? ' Z' : '')
      return <g data-geometry={resolved.geometry}>
        <path d={path} {...line} fill={closed ? fill : 'none'} strokeLinecap="round"/>
        {resolved.angles?.map((angle, index) => <AngleMark key={`angle-${index}`} previous={vertices[(index + vertices.length - 1) % vertices.length]} vertex={vertices[index]} next={vertices[(index + 1) % vertices.length]} angle={angle} color={color} fontSize={Math.max(9, Math.min(p.fontSize * .7, 17, w / 15, h / 12))}/>)}
        {vertexLabels && vertices.map((point, index) => {
          const length = Math.hypot(point.x - center.x, point.y - center.y) || 1
          return <text key={`vertex-${index}`} x={point.x + (point.x - center.x) / length * 18} y={point.y + (point.y - center.y) / length * 18} dominantBaseline="middle" textAnchor="middle" fill={color} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 20)}>{candidateLabels[index]}</text>
        })}
        {p.text && !vertexLabels && label(center.x, center.y + 6, p.text)}
        {p.title && <text x={w / 2} y={h - 4} textAnchor="middle" fill="#64748b" fontFamily="Arial, sans-serif" fontSize={11}>{p.title}</text>}
      </g>
    } catch (error) {
      return <g><title>{error instanceof Error ? error.message : 'Invalid polygon'}</title><text x={12} y={28} fill="#b91c1c" fontFamily="Arial, sans-serif" fontSize={14}>Geometry needs valid vertices or angles.</text></g>
    }
  }
  return <g>
    {p.geometry === 'right_triangle' && <><path d={`M${left},${bottom} L${left},${top} L${right},${bottom} Z`} {...line}/><path d={`M${left},${bottom - 16} h16 v16`} fill="none" stroke={color} strokeWidth={1.5}/>{label(left - 12, top, corners[0])}{label(left, bottom + 24, corners[1])}{label(right + 6, bottom + 24, corners[2])}</>}
    {p.geometry === 'triangle' && <><path d={`M${w / 2},${top} L${right},${bottom} L${left},${bottom} Z`} {...line}/>{label(w / 2, top - 9, corners[0])}{label(left, bottom + 24, corners[1])}{label(right, bottom + 24, corners[2])}</>}
    {p.geometry === 'rectangle' && <rect x={left} y={top} width={Math.max(2, right - left)} height={Math.max(2, bottom - top)} rx={3} {...line}/>}
    {p.geometry === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={Math.max(1, w / 2 - 24)} ry={Math.max(1, h / 2 - 25)} {...line}/>}
    {p.geometry === 'arrow' && <><path d={`M${left},${h / 2} H${right}`} stroke={color} strokeWidth={strokeWidth} fill="none"/><path d={`M${right - 17},${h / 2 - 10} L${right},${h / 2} L${right - 17},${h / 2 + 10}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round"/></>}
    {p.text && !hasCornerLabels && <text x={w / 2} y={h / 2 + (p.geometry === 'arrow' ? -15 : 10)} textAnchor="middle" fill={color} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 22)}>{p.text}</text>}
    {p.title && <text x={w / 2} y={h - 4} textAnchor="middle" fill="#7b8986" fontFamily="Arial, sans-serif" fontSize={11}>{p.title}</text>}
  </g>
}
