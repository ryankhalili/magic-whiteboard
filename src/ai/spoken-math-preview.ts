import type { BoardContext, Bounds } from '../../shared/board'
import { applyLatexContentEdit } from '../board/contentEdit'
import { validateLatex } from '../board/latex'
import type { ContentPreview } from './content-preview'

const MAX_TRANSCRIPT = 1500
const MAX_TOKENS = 180
const BLANK = '\\square'
const words: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', first: '1', second: '2', third: '3', fourth: '4',
  fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  plus: '+', minus: '-', negative: '-', positive: '+', times: '*', over: '/', equals: '=', equal: '=',
  squared: 'squared', cubed: 'cubed', sine: 'sin', cosine: 'cos', tangent: 'tan', logarithm: 'log',
  arcsine: 'arcsin', arccosine: 'arccos', arctangent: 'arctan',
}
const functions = new Set(['sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'exp', 'sqrt', 'abs'])
const greek = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho', 'sigma', 'phi', 'psi', 'omega'])

/** Deliberately limited spoken vocabulary. Unknown words reject the whole draft. */
function tokenize(transcript: string): string[] | null {
  if (!transcript.trim() || transcript.length > MAX_TRANSCRIPT) return null
  let source = transcript.toLowerCase().trim()
    .replace(/[,.!?]+$/, '')
    // ASR inserts pause punctuation in ordinary dictated clauses. Preserve
    // ambiguous decimal/coordinate commas instead of silently changing meaning.
    .replace(/,\s+(?=(?:bar|from|to|of|plus|minus|equals|equal|d [a-z]|d[a-z])\b)/g, ' ')
    .replace(/^(?:(?:this|that|it)(?: now)?|now) (?:equals|is equal to)\b/, '=')
    .replace(/\b(?:the|an) integral\b/g, 'integral')
    .replace(/\b(?:raised )?to the (?:power(?: of)?|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?=\b))/g,
      phrase => /power/.test(phrase) ? '^' : `^ ${phrase.split(' ').at(-1)}`)
    .replace(/\bto (?:the )?power(?: of)?\b/g, '^')
    .replace(/\bsquare root(?: of)?\b/g, 'sqrt')
    .replace(/\bhyperbolic sine\b/g, 'sinh')
    .replace(/\bhyperbolic cosine\b/g, 'cosh')
    .replace(/\bhyperbolic tangent\b/g, 'tanh')
    .replace(/\bnatural log(?:arithm)?(?: of)?\b/g, 'ln')
    .replace(/\babsolute value(?: of)?\b/g, 'abs')
    .replace(/\bdivided by\b/g, '/')
    .replace(/\bmultiplied by\b/g, '*')
    .replace(/\bless than or equal to\b/g, '<=')
    .replace(/\bgreater than or equal to\b/g, '>=')
    .replace(/\b(?:is )?equal to\b/g, '=')
    .replace(/\bless than\b/g, '<')
    .replace(/\bgreater than\b/g, '>')
    .replace(/\b(?:open|left) (?:parenthesis|parentheses|paren|bracket)\b/g, '(')
    .replace(/\b(?:close|right) (?:parenthesis|parentheses|paren|bracket)\b/g, ')')
    .replace(/\b(?:one )?half\b/g, '( 1 / 2 )')
    .replace(/\b(?:one )?quarter\b/g, '( 1 / 4 )')
    .replace(/\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](?:one|two|three|four|five|six|seven|eight|nine)\b/g,
      phrase => String(phrase.split(/[ -]/).reduce((sum, word) => sum + Number(words[word]), 0)))
    .replace(/[−–]/g, '-').replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/∫/g, ' integral ').replace(/∞/g, ' infinity ').replace(/π/g, ' pi ')
  // Only punctuation with a defined mathematical meaning is accepted.
  if (!/^[a-z0-9\s.()+*/^_=<>-]+$/.test(source)) return null
  source = source.replace(/\b[a-z]+\b/g, word => words[word] ?? word)
    .replace(/\b(\d+) point ((?:\d\s+)*\d)\b/g, (_, whole: string, decimal: string) => `${whole}.${decimal.replace(/\s/g, '')}`)
  const tokens = source.match(/\d+(?:\.\d+)?|[a-z]+|<=|>=|[()+*/^_=<>-]/g) ?? []
  if (tokens.join('') !== source.replace(/\s/g, '') || tokens.length > MAX_TOKENS) return null
  return tokens
}

class SpokenMathParser {
  private cursor = 0
  private depth = 0
  constructor(private tokens: string[]) {}
  private peek() { return this.tokens[this.cursor] }
  private take(value: string) {
    if (this.peek() !== value) return false
    this.cursor++; return true
  }
  private differential() { return /^d[a-z]$/.test(this.peek() ?? '') || (this.peek() === 'd' && (!this.tokens[this.cursor + 1] || /^[a-z]$/.test(this.tokens[this.cursor + 1]))) }
  private atomStarts() {
    const token = this.peek()
    return !!token && (/^(?:\d+(?:\.\d+)?|[a-z])$/.test(token) || greek.has(token) || functions.has(token) || ['(', 'integral', 'infinity', 'fraction'].includes(token))
  }
  parse(integralContinuation = false): string | null {
    try {
      if (integralContinuation) this.take('of')
      // Continuations such as "plus three" and "equals zero" are useful in dictation.
      const relation = ['=', '<', '>', '<=', '>='].includes(this.peek() ?? '') ? this.tokens[this.cursor++] : ''
      let value = (relation ? this.operator(relation) + ' ' : '') + (integralContinuation && this.differential() ? '' : this.expression(integralContinuation))
      if (integralContinuation && this.differential()) value += this.readDifferential()
      return this.cursor === this.tokens.length && value ? value : null
    } catch { return null }
  }
  private operator(token: string) { return token === '<=' ? '\\le' : token === '>=' ? '\\ge' : token }
  private expression(stopDifferential = false): string {
    if (++this.depth > 20) throw new Error('Expression is too deeply nested')
    let value = this.evaluatedSum(stopDifferential)
    while (['=', '<', '>', '<=', '>='].includes(this.peek() ?? '')) {
      const operator = this.operator(this.tokens[this.cursor++])
      value += ` ${operator} ${this.evaluatedSum(stopDifferential)}`
    }
    this.depth--
    return value
  }
  private evaluatedSum(stopDifferential: boolean): string {
    const value = this.sum(stopDifferential)
    if (!this.take('bar')) return value
    // Keep the entire dictated side inside the evaluation bar, without evaluating it.
    const evaluated = `\\left.${value}\\right|`
    if (!this.take('from')) {
      if (this.peek()) throw new Error('Evaluation bar requires from')
      return evaluated
    }
    // Products admit bounds like -pi, pi/2, and 2pi; sums need spoken parentheses.
    const lower = this.product(false)
    let upper = BLANK
    if (this.take('to')) upper = this.product(false)
    else if (this.peek()) throw new Error('Evaluation bounds require to')
    return `${evaluated}_{${lower}}^{${upper}}`
  }
  private sum(stopDifferential: boolean): string {
    let value = this.product(stopDifferential)
    while (this.peek() === '+' || this.peek() === '-') {
      const operator = this.tokens[this.cursor++]
      value += ` ${operator} ${this.product(stopDifferential)}`
    }
    return value
  }
  private product(stopDifferential: boolean): string {
    let value = this.power()
    while (true) {
      if (this.take('*')) value += ` \\cdot ${this.power()}`
      else if (this.take('/')) value = `\\frac{${value}}{${this.power()}}`
      else if (this.atomStarts() && !(stopDifferential && this.differential())) {
        // Two consecutive numbers are not silently turned into multiplication.
        if (/\d$/.test(value) && /^\d/.test(this.peek())) throw new Error('Ambiguous adjacent numbers')
        value += ` ${this.power()}`
      } else break
    }
    return value
  }
  private power(): string {
    if (this.take('-')) return `-${this.power()}`
    if (this.take('+')) return `+${this.power()}`
    let value = this.atom()
    if (this.take('squared')) value = `{${value}}^{2}`
    else if (this.take('cubed')) value = `{${value}}^{3}`
    else if (this.take('^')) value = `{${value}}^{${this.power()}}`
    if (this.take('_')) value = `{${value}}_{${this.power()}}`
    return value
  }
  private atom(): string {
    const token = this.peek()
    if (!token || [')', 'of', 'from', 'to'].includes(token)) return BLANK
    this.cursor++
    if (/^\d+(?:\.\d+)?$/.test(token) || /^[a-z]$/.test(token)) return token
    if (greek.has(token)) return `\\${token}`
    if (token === 'infinity') return '\\infty'
    if (token === '(') {
      const value = this.expression()
      this.take(')') // Close unfinished dictated groups visually, never in the board source.
      return `\\left(${value}\\right)`
    }
    if (token === 'integral') return this.integral()
    if (token === 'fraction') {
      this.take('of')
      const numerator = this.power()
      if (!this.take('/')) {
        if (this.peek()) throw new Error('Fraction requires over')
        return `\\frac{${numerator}}{${BLANK}}`
      }
      return `\\frac{${numerator}}{${this.power()}}`
    }
    if (functions.has(token)) {
      this.take('of')
      const grouped = this.peek() === '('
      const argument = this.power()
      // "sin pi over two" can mean sin(pi/2) or sin(pi)/2. Let the model resolve it.
      if (!grouped && this.peek() === '/') throw new Error('Ambiguous function fraction')
      return token === 'sqrt' ? `\\sqrt{${argument}}` : token === 'abs' ? `\\left|${argument}\\right|` : `\\${token} ${argument}`
    }
    throw new Error('Unrecognized speech')
  }
  private integral(): string {
    let lower: string | undefined, upper: string | undefined
    const bounds = () => {
      lower = this.power()
      if (this.take('to')) upper = this.power()
      else if (this.peek()) throw new Error('Integral bounds require to')
      else upper = BLANK
    }
    if (this.take('from')) bounds()
    this.take('of')
    const integrand = this.peek() && this.peek() !== ')' && this.peek() !== 'from' && !this.differential() ? this.expression(true) : ''
    if (this.take('from')) {
      if (lower !== undefined) throw new Error('Duplicate bounds')
      bounds()
    }
    const differential = this.differential() ? this.readDifferential() : ''
    return `\\int${lower === undefined ? '' : `_{${lower}}^{${upper}}`}${integrand ? ` ${integrand}` : ''}${differential}`
  }
  private readDifferential(): string {
    const token = this.tokens[this.cursor++]
    const variable = token === 'd' ? this.peek() ? this.tokens[this.cursor++] : BLANK : token[1]
    return `\\,\\mathrm{d}${variable}`
  }
}

function safeBounds(bounds: Bounds): Bounds | undefined {
  return [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
    && Math.abs(bounds.x) <= 1e7 && Math.abs(bounds.y) <= 1e7 && bounds.w >= 16 && bounds.h >= 16 && bounds.w <= 10000 && bounds.h <= 10000
    ? { ...bounds } : undefined
}

/** Ephemeral rendering only. A preview is never a BoardOperation or a committed edit. */
export function generateMathTranscriptPreview(itemId: string, transcript: string, context: BoardContext): ContentPreview | null {
  if (!itemId || itemId.length > 200 || context.dictationMode === 'text') return null
  const tokens = tokenize(transcript)
  if (!tokens?.length) return null
  // Outside explicit math dictation, avoid turning isolated letters/numbers into equations.
  if (context.dictationMode !== 'math' && !tokens.some(token => functions.has(token) || ['integral', '=', '^', 'squared', 'cubed', '/', '+', '-'].includes(token))) return null
  // A newly pointed-at empty location takes precedence over a retained selection.
  const emptyFocus = context.focus && context.focus.targetIds.length === 0
  const selection = context.contentSelection
  const candidates = selection ? [selection.shapeId]
    : context.focus?.targetIds.length ? context.focus.targetIds : context.selectedIds.length ? context.selectedIds : context.lastCreatedIds
  const existing = candidates.length === 1 ? context.objects.find(object => object.id === candidates[0]) : undefined
  // An existing integral can be dictated over several turns: "integral ...", "of sin x", "dx".
  // Do not interpret a fragment as integral notation in unrelated equations or source replacements.
  const integralContinuation = context.dictationMode === 'math' && !emptyFocus && !selection && existing?.kind === 'math'
    && typeof existing.latex === 'string' && /\\int(?![a-zA-Z])/.test(existing.latex) && !/\\mathrm\s*\{d\}/.test(existing.latex)
  let value = new SpokenMathParser(tokens).parse(integralContinuation)
  if (!value) return null
  const preview: ContentPreview = { callId: `transcript:${itemId}`, operationIndex: 0, kind: 'math', field: 'latex', value, complete: false, operationType: 'create_math' }
  if (context.dictationMode === 'math' && !emptyFocus) {
    if (candidates.length > 1) return null
    if (selection && (!existing || selection.field !== 'latex' || existing.kind !== 'math')) return null
    if (existing?.kind === 'math') {
      if (existing.locked || typeof existing.latex !== 'string' || existing.latex.length > 6000) return null
      if (context.focusMode === 'literal') {
        const region = context.focus?.kind === 'region' ? safeBounds(context.focus.bounds) : undefined
        const bounds = safeBounds(existing.bounds) // Board snapshots already provide rotated page bounds.
        if (!region || !bounds || !context.focus?.targetIds.includes(existing.id)
          || bounds.x < region.x || bounds.y < region.y || bounds.x + bounds.w > region.x + region.w || bounds.y + bounds.h > region.y + region.h) return null
      }
      try {
        if (selection) {
          if (selection.coordinateSpace === 'text' && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
            if (selection.text !== undefined && existing.latex.slice(selection.start, selection.end) !== selection.text) return null
            value = applyLatexContentEdit(existing.latex, { start: selection.start, end: selection.end, replacement: value })
          } else if (selection.text) value = applyLatexContentEdit(existing.latex, { find: selection.text, replace: value })
          else return null
        } else value = applyLatexContentEdit(existing.latex, { replacement: value })
      } catch { return null }
      preview.kind = 'edit'; preview.operationType = 'edit_content'; preview.target = existing.id; preview.bounds = safeBounds(existing.bounds)
    } else if (candidates.length && !existing) return null
  }
  if (preview.operationType === 'create_math' && context.focusMode === 'literal') {
    const bounds = context.focus?.kind === 'region' ? safeBounds(context.focus.bounds) : undefined
    if (!bounds || bounds.w < 80 || bounds.h < 48) return null
    preview.bounds = bounds
  }
  try { preview.value = validateLatex(value) } catch { return null }
  return preview
}
