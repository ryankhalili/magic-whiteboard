import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlotMathLabel, plotLabelLatex } from '../src/math/PlotMathLabel'

describe('mathematical plot labels', () => {
  it('formats phase derivatives as fractions and separates the equations', () => {
    const latex = plotLabelLatex('y', { type: 'phase', secondaryExpression: '-x' })
    expect(latex).toContain('\\frac{dx}{dt}')
    expect(latex).toContain('\\qquad \\frac{dy}{dt}')
    const rendered = renderToStaticMarkup(createElement(PlotMathLabel, { expression: 'y', spec: { type: 'phase', secondaryExpression: '-x' }, x: 20, y: 1, width: 420, fontSize: 20, color: '#123456' }))
    expect(rendered).toContain('class="mfrac"')
    expect(rendered).toContain('http://www.w3.org/1999/xhtml')
    expect(rendered).toContain('color:#123456')
    expect(rendered).not.toContain('katex-error')
  })
  it('typesets surface roots, powers, and named functions without duplicating z', () => {
    const latex = plotLabelLatex('z=sin(sqrt(x^2+y^2))', { type: 'surface' })
    expect(latex).toContain('\\sin')
    expect(latex).toContain('\\sqrt')
    expect(latex.match(/z = /g)).toHaveLength(1)
  })
  it('keeps implicit and vertical equations intact', () => {
    expect(plotLabelLatex('x=1')).toBe('x = 1')
    expect(plotLabelLatex('x^2+y^2=9')).not.toMatch(/^y = /)
    expect(plotLabelLatex('1/(x+1)')).toContain('\\frac')
  })
  it('shows revolution sweep and axis', () => {
    expect(plotLabelLatex('sqrt(x)', { type: 'revolution', sweep: 180, axis: 'y' })).toContain('180^{\\circ}\\text{ about }y')
  })
  it('keeps incomplete drafts safe and visible as plain text', () => {
    const rendered = renderToStaticMarkup(createElement(PlotMathLabel, { expression: 'sin(', x: 0, y: 0, width: 100, fontSize: 16, color: 'black' }))
    expect(rendered).toContain('sin(')
    expect(rendered).not.toContain('foreignObject')
  })
})
