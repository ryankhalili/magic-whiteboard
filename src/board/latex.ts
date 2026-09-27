import katex from 'katex'

function unescapedDollars(source: string) {
  let count = 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '$') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) count++
  }
  return count
}

/** Remove complete transport wrappers, never alter the mathematical content inside. */
export function normalizeLatexInput(source: string): string {
  if (typeof source !== 'string' || source.length > 6000) throw new Error('Keep this equation under 6,000 characters.')
  let value = source
  for (let pass = 0; pass < 4; pass++) {
    const trimmed = value.trim()
    const fenced = trimmed.match(/^```(?:latex|tex|math)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i)
    if (fenced) { value = fenced[1]; continue }
    if ((trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) || (trimmed.startsWith('\\(') && trimmed.endsWith('\\)'))) {
      value = trimmed.slice(2, -2); continue
    }
    const dollars = unescapedDollars(trimmed)
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4 && dollars === 4) { value = trimmed.slice(2, -2); continue }
    if (trimmed.startsWith('$') && trimmed.endsWith('$') && trimmed.length >= 2 && dollars === 2) { value = trimmed.slice(1, -1); continue }
    // Whitespace can be meaningful inside a selected \text{...} range.
    break
  }
  return value
}

function parseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The equation could not be parsed.'
  const reason = message.replace(/^KaTeX parse error:\s*/, '').split(/ at (?:position|end of input)/)[0].slice(0, 220)
  const command = reason.match(/Undefined control sequence:\s*(\\[a-zA-Z]+|\\.)/)?.[1]
  if (command) return `Unsupported LaTeX command ${command}. Use a supported command, or \\text{...} for literal words, and resend the complete equation.`
  if (/\\(?:left|right)/.test(reason)) return 'The LaTeX delimiters do not match. Pair every \\left with \\right, or use plain parentheses, and resend the complete equation.'
  if (/Unexpected end of input|Expected ['"]?\}|expected ['"]?\}/i.test(reason)) return 'The LaTeX group or command argument is incomplete. Supply the complete expression, such as \\frac{a}{b}; missing braces or arguments were not guessed.'
  if (reason.includes('$')) return 'Use one LaTeX math expression without mixed dollar-delimited spans. Send prose separately or use \\text{...}.'
  return `LaTeX could not be parsed: ${reason}. Resend the complete corrected equation.`
}

/** Same display-mode and safety options as the board renderer; no structural repair. */
export function validateLatex(source: string, normalize = false): string {
  if (typeof source !== 'string' || source.length > 6000) throw new Error('Keep this equation under 6,000 characters.')
  const value = normalize ? normalizeLatexInput(source) : source
  try { katex.renderToString(value, { displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 }) }
  catch (error) { throw new Error(`${parseErrorMessage(error)} The board has not changed.`) }
  return value
}

/**
 * The LaTeX to commit from the visual math editor. MathLive writes a few commands KaTeX lacks
 * (\placeholder, \doubleprime, \differentialD); when its value does not validate, the expanded
 * form with blanks and primes spelled out is used, so an edit is never lost on Done.
 */
export function mathFieldLatex(value: string, expanded: () => string): string {
  try { validateLatex(value); return value } catch { /* spell out the MathLive only commands */ }
  let out = expanded().replace(/\\placeholder(?:\[[^\]]*\])?\{\}/g, '{}').replace(/\\doubleprime(?![a-zA-Z])/g, '\\prime\\prime')
    .replace(/\\differentialD(?![a-zA-Z])/g, '\\mathrm{d}').replace(/\\exponentialE(?![a-zA-Z])/g, '\\mathrm{e}').replace(/\\imaginaryI(?![a-zA-Z])/g, '\\mathrm{i}')
  // typing f'' gives f^{\prime}^{\prime}, a double superscript KaTeX refuses
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\^\{((?:\\prime)+)\}\^\{((?:\\prime)+)\}/g, '^{$1$2}')
    if (next === out) break
    out = next
  }
  return out
}

/** A space terminates a TeX control word without adding visible mathematical spacing. */
export function needsLatexCommandSeparator(left: string, right: string): boolean {
  if (!/^[a-zA-Z]/.test(right)) return false
  const slashes = left.match(/(\\+)[a-zA-Z]+$/)?.[1]
  return !!slashes && slashes.length % 2 === 1
}
