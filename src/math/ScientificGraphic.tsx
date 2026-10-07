import { useMemo } from 'react'
import type { MagicShape } from '../board/MagicShape'
import { niceTicks } from '../board/expression'
import { getPlotLayout } from '../board/plotLayout'
import { faceLight, meshAxes, meshProjection, meshViewBounds, phaseField, scientificMesh } from './scientific'
import { PlotMathLabel } from './PlotMathLabel'

export function ScientificGraphic({ shape, hideExpression = false }: { shape: MagicShape; hideExpression?: boolean }) {
  const p = shape.props, spec = p.visualization!
  const data = useMemo(() => {
    try { return spec.type === 'phase' ? { phase: phaseField(p.expression, spec, p) } : { mesh: scientificMesh(p.expression, spec, p) } }
    catch (error) { return { error: error instanceof Error ? error.message : 'Unable to draw this visualization.' } }
  }, [p.expression, p.xMin, p.xMax, p.yMin, p.yMax, spec])
  const showNumbers = (p.showNumbers ?? p.showAxes) !== false
  const clip = `science-${shape.id.replace(/[^a-zA-Z0-9]/g, '')}`
  const layout = getPlotLayout(p, 'auto')
  const project = useMemo(() => data.mesh ? meshProjection(data.mesh, spec, p.w, p.h) : null, [data.mesh, spec, p.w, p.h])
  const faces = useMemo(() => data.mesh && project ? data.mesh.faces.map(face => ({ points: face.map(project), light: faceLight(face, project) })).sort((a, b) => a.points.reduce((n, v) => n + v.depth, 0) - b.points.reduce((n, v) => n + v.depth, 0)) : [], [data.mesh, project])
  return <g fontFamily="Arial, sans-serif">
    <defs><clipPath id={clip}><rect width={p.w} height={p.h}/></clipPath><marker id={`${clip}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10" fill={p.color}/></marker></defs>
    <g clipPath={`url(#${clip})`}>
      {!hideExpression && (p.title ? <text x={20} y={24} fontSize={p.fontSize} fill={p.color}>{p.title}</text> : <PlotMathLabel expression={p.expression} spec={spec} x={20} y={1} width={p.w - 40} fontSize={Math.min(p.fontSize, 20)} color={p.color}/>)}
      {data.error && <text x={20} y={55} fontSize={12} fill="#b91c1c">{data.error}</text>}
      {data.phase && <g transform={`translate(${layout.pad.l},${layout.pad.t})`}>
        {niceTicks(p.xMin, p.xMax).map(x => <g key={`x${x}`}>{p.showGrid !== false && <path d={`M${layout.X(x)} 0 V${layout.height}`} stroke="#e5e7eb"/>}{showNumbers && <text x={layout.X(x)} y={layout.height + 20} textAnchor="middle" fontSize={10} fill="#555">{Number(x.toPrecision(4))}</text>}</g>)}
        {niceTicks(p.yMin, p.yMax).map(y => <g key={`y${y}`}>{p.showGrid !== false && <path d={`M0 ${layout.Y(y)} H${layout.width}`} stroke="#e5e7eb"/>}{showNumbers && <text x={-10} y={layout.Y(y) + 3} textAnchor="end" fontSize={10} fill="#555">{Number(y.toPrecision(4))}</text>}</g>)}
        {p.showAxes !== false && <g stroke="#6b7280">{p.yMin <= 0 && p.yMax >= 0 && <path d={`M0 ${layout.Y(0)} H${layout.width}`}/>} {p.xMin <= 0 && p.xMax >= 0 && <path d={`M${layout.X(0)} 0 V${layout.height}`}/>}</g>}
        {data.phase.arrows.map((a, i) => <path key={i} d={`M${layout.X(a.x)} ${layout.Y(a.y)} l${a.dx / (p.xMax - p.xMin) * layout.width} ${-a.dy / (p.yMax - p.yMin) * layout.height}`} stroke={p.color} opacity={.48} markerEnd={`url(#${clip}-arrow)`}/>)}
        {data.phase.paths.map((points, i) => <path key={i} d={points.map((v, n) => `${n ? 'L' : 'M'}${layout.X(v.x).toFixed(2)} ${layout.Y(v.y).toFixed(2)}`).join(' ')} fill="none" stroke={p.color} strokeWidth={p.strokeWidth ?? 1.8}/>)}
      </g>}
      {data.mesh && project && p.showGrid !== false && <g data-plot-layer="grid" stroke="#e5e7eb" strokeWidth={.7}>
        {(() => {
          const { min, max } = meshViewBounds(data.mesh)
          const line = (a: { x: number; y: number; z: number }, b: typeof a) => { const u = project(a), v = project(b); return `M${u.x} ${u.y} L${v.x} ${v.y}` }
          return <>{niceTicks(min.x, max.x).map(x => <path key={`gx${x}`} d={line({ x, y: min.y, z: min.z }, { x, y: max.y, z: min.z })}/>)}{niceTicks(min.y, max.y).map(y => <path key={`gy${y}`} d={line({ x: min.x, y, z: min.z }, { x: max.x, y, z: min.z })}/>)}</>
        })()}
      </g>}
      {faces.map((face, i) => {
        const points = face.points.map(v => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ')
        return <g key={i} data-surface-light={face.light.toFixed(3)}><polygon points={points} fill={p.color} stroke="none"/><polygon points={points} fill="white" fillOpacity={face.light} stroke={spec.showWireframe === false ? 'none' : p.color} strokeOpacity={.35} strokeWidth={p.strokeWidth ?? .6}/></g>
      })}
      {data.mesh && project && (() => {
        const occupied: { x: number; y: number }[] = []
        return meshAxes(data.mesh, project).map(({ axis, start, end, ticks }) => {
          const length = Math.hypot(end.x - start.x, end.y - start.y) || 1
          const nx = axis === 'z' ? -1 : -(end.y - start.y) / length, ny = axis === 'z' ? 0 : (end.x - start.x) / length
          return <g key={axis} data-plot-axis={axis}>
            {p.showAxes !== false && <path data-plot-layer="axis" d={`M${start.x} ${start.y} L${end.x} ${end.y}`} stroke="#6b7280"/>}
            {showNumbers && ticks.map(({ value, point }) => {
              const label = { x: point.x + nx * 12, y: point.y + ny * 12 }
              if (occupied.some(other => Math.hypot(other.x - label.x, other.y - label.y) < 16)) return null
              occupied.push(label)
              return <g key={value} data-plot-layer="number">{p.showAxes !== false && <path d={`M${point.x - nx * 3} ${point.y - ny * 3} l${nx * 6} ${ny * 6}`} stroke="#6b7280"/>}<text x={label.x} y={label.y + 3} textAnchor={nx > .4 ? 'start' : nx < -.4 ? 'end' : 'middle'} fontSize={11} fill="#555" stroke="white" strokeWidth={3} paintOrder="stroke">{Number(value.toPrecision(4)).toString().replace('-', '−')}</text></g>
            })}
            {(p.showAxes !== false || showNumbers) && <text x={end.x + (end.x - start.x) / length * 23} y={end.y + (end.y - start.y) / length * 23 + 4} textAnchor="middle" fontStyle="italic" fontSize={13} fill="#374151" stroke="white" strokeWidth={3} paintOrder="stroke">{axis}</text>}
          </g>
        })
      })()}

    </g>
  </g>
}
