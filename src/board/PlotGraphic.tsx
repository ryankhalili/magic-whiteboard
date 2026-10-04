import type { MagicShape } from './MagicShape'
import { useMemo } from 'react'
import { niceTicks, samplePlot } from './expression'
import { getAxisMode, getPlotLayout } from './plotLayout'
import { ScientificGraphic } from '../math/ScientificGraphic'

function tickLabel(value: number) {
  if (value === 0) return '0'
  if (Math.abs(value) >= 10000 || Math.abs(value) < .001) return value.toExponential(1)
  return Number(value.toPrecision(4)).toString().replace('-', '−')
}

export function prettyExpression(expression: string) {
  const label = expression.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³').replace(/\*/g, '·').replace(/\bpi\b/g, 'π')
  return expression.includes('=') ? label : `y = ${label}`
}

export function PlotGraphic({ shape, hideExpression = false }: { shape: MagicShape; hideExpression?: boolean }) {
  return shape.props.visualization ? <ScientificGraphic shape={shape} hideExpression={hideExpression}/> : <CartesianGraphic shape={shape} hideExpression={hideExpression}/>
}

function CartesianGraphic({ shape, hideExpression = false }: { shape: MagicShape; hideExpression?: boolean }) {
  const p = shape.props
  const showGrid = p.showGrid !== false, showAxes = p.showAxes !== false
  const { pad, width: pw, height: ph, X, Y, range } = getPlotLayout(p, getAxisMode(shape.meta))
  const id = `clip-${shape.id.replace(/[^a-zA-Z0-9]/g, '')}`
  const { paths, error } = useMemo(() => {
    try { return { paths: samplePlot(p.expression, range.xMin, range.xMax, range.yMin, range.yMax, pw, ph), error: '' } }
    catch (e) { return { paths: [] as string[], error: (e as Error).message } }
  }, [p.expression, range.xMin, range.xMax, range.yMin, range.yMax, pw, ph])
  const xticks = niceTicks(range.xMin, range.xMax, Math.max(3, Math.floor(pw / 60)))
  const yticks = niceTicks(range.yMin, range.yMax, Math.max(3, Math.floor(ph / 40)))
  return <g>
    {p.title && <text x={pad.l} y={18} fontFamily="Arial, sans-serif" fontSize={13} fill="#111">{p.title}</text>}
    {!hideExpression && <text x={pad.l} y={p.title ? 43 : 23} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 20)} fill={p.color}>{prettyExpression(p.expression)}</text>}
    <g transform={`translate(${pad.l},${pad.t})`}>
      <defs><clipPath id={id}><rect width={pw} height={ph}/></clipPath></defs>
      {xticks.map(x => <g key={`x${x}`}>{showGrid && <path d={`M${X(x)},0 V${ph}`} stroke="#e8e8e8"/>}{showAxes && <text x={X(x)} y={ph + 22} textAnchor="middle" fontFamily="Arial, sans-serif" fontSize={11} fill="#555">{tickLabel(x)}</text>}</g>)}
      {yticks.map(y => <g key={`y${y}`}>{showGrid && <path d={`M0,${Y(y)} H${pw}`} stroke="#e8e8e8"/>}{showAxes && <text x={-12} y={Y(y) + 3} textAnchor="end" fontFamily="Arial, sans-serif" fontSize={11} fill="#555">{tickLabel(y)}</text>}</g>)}
      {showAxes && range.yMin <= 0 && range.yMax >= 0 && <path d={`M0,${Y(0)} H${pw}`} stroke="#777" strokeWidth={1}/>}
      {showAxes && range.xMin <= 0 && range.xMax >= 0 && <path d={`M${X(0)},0 V${ph}`} stroke="#777" strokeWidth={1}/>}
      <g clipPath={`url(#${id})`}>{paths.map((d, i) => <path key={i} d={d} fill="none" stroke={p.color} strokeWidth={p.strokeWidth ?? 2.6} strokeLinecap="round" strokeLinejoin="round"/>)}</g>
      {error && <g><title>{error}</title><text x={pw / 2} y={ph / 2} textAnchor="middle" fontSize={11} fill="#b05746">{error.startsWith('Every sampled point') ? 'Equation fills this view; no distinct curve' : 'Unable to display this equation'}</text></g>}
      {showAxes && <text x={pw + 8} y={ph + 21} fontFamily="Arial, sans-serif" fontSize={11} fill="#333">x</text>}
    </g>
  </g>
}
