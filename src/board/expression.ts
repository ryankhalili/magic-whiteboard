import { parse, type MathNode } from 'mathjs'

const constants: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }

/** Real powers: a negative base with an odd root has a real value, so (-8)^(1/3) is -2 and x^(1/3) plots for x < 0. */
export function realPow(base: number, power: number): number {
  if (Math.abs(power) > 100) return NaN
  if (!(base < 0) || Number.isInteger(power)) return Math.pow(base, power)
  for (let q = 3; q <= 9; q += 2) {
    const p = Math.round(power * q)
    if (Math.abs(power * q - p) < 1e-9) return (p % 2 ? -1 : 1) * Math.pow(-base, power)
  }
  return NaN
}

const functions: Record<string, { min: number; max: number; fn: (...n: number[]) => number }> = {
  sin: { min: 1, max: 1, fn: Math.sin }, cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan }, asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos }, atan: { min: 1, max: 1, fn: Math.atan },
  sinh: { min: 1, max: 1, fn: Math.sinh }, cosh: { min: 1, max: 1, fn: Math.cosh },
  tanh: { min: 1, max: 1, fn: Math.tanh }, sqrt: { min: 1, max: 1, fn: Math.sqrt }, cbrt: { min: 1, max: 1, fn: Math.cbrt },
  sec: { min: 1, max: 1, fn: x => 1 / Math.cos(x) }, csc: { min: 1, max: 1, fn: x => 1 / Math.sin(x) },
  cot: { min: 1, max: 1, fn: x => Math.cos(x) / Math.sin(x) }, arcsin: { min: 1, max: 1, fn: Math.asin },
  arccos: { min: 1, max: 1, fn: Math.acos }, arctan: { min: 1, max: 1, fn: Math.atan },
  abs: { min: 1, max: 1, fn: Math.abs }, exp: { min: 1, max: 1, fn: Math.exp },
  log: { min: 1, max: 2, fn: (x, base) => base === undefined ? Math.log(x) : Math.log(x) / Math.log(base) },
  ln: { min: 1, max: 1, fn: Math.log }, log10: { min: 1, max: 1, fn: Math.log10 },
  floor: { min: 1, max: 1, fn: Math.floor }, ceil: { min: 1, max: 1, fn: Math.ceil },
  round: { min: 1, max: 1, fn: Math.round }, sign: { min: 1, max: 1, fn: Math.sign },
  min: { min: 2, max: 8, fn: Math.min }, max: { min: 2, max: 8, fn: Math.max },
  pow: { min: 2, max: 2, fn: realPow },
}

type ExpressionNode = MathNode & {
  name?: string; value?: unknown; content?: MathNode; op?: string; fn?: string | MathNode; args?: MathNode[]
}

export function normalizeExpression(expression: string): string {
  let out = expression.trim().replace(/π/g, 'pi').replace(/τ/g, 'tau')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/−/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^')
  // |x| is abs(x); inner bars pair first, so ||x|-1| becomes abs(abs(x)-1)
  for (let i = 0; i < 8 && out.includes('|'); i++) {
    const next = out.replace(/\|([^|]+)\|/g, 'abs($1)')
    if (next === out) break
    out = next
  }
  return out
}

export type ValidatedExpression = {
  expression: string
  kind: 'explicit' | 'implicit'
  /** Implicit equations are not single-valued functions; their evaluate(x) returns NaN. */
  evaluate: (x: number) => number
  /** A point is on the equation when this finite residual is zero. */
  evaluateImplicit: (x: number, y: number) => number
}

/** Interpret an allowlisted arithmetic AST, never mathjs compilation or assignment evaluation. */
export function validateExpression(source: string): ValidatedExpression {
  if (typeof source !== 'string' || source.length > 256) throw new Error('Use an equation with at most 256 characters.')
  const expression = normalizeExpression(source)
  if (!expression) throw new Error('A plot needs a function or equation, such as sin(x) or x^2+y^2=9.')
  const sides = expression.split('=')
  if (sides.length > 2 || sides.some(side => !side.trim()) || /[<>!≠≤≥]/.test(expression)) throw new Error('Use one equality, such as x=1 or x^2+y^2=9. Inequalities are not supported yet.')
  let count = 0
  let usesY = false
  type Scalar = (x: number, y: number) => number
  function build(raw: MathNode, depth = 0): Scalar {
    if (++count > 120 || depth > 24) throw new Error('That equation is too complex for a live graph.')
    const n = raw as ExpressionNode
    if (n.type === 'ConstantNode' && typeof n.value === 'number' && Number.isFinite(n.value) && Math.abs(n.value) <= 1e12) return () => n.value as number
    if (n.type === 'SymbolNode') {
      if (n.name === 'x') return x => x
      if (n.name === 'y') { usesY = true; return (_x, y) => y }
      // Conventional juxtaposition in an equality; no arbitrary variable lookup.
      if (n.name === 'xy' || n.name === 'yx') { usesY = true; return (x, y) => x * y }
      if (n.name && Object.hasOwn(constants, n.name)) return () => constants[n.name!]
      throw new Error(`Unknown variable “${n.name}”. Plots support x, y, pi, e, and tau.`)
    }
    if (n.type === 'ParenthesisNode' && n.content) return build(n.content, depth + 1)
    if (n.type === 'OperatorNode') {
      const allowed: Record<string, string> = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '^': 'pow' }
      const unary = (n.op === '+' && n.fn === 'unaryPlus') || (n.op === '-' && n.fn === 'unaryMinus')
      if ((!unary && (!n.op || allowed[n.op] !== n.fn)) || n.args?.length !== (unary ? 1 : 2)) throw new Error('Only ordinary arithmetic is supported in plots.')
      const args = n.args.map(a => build(a, depth + 1))
      if (unary) return n.op === '-' ? (x, y) => -args[0](x, y) : args[0]
      const [a, b] = args
      switch (n.op) {
        case '+': return (x, y) => a(x, y) + b(x, y)
        case '-': return (x, y) => a(x, y) - b(x, y)
        case '*': return (x, y) => a(x, y) * b(x, y)
        case '/': return (x, y) => a(x, y) / b(x, y)
        case '^': return (x, y) => realPow(a(x, y), b(x, y))
      }
    }
    if (n.type === 'FunctionNode' && typeof n.fn === 'object' && n.fn.type === 'SymbolNode') {
      const name = (n.fn as ExpressionNode).name ?? ''
      const fun = Object.hasOwn(functions, name) ? functions[name] : null
      if (!fun || !n.args || n.args.length < fun.min || n.args.length > fun.max) throw new Error(`Function “${name}” is not supported, or has the wrong number of arguments.`)
      const args = n.args.map(a => build(a, depth + 1))
      if (args.length === 1) return (x, y) => fun.fn(args[0](x, y))
      if (args.length === 2) return (x, y) => fun.fn(args[0](x, y), args[1](x, y))
      return (x, y) => fun.fn(...args.map(a => a(x, y)))
    }
    throw new Error('Use a scalar math expression. Assignments, arrays, and code are not allowed.')
  }
  const parsed = sides.map(side => {
    let node: MathNode
    try { node = parse(side) } catch { throw new Error('That equation could not be read. Try sin(x), x=1, or x^2+y^2=9.') }
    usesY = false
    const evaluate = build(node)
    return { evaluate, usesY }
  })
  const bounded = (value: number) => Number.isFinite(value) && Math.abs(value) < 1e15 ? value : NaN
  const [left, right] = parsed
  let explicit: Scalar | undefined
  if (!right) {
    if (left.usesY) throw new Error('Include an equality when using y, such as x*y=1.')
    explicit = left.evaluate
  } else if (sides[0].trim() === 'y' && !right.usesY) explicit = right.evaluate
  else if (sides[1].trim() === 'y' && !left.usesY) explicit = left.evaluate
  return {
    expression, kind: explicit ? 'explicit' : 'implicit',
    evaluate: explicit ? x => bounded(explicit(x, 0)) : () => NaN,
    evaluateImplicit: right ? (x, y) => bounded(left.evaluate(x, y) - right.evaluate(x, y)) : (x, y) => bounded(y - left.evaluate(x, y)),
  }
}

export function validateDomain(xMin: number, xMax: number, yMin?: number, yMax?: number) {
  if (![xMin, xMax].every(Number.isFinite) || Math.abs(xMin) > 1e7 || Math.abs(xMax) > 1e7 || xMax - xMin < 1e-6 || xMax - xMin > 1e7) throw new Error('The x range must increase, with finite endpoints between −10 million and 10 million.')
  if (yMin !== undefined || yMax !== undefined) {
    if (yMin === undefined || yMax === undefined || ![yMin, yMax].every(Number.isFinite) || yMax - yMin < 1e-6 || Math.max(Math.abs(yMin), Math.abs(yMax)) > 1e12) throw new Error('The y range must have two finite endpoints, with its maximum above its minimum.')
  }
}

export function autoYRange(expression: string, xMin: number, xMax: number): [number, number] {
  validateDomain(xMin, xMax)
  const { evaluate, kind } = validateExpression(expression)
  if (kind === 'implicit') return [-5, 5]
  const values = Array.from({ length: 161 }, (_, i) => evaluate(xMin + (xMax - xMin) * i / 160)).filter(Number.isFinite).sort((a, b) => a - b)
  if (!values.length) return [-5, 5]
  let lo = values[Math.floor(values.length * .025)], hi = values[Math.min(values.length - 1, Math.ceil(values.length * .975))]
  if (hi - lo < .001) { lo -= 1; hi += 1 }
  const pad = Math.max((hi - lo) * .13, .15)
  // Round outwards to readable limits instead of exposing sampling decimals.
  const rough = (hi - lo + 2 * pad) / 8, magnitude = 10 ** Math.floor(Math.log10(rough))
  const ratio = rough / magnitude, step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * magnitude
  const lower = Math.floor((lo - pad) / step) * step, upper = Math.ceil((hi + pad) / step) * step
  return [Math.max(-1e12, Number(lower.toPrecision(12))), Math.min(1e12, Number(upper.toPrecision(12)))]
}

export function niceTicks(min: number, max: number, desired = 6): number[] {
  const rough = (max - min) / desired, mag = 10 ** Math.floor(Math.log10(rough)), ratio = rough / mag
  const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-8 && ticks.length < 30; v += step) ticks.push(Math.abs(v) < step * 1e-8 ? 0 : v)
  return ticks
}

function sampleExplicitPlot(evaluate: (x: number) => number, xMin: number, xMax: number, yMin: number, yMax: number, width: number, height: number): string[] {
  const paths: string[] = []
  const samples = Math.max(160, Math.min(900, Math.ceil(width * 1.5)))
  let path = '', previousY: number | null = null, previousX = xMin
  for (let i = 0; i <= samples; i++) {
    const x = xMin + (xMax - xMin) * i / samples, y = evaluate(x)
    const px = (x - xMin) / (xMax - xMin) * width, py = (yMax - y) / (yMax - yMin) * height
    let broken = !Number.isFinite(py) || Math.abs(py) > height * 50
    if (previousY !== null && Math.abs(py - previousY) > height * .85) {
      const mid = evaluate((x + previousX) / 2)
      // Large jumps through an asymptote must never draw a spurious connecting line.
      broken ||= !Number.isFinite(mid) || Math.abs(py - previousY) > height * 2
    }
    if (broken) { if (path) paths.push(path); path = ''; previousY = null; previousX = x; continue }
    path += `${path ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)} `
    previousY = py; previousX = x
  }
  if (path) paths.push(path)
  return paths
}

type ContourPoint = { x: number; y: number }
const MAX_CONTOUR_GRID = 128
const MAX_ROOT_STEPS = 12

/** Marching squares with a fixed work ceiling and verified edge roots, in plot pixels. */
function sampleImplicitPlot(evaluate: (x: number, y: number) => number, xMin: number, xMax: number, yMin: number, yMax: number, width: number, height: number): string[] {
  const nx = Math.max(32, Math.min(MAX_CONTOUR_GRID, Math.ceil(width / 5)))
  const ny = Math.max(32, Math.min(MAX_CONTOUR_GRID, Math.ceil(height / 5)))
  const dx = (xMax - xMin) / nx, dy = (yMax - yMin) / ny
  const values = new Float64Array((nx + 1) * (ny + 1))
  const at = (i: number, j: number) => values[j * (nx + 1) + i]
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) values[j * (nx + 1) + i] = evaluate(xMin + i * dx, yMax - j * dy)
  if (values.every(value => value === 0)) throw new Error('Every sampled point satisfies this equation; there is no distinct curve in this view.')
  const horizontal: Array<ContourPoint | null | undefined> = new Array(nx * (ny + 1))
  const vertical: Array<ContourPoint | null | undefined> = new Array((nx + 1) * ny)
  const segments: string[] = []
  const zeroEdges = new Set<string>()

  function crossing(i: number, j: number, horizontalEdge: boolean): ContourPoint | null {
    const cache = horizontalEdge ? horizontal : vertical
    const key = j * (horizontalEdge ? nx : nx + 1) + i
    if (cache[key] !== undefined) return cache[key]!
    const a = at(i, j), b = at(i + (horizontalEdge ? 1 : 0), j + (horizontalEdge ? 0 : 1))
    const point = (t: number) => ({ x: (i + (horizontalEdge ? t : 0)) / nx * width, y: (j + (horizontalEdge ? 0 : t)) / ny * height })
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a >= 0) === (b >= 0)) return cache[key] = null
    if (a === 0) return cache[key] = point(0)
    if (b === 0) return cache[key] = point(1)
    let lo = 0, hi = 1, lowValue = a
    // Requiring an actual near-zero residual rejects sign changes through poles
    // (1/x=0) and discontinuous jumps. A sign change alone is not a contour.
    const tolerance = Math.max(Number.MIN_VALUE, Math.min(Math.abs(a), Math.abs(b)) * .01)
    for (let step = 0; step < MAX_ROOT_STEPS; step++) {
      const t = step === 0 ? a / (a - b) : (lo + hi) / 2
      const value = evaluate(xMin + (i + (horizontalEdge ? t : 0)) * dx, yMax - (j + (horizontalEdge ? 0 : t)) * dy)
      if (!Number.isFinite(value)) return cache[key] = null
      if (Math.abs(value) <= tolerance) return cache[key] = point(t)
      if ((value >= 0) === (lowValue >= 0)) { lo = t; lowValue = value } else hi = t
    }
    return cache[key] = null
  }

  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const corner = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
    if (!corner.every(Number.isFinite)) continue
    if (corner.every(value => value === 0)) continue // An identity is not a grid of curves.
    let hasZeroEdge = false
    for (let edge = 0; edge < 4; edge++) {
      if (corner[edge] !== 0 || corner[(edge + 1) % 4] !== 0) continue
      const horizontalEdge = edge % 2 === 0
      const ei = i + (edge === 1 ? 1 : 0), ej = j + (edge === 2 ? 1 : 0)
      if (evaluate(xMin + (ei + (horizontalEdge ? .5 : 0)) * dx, yMax - (ej + (horizontalEdge ? 0 : .5)) * dy) !== 0) continue
      hasZeroEdge = true
      const key = `${horizontalEdge ? 'h' : 'v'}${ei},${ej}`
      if (zeroEdges.has(key)) continue
      zeroEdges.add(key)
      segments.push(`M${(ei / nx * width).toFixed(2)},${(ej / ny * height).toFixed(2)}L${((ei + (horizontalEdge ? 1 : 0)) / nx * width).toFixed(2)},${((ej + (horizontalEdge ? 0 : 1)) / ny * height).toFixed(2)}`)
    }
    if (hasZeroEdge) continue
    const mask = corner.reduce((bits, value, k) => bits | (value >= 0 ? 1 << k : 0), 0)
    if (mask === 0 || mask === 15) continue
    const edges = [crossing(i, j, true), crossing(i + 1, j, false), crossing(i, j + 1, true), crossing(i, j, false)]
    const join = (a: number, b: number) => {
      const p = edges[a], q = edges[b]
      if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) < 1e-8) return
      segments.push(`M${p.x.toFixed(2)},${p.y.toFixed(2)}L${q.x.toFixed(2)},${q.y.toFixed(2)}`)
    }
    if (mask === 5 || mask === 10) {
      const center = evaluate(xMin + (i + .5) * dx, yMax - (j + .5) * dy)
      if (!Number.isFinite(center)) continue
      // Resolve saddle cells using the actual function at their center.
      if ((mask === 5) === (center >= 0)) { join(0, 1); join(2, 3) }
      else { join(3, 0); join(1, 2) }
    } else {
      const indices = edges.map((p, index) => p ? index : -1).filter(index => index !== -1)
      if (indices.length === 2) join(indices[0], indices[1])
    }
  }
  // One SVG path with disconnected subpaths avoids thousands of DOM nodes.
  return segments.length ? [segments.join(' ')] : []
}

const plotCache = new Map<string, string[]>()
export function samplePlot(expression: string, xMin: number, xMax: number, yMin: number, yMax: number, width: number, height: number): string[] {
  validateDomain(xMin, xMax, yMin, yMax)
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 1e6)) throw new Error('A plot needs finite positive dimensions.')
  const key = JSON.stringify([expression, xMin, xMax, yMin, yMax, width, height])
  const cached = plotCache.get(key)
  if (cached) { plotCache.delete(key); plotCache.set(key, cached); return [...cached] }
  const parsed = validateExpression(expression)
  const paths = parsed.kind === 'explicit'
    ? sampleExplicitPlot(parsed.evaluate, xMin, xMax, yMin, yMax, width, height)
    : sampleImplicitPlot(parsed.evaluateImplicit, xMin, xMax, yMin, yMax, width, height)
  plotCache.set(key, paths)
  if (plotCache.size > 12) plotCache.delete(plotCache.keys().next().value!)
  return [...paths]
}
