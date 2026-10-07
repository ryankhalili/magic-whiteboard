import { useMemo } from 'react'
import { parse } from 'mathjs'
import katex from 'katex'
import { normalizeExpression } from '../board/expression'
import type { VisualizationSpec } from '../../shared/visualization'

/** Presentation only: keep the editable expression unchanged and never evaluate it. */
export function plotLabelLatex(expression: string, spec?: VisualizationSpec): string {
  const tex = (source: string) => {
    if (source.length > 256) throw new Error('Expression is too long.')
    return normalizeExpression(source).split('=').map(side => parse(side).toTex({ parenthesis: 'auto', implicit: 'hide' }).trim()).join(' = ')
  }
  if (spec?.type === 'phase') return `\\frac{dx}{dt} = ${tex(expression)} \\qquad \\frac{dy}{dt} = ${tex(spec.secondaryExpression ?? '')}`
  if (spec?.type === 'surface') return `z = ${tex(expression.replace(/^\s*z\s*=/, ''))}`
  if (spec?.type === 'revolution') return `r = ${tex(expression)} \\quad ${spec.sweep ?? 360}^{\\circ}\\text{ about }${spec.axis ?? 'x'}`
  return expression.includes('=') ? tex(expression) : `y = ${tex(expression)}`
}

export function PlotMathLabel({ expression, spec, x, y, width, height = 38, fontSize, color }: {
  expression: string; spec?: VisualizationSpec; x: number; y: number; width: number; height?: number; fontSize: number; color: string
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(`\\displaystyle ${plotLabelLatex(expression, spec)}`, { displayMode: false, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 })
        .replace('class="katex"', 'class="katex" style="font-size:1em"')
    } catch { return null }
  }, [expression, spec])
  // An incomplete draft must not crash or erase the graph.
  if (!html) return <text x={x} y={y + 22} fontSize={fontSize} fill={color}>{expression}</text>
  return <foreignObject x={x} y={y} width={Math.max(1, width)} height={height} pointerEvents="none">
    <div {...{ xmlns: 'http://www.w3.org/1999/xhtml' }} style={{ color, fontSize, height, display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: html }}/>
  </foreignObject>
}
