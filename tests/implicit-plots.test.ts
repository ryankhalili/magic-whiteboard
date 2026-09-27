import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { autoYRange, samplePlot, validateExpression } from '../src/board/expression'
import { getPlotLayout } from '../src/board/plotLayout'
import { PlotGraphic, prettyExpression } from '../src/board/PlotGraphic'
import type { MagicShape } from '../src/board/MagicShape'

function points(paths: string[]) {
  return [...paths.join(' ').matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
}
function sample(expression: string) { return samplePlot(expression, -5, 5, -5, 5, 400, 400) }
function world(point: { x: number; y: number }) { return { x: point.x / 40 - 5, y: 5 - point.y / 40 } }

describe('safe equations', () => {
  it('preserves full equations while retaining explicit function evaluation', () => {
    const equation = validateExpression('y = x² + 3')
    expect(equation.expression).toBe('y = x^2 + 3')
    expect(equation.kind).toBe('explicit')
    expect(equation.evaluate(2)).toBe(7)
    expect(equation.evaluateImplicit(2, 7)).toBe(0)
    expect(validateExpression('x^2 + 3 = y').evaluate(2)).toBe(7)
    expect(validateExpression('2x + sin(pi / 2)').evaluate(3)).toBeCloseTo(7)
  })
  it('interprets an equality as a residual rather than an assignment', () => {
    const vertical = validateExpression('x=1')
    expect(vertical.kind).toBe('implicit')
    expect(vertical.evaluate(1)).toBeNaN()
    expect(vertical.evaluateImplicit(1, 45)).toBe(0)
    expect(vertical.evaluateImplicit(3, 45)).toBe(2)
    expect(validateExpression('xy=1').evaluateImplicit(2, .5)).toBe(0)
    expect(validateExpression('x²+y²=9').evaluateImplicit(0, 3)).toBe(0)
    expect(autoYRange('x^2+y^2=9', -10, 10)).toEqual([-5, 5])
  })
  it.each([
    'x=y=1', 'x==1', 'x>=1', 'x≤1', 'x!=y', 'x=', '=y', 'x^2+y^2',
    'a=1', 'f(x)=x', 'x=(a=2)', 'y=(x=2)', 'y=import("fs")',
    'x=evaluate("2+2")', 'x=constructor(1)', 'x=y.constructor', 'x=[1,2]',
    'x=y; 4', 'x=random()', 'x=factorial(100000)', 'x=sum(1:1000)',
  ])('rejects unsafe or unsupported relation %s', expression => {
    expect(() => validateExpression(expression)).toThrow()
  })
  it('bounds AST size across both sides and rejects infinite arithmetic', () => {
    expect(() => validateExpression(`${Array(35).fill('x').join('+')}=${Array(35).fill('y').join('+')}`)).toThrow(/complex/)
    expect(() => validateExpression('('.repeat(25) + 'x' + ')'.repeat(25) + '=y')).toThrow(/complex/)
    expect(validateExpression('x^101=y').evaluate(2)).toBeNaN()
    expect(validateExpression('1/0=y').evaluate(2)).toBeNaN()
  })
})

describe('bounded equation contours', () => {
  it('draws a vertical line through the full plot height', () => {
    const curve = points(sample('x=1'))
    expect(curve.length).toBeGreaterThan(20)
    expect(curve.every(point => Math.abs(point.x - 240) < .01)).toBe(true)
    expect(Math.min(...curve.map(point => point.y))).toBe(0)
    expect(Math.max(...curve.map(point => point.y))).toBe(400)
  })
  it('traces both halves of a circle instead of treating it as a single function', () => {
    const curve = points(sample('x^2+y^2=9')).map(world)
    expect(curve.length).toBeGreaterThan(80)
    expect(curve.every(point => Math.abs(point.x ** 2 + point.y ** 2 - 9) < .015)).toBe(true)
    for (const quadrant of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      expect(curve.some(point => point.x * quadrant[0] > 1 && point.y * quadrant[1] > 1)).toBe(true)
    }
  })
  it('plots both hyperbola branches without joining across an asymptote', () => {
    const curve = points(sample('xy=1')).map(world)
    expect(curve.length).toBeGreaterThan(20)
    expect(curve.every(point => Math.abs(point.x * point.y - 1) < .015)).toBe(true)
    expect(curve.some(point => point.x > 0)).toBe(true)
    expect(curve.some(point => point.x < 0)).toBe(true)
    for (let i = 0; i < curve.length; i += 2) expect(curve[i].x * curve[i + 1].x).toBeGreaterThan(0)
  })
  it('preserves exact zero edges at an axes intersection without diagonal connectors', () => {
    const curve = points(sample('xy=0')).map(world)
    expect(curve.length).toBeGreaterThan(20)
    expect(curve.every(point => point.x === 0 || point.y === 0)).toBe(true)
    for (let i = 0; i < curve.length; i += 2) {
      expect((curve[i].x === 0 && curve[i + 1].x === 0) || (curve[i].y === 0 && curve[i + 1].y === 0)).toBe(true)
    }
  })
  it.each(['1/(x-.123)=0', '1e-12/(x-.123)=0', 'tan(x)=1000000000', 'floor(x)=.5', '1=2'])('does not turn discontinuities or constant relations into curves: %s', expression => {
    expect(sample(expression)).toEqual([])
  })
  it.each(['1=1', 'y=y', 'x+y=y+x'])('reports a filled sampling region rather than inventing curves for %s', expression => {
    expect(() => sample(expression)).toThrow(/Every sampled point satisfies this equation/)
  })
  it('clips invalid domains without emitting nonfinite coordinates', () => {
    const paths = sample('sqrt(x)+sqrt(y)=2')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.join('')).not.toMatch(/NaN|Infinity/)
    expect(points(paths).map(world).every(point => point.x >= 0 && point.y >= 0)).toBe(true)
    expect(() => samplePlot('x=1', 5, -5, -5, 5, 400, 400)).toThrow()
    expect(() => samplePlot('x=1', -5, 5, -5, 5, Infinity, 400)).toThrow()
  })
  it('caps sampling work independently of oversized canvas dimensions and isolates cache results', () => {
    const regular = samplePlot('x^2+y^2=9', -5, 5, -5, 5, 640, 640)
    const oversized = samplePlot('x^2+y^2=9', -5, 5, -5, 5, 1e6, 1e6)
    expect(points(oversized)).toHaveLength(points(regular).length)
    expect(oversized.length).toBe(1) // All contour segments share one SVG path.
    oversized.length = 0
    expect(samplePlot('x^2+y^2=9', -5, 5, -5, 5, 1e6, 1e6)).toHaveLength(1)
  })
  it('keeps circles circular under equal-unit layout changes', () => {
    for (const size of [{ w: 440, h: 320 }, { w: 760, h: 280 }]) {
      const layout = getPlotLayout({ ...size, xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, 'equal')
      expect(layout.X(1) - layout.X(0)).toBeCloseTo(layout.Y(0) - layout.Y(1))
      const { xMin, xMax, yMin, yMax } = layout.range
      const curve = points(samplePlot('x^2+y^2=1', xMin, xMax, yMin, yMax, layout.width, layout.height))
      const radius = layout.X(1) - layout.X(0)
      expect(curve.every(point => Math.abs(Math.hypot(point.x - layout.X(0), point.y - layout.Y(0)) - radius) < .04)).toBe(true)
    }
  })
})

describe('equation graphic', () => {
  it('labels full equations without a duplicate y= prefix', () => {
    expect(prettyExpression('x^2+y^2=9')).toBe('x²+y²=9')
    expect(prettyExpression('x=1')).toBe('x=1')
    expect(prettyExpression('y = sin(x)')).toBe('y = sin(x)')
    expect(prettyExpression('sin(x)')).toBe('y = sin(x)')
  })
  it('uses the same equation curve and visibility/style settings in SVG exports', () => {
    const shape: MagicShape = { id: 'shape:circle', typeName: 'shape', type: 'magic', x: 0, y: 0,
      rotation: 0, parentId: 'page:main', index: 1, isLocked: false, opacity: 1,
      meta: { axisMode: 'equal' }, props: {
      w: 440, h: 320, kind: 'plot', expression: 'x^2+y^2=9', title: '', color: '#123456', fontSize: 18,
      latex: '', text: '', geometry: 'triangle',
      xMin: -5, xMax: 5, yMin: -5, yMax: 5, strokeWidth: 5, showGrid: false, showAxes: false,
    } }
    const markup = renderToStaticMarkup(createElement(PlotGraphic, { shape }))
    expect(markup).toContain('x²+y²=9')
    expect(markup).toContain('stroke="#123456" stroke-width="5"')
    expect(markup).not.toContain('stroke="#e8e8e8"')
    expect(markup).not.toContain('stroke="#777"')
    expect(markup).not.toContain('y = x')
  })
})
