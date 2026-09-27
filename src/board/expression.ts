import { parse, type MathNode } from 'mathjs'

const constants: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }
const functions: Record<string, { min: number; max: number; fn: (...n: number[]) => number }> = {
  sin: { min: 1, max: 1, fn: Math.sin }, cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan }, asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos }, atan: { min: 1, max: 1, fn: Math.atan },
  sinh: { min: 1, max: 1, fn: Math.sinh }, cosh: { min: 1, max: 1, fn: Math.cosh },
  tanh: { min: 1, max: 1, fn: Math.tanh }, sqrt: { min: 1, max: 1, fn: Math.sqrt },
  abs: { min: 1, max: 1, fn: Math.abs }, exp: { min: 1, max: 1, fn: Math.exp },
  log: { min: 1, max: 2, fn: (x, base) => base === undefined ? Math.log(x) : Math.log(x) / Math.log(base) },
  ln: { min: 1, max: 1, fn: Math.log }, log10: { min: 1, max: 1, fn: Math.log10 },
  floor: { min: 1, max: 1, fn: Math.floor }, ceil: { min: 1, max: 1, fn: Math.ceil },
  round: { min: 1, max: 1, fn: Math.round }, sign: { min: 1, max: 1, fn: Math.sign },
  min: { min: 2, max: 8, fn: Math.min }, max: { min: 2, max: 8, fn: Math.max },
  pow: { min: 2, max: 2, fn: (a, b) => Math.abs(b) > 100 ? NaN : Math.pow(a, b) },
}

type ExpressionNode = MathNode & {
  name?: string; value?: unknown; content?: MathNode; op?: string; fn?: string | MathNode; args?: MathNode[]
}

export function normalizeExpression(expression: string): string {
  return expression.trim().replace(/^y\s*=\s*/i, '').replace(/π/g, 'pi').replace(/τ/g, 'tau')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/−/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^')
}

/** Only scalar arithmetic in x is interpreted. No compilation, assignments, accessors, or imported functions. */
export function validateExpression(source: string): { expression: string; evaluate: (x: number) => number } {
  if (typeof source !== 'string' || source.length > 256) throw new Error('Use a function with at most 256 characters.')
  const expression = normalizeExpression(source)
  if (!expression) throw new Error('A plot needs a function, such as sin(x).')
  let node: MathNode
  try { node = parse(expression) } catch { throw new Error('That function could not be read. Try sin(x), x^2 + 3, or sqrt(x).') }
  let count = 0
  function build(raw: MathNode, depth = 0): (x: number) => number {
    if (++count > 120 || depth > 24) throw new Error('That function is too complex for a live graph.')
    const n = raw as ExpressionNode
    if (n.type === 'ConstantNode' && typeof n.value === 'number' && Number.isFinite(n.value) && Math.abs(n.value) <= 1e12) return () => n.value as number
    if (n.type === 'SymbolNode') {
      if (n.name === 'x') return x => x
      if (n.name && Object.hasOwn(constants, n.name)) return () => constants[n.name!]
      throw new Error(`Unknown variable “${n.name}”. This plot uses x, pi, and e.`)
    }
    if (n.type === 'ParenthesisNode' && n.content) return build(n.content, depth + 1)
    if (n.type === 'OperatorNode') {
      const allowed: Record<string, string> = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '^': 'pow' }
      const unary = (n.op === '+' && n.fn === 'unaryPlus') || (n.op === '-' && n.fn === 'unaryMinus')
      if ((!unary && (!n.op || allowed[n.op] !== n.fn)) || n.args?.length !== (unary ? 1 : 2)) throw new Error('Only ordinary arithmetic is supported in plots.')
      const args = n.args.map(a => build(a, depth + 1))
      return x => {
        const a = args[0](x), b = args[1]?.(x)
        if (unary) return n.op === '-' ? -a : a
        switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': return Math.abs(b) > 100 ? NaN : Math.pow(a, b); default: return NaN }
      }
    }
    if (n.type === 'FunctionNode' && typeof n.fn === 'object' && n.fn.type === 'SymbolNode') {
      const name = (n.fn as ExpressionNode).name ?? ''
      const fun = Object.hasOwn(functions, name) ? functions[name] : null
      if (!fun || !n.args || n.args.length < fun.min || n.args.length > fun.max) throw new Error(`Function “${name}” is not supported, or has the wrong number of arguments.`)
      const args = n.args.map(a => build(a, depth + 1))
      return x => fun.fn(...args.map(a => a(x)))
    }
    throw new Error('Use a scalar math expression. Assignments, arrays, and code are not allowed.')
  }
  const evaluate = build(node)
  return { expression, evaluate: x => { const y = evaluate(x); return Number.isFinite(y) && Math.abs(y) < 1e15 ? y : NaN } }
}

export function validateDomain(xMin: number, xMax: number, yMin?: number, yMax?: number) {
  if (![xMin, xMax].every(Number.isFinite) || Math.abs(xMin) > 1e7 || Math.abs(xMax) > 1e7 || xMax - xMin < 1e-6 || xMax - xMin > 1e7) throw new Error('The x range must increase, with finite endpoints between −10 million and 10 million.')
  if (yMin !== undefined || yMax !== undefined) {
    if (yMin === undefined || yMax === undefined || ![yMin, yMax].every(Number.isFinite) || yMax - yMin < 1e-6 || Math.max(Math.abs(yMin), Math.abs(yMax)) > 1e12) throw new Error('The y range must have two finite endpoints, with its maximum above its minimum.')
  }
}

export function autoYRange(expression: string, xMin: number, xMax: number): [number, number] {
  validateDomain(xMin, xMax)
  const { evaluate } = validateExpression(expression)
  const values = Array.from({ length: 161 }, (_, i) => evaluate(xMin + (xMax - xMin) * i / 160)).filter(Number.isFinite).sort((a, b) => a - b)
  if (!values.length) return [-5, 5]
  let lo = values[Math.floor(values.length * .025)], hi = values[Math.min(values.length - 1, Math.ceil(values.length * .975))]
  if (hi - lo < .001) { lo -= 1; hi += 1 }
  const pad = Math.max((hi - lo) * .13, .15)
  return [Math.max(-1e12, lo - pad), Math.min(1e12, hi + pad)]
}

export function niceTicks(min: number, max: number, desired = 6): number[] {
  const rough = (max - min) / desired, mag = 10 ** Math.floor(Math.log10(rough)), ratio = rough / mag
  const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-8 && ticks.length < 30; v += step) ticks.push(Math.abs(v) < step * 1e-8 ? 0 : v)
  return ticks
}

export function samplePlot(expression: string, xMin: number, xMax: number, yMin: number, yMax: number, width: number, height: number): string[] {
  validateDomain(xMin, xMax, yMin, yMax)
  const { evaluate } = validateExpression(expression), paths: string[] = []
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
