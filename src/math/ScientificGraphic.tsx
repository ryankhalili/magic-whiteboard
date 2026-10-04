import { useMemo } from 'react'
import type { MagicShape } from '../board/MagicShape'
import { niceTicks } from '../board/expression'
import { getPlotLayout } from '../board/plotLayout'
import { meshProjection, phaseField, scientificMesh } from './scientific'

export function ScientificGraphic({ shape, hideExpression = false }: { shape: MagicShape; hideExpression?: boolean }) {
  const p = shape.props, spec = p.visualization!
  const data = useMemo(() => {
    try { return spec.type === 'phase' ? { phase: phaseField(p.expression, spec, p) } : { mesh: scientificMesh(p.expression, spec, p) } }
    catch (error) { return { error: error instanceof Error ? error.message : 'Unable to draw this visualization.' } }
  }, [p.expression, p.xMin, p.xMax, p.yMin, p.yMax, spec])
  const clip = `science-${shape.id.replace(/[^a-zA-Z0-9]/g, '')}`
  const label = spec.type === 'surface' ? `z = ${p.expression}` : spec.type === 'revolution' ? `r = ${p.expression} · ${spec.sweep ?? 360}° about ${spec.axis ?? 'x'}` : `dx/dt = ${p.expression}   dy/dt = ${spec.secondaryExpression}`
  const layout = getPlotLayout(p, 'auto')
  const project = useMemo(() => data.mesh ? meshProjection(data.mesh, spec, p.w, p.h) : null, [data.mesh, spec, p.w, p.h])
  const faces = useMemo(() => data.mesh && project ? data.mesh.faces.map(face => face.map(project)).sort((a, b) => a.reduce((n, v) => n + v.depth, 0) - b.reduce((n, v) => n + v.depth, 0)) : [], [data.mesh, project])
  return <g fontFamily="Arial, sans-serif">
    <defs><clipPath id={clip}><rect width={p.w} height={p.h}/></clipPath><marker id={`${clip}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10" fill={p.color}/></marker></defs>
    <g clipPath={`url(#${clip})`}>
      {!hideExpression && <text x={20} y={24} fontSize={p.fontSize} fill={p.color}>{p.title || label}</text>}
      {data.error && <text x={20} y={55} fontSize={12} fill="#b91c1c">{data.error}</text>}
      {data.phase && <g transform={`translate(${layout.pad.l},${layout.pad.t})`}>
        {niceTicks(p.xMin, p.xMax).map(x => <g key={`x${x}`}>{p.showGrid !== false && <path d={`M${layout.X(x)} 0 V${layout.height}`} stroke="#e5e7eb"/>}{p.showAxes !== false && <text x={layout.X(x)} y={layout.height + 20} textAnchor="middle" fontSize={10} fill="#555">{Number(x.toPrecision(4))}</text>}</g>)}
        {niceTicks(p.yMin, p.yMax).map(y => <g key={`y${y}`}>{p.showGrid !== false && <path d={`M0 ${layout.Y(y)} H${layout.width}`} stroke="#e5e7eb"/>}{p.showAxes !== false && <text x={-10} y={layout.Y(y) + 3} textAnchor="end" fontSize={10} fill="#555">{Number(y.toPrecision(4))}</text>}</g>)}
        {p.showAxes !== false && <g stroke="#6b7280">{p.yMin <= 0 && p.yMax >= 0 && <path d={`M0 ${layout.Y(0)} H${layout.width}`}/>} {p.xMin <= 0 && p.xMax >= 0 && <path d={`M${layout.X(0)} 0 V${layout.height}`}/>}</g>}
        {data.phase.arrows.map((a, i) => <path key={i} d={`M${layout.X(a.x)} ${layout.Y(a.y)} l${a.dx / (p.xMax - p.xMin) * layout.width} ${-a.dy / (p.yMax - p.yMin) * layout.height}`} stroke={p.color} opacity={.48} markerEnd={`url(#${clip}-arrow)`}/>)}
        {data.phase.paths.map((points, i) => <path key={i} d={points.map((v, n) => `${n ? 'L' : 'M'}${layout.X(v.x).toFixed(2)} ${layout.Y(v.y).toFixed(2)}`).join(' ')} fill="none" stroke={p.color} strokeWidth={p.strokeWidth ?? 1.8}/>)}
      </g>}
      {faces.map((face, i) => <polygon key={i} points={face.map(v => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ')} fill={p.color} fillOpacity={.055} stroke={p.color} strokeOpacity={.5} strokeWidth={p.strokeWidth ?? .6}/>)}
      {data.mesh && project && p.showAxes !== false && (['x', 'y', 'z'] as const).map(axis => {
        const a = project(data.mesh!.bounds.min), b = project({ ...data.mesh!.bounds.min, [axis]: data.mesh!.bounds.max[axis] })
        return <g key={axis}><path d={`M${a.x} ${a.y} L${b.x} ${b.y}`} stroke="#6b7280"/><text x={b.x + 5} y={b.y - 5} fontSize={12} fill="#374151">{axis} {Number(data.mesh!.bounds.max[axis].toPrecision(3))}</text></g>
      })}
      {data.mesh && <text x={20} y={p.h - 10} fontSize={10} fill="#6b7280">{spec.type === 'revolution' ? 'Sampled surface of revolution' : 'Sampled surface'}</text>}
    </g>
  </g>
}
