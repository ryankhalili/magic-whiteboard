import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { bodyFontSize, detectAnchors } from '../src/library/anchors'
import { pageLines } from '../src/library/pdfjs'
import type { Anchor, TextLine } from '../src/library/types'

const book = `${process.cwd()}/.local/test-books/calculus-volume-1.pdf`
const BODY = 10 / 792

/** A line at x, y (page fractions, y is the top) with a font size in points on a letter page. */
function line(text: string, x: number, y: number, points = 10, width?: number): TextLine {
  const size = points / 792
  return { text, box: { x, y, w: width ?? Math.min(0.9 - x, text.length * 0.0085 * points / 10), h: size * 1.1 }, size }
}

function page(index: number, lines: TextLine[], exerciseMode = false, answers = 0) {
  return detectAnchors('book', { index, lines, exerciseMode, answers }, BODY)
}

const header = (text: string) => line(text, 0.1, 0.03, 7)
const footer = line('Access for free at example.org', 0.1, 0.96, 7)
const find = (anchors: Anchor[], kind: string, label: string) => anchors.find(anchor => anchor.kind === kind && anchor.label === label)

describe('bodyFontSize', () => {
  it('is the most common size weighted by text length', () => {
    const lines = [line('A Big Heading', 0.1, 0.1, 18), line('body text that goes on and on and on', 0.1, 0.2), line('more body text here too', 0.1, 0.22), line('x', 0.1, 0.3, 7)]
    expect(bodyFontSize(lines)).toBeCloseTo(10 / 792, 5)
    expect(bodyFontSize([])).toBeGreaterThan(0)
  })
})

describe('detectAnchors', () => {
  it('finds examples, checkpoints and sections, and crops an example above its solution', () => {
    const lines = [
      header('192 3 • Derivatives'),
      line('3.2 The Derivative as a Function', 0.1, 0.07, 18),
      line('EXAMPLE 3.2', 0.11, 0.12),
      line('The Slope of a Tangent Line Revisited', 0.1, 0.145),
      line('Use Equation 3.4 to find the slope of the tangent line at x = 3.', 0.1, 0.162),
      line('Solution', 0.12, 0.19),
      line('1. Let x = 3 and simplify.', 0.1, 0.21),
      line('2. Evaluate the limit.', 0.1, 0.228),
      line('After examining the table, we see a good estimate.', 0.1, 0.3),
      line('3.2 For f(x) = x squared, use a table to estimate the slope.', 0.13, 0.35),
      line('continued text of the checkpoint', 0.17, 0.366),
      line('Body text starts again at the margin.', 0.1, 0.4),
      footer,
    ]
    const { anchors, exerciseMode } = page(3, lines)
    expect(exerciseMode).toBe(false)
    expect(anchors.map(anchor => `${anchor.kind} ${anchor.label}`)).toEqual(['section 3.2', 'example 3.2', 'checkpoint 3.2'])
    const example = find(anchors, 'example', '3.2')!
    expect(example.id).toBe('book#3:example:3.2')
    expect(example.heading).toBe('EXAMPLE 3.2 The Slope of a Tangent Line Revisited')
    expect(example.box.y).toBeLessThan(0.12)
    expect(example.box.y + example.box.h).toBeLessThanOrEqual(0.19)
    expect(example.box.y + example.box.h).toBeGreaterThan(0.162 + 0.013)
    expect(example.snippet).toContain('Use Equation 3.4')
    const checkpoint = find(anchors, 'checkpoint', '3.2')!
    expect(checkpoint.box.y + checkpoint.box.h).toBeGreaterThan(0.366 + 0.013)
    expect(checkpoint.box.y + checkpoint.box.h).toBeLessThanOrEqual(0.4)
    expect(checkpoint.snippet).toContain('continued text')
    // numbered steps of a worked solution are not exercises
    expect(anchors.some(anchor => anchor.kind === 'exercise')).toBe(false)
  })

  it('turns exercise mode on at an exercises heading, carries it across pages and bounds grid cells', () => {
    const first = page(4, [
      header('3.1 • Defining the Derivative 193'),
      line('SECTION 3.1 EXERCISES', 0.15, 0.1, 14),
      line('For the following exercises, find the derivative.', 0.1, 0.13),
      line('47. f(x) = 3x', 0.1, 0.16), line('48. f(x) = x + 1', 0.4, 0.16), line('49. f(x) = 2', 0.7, 0.16),
      line('50. Explain what a derivative means in words.', 0.1, 0.2),
      footer,
    ])
    expect(first.exerciseMode).toBe(true)
    expect(first.anchors.map(anchor => anchor.label)).toEqual(['47', '48', '49', '50'])
    const cell = find(first.anchors, 'exercise', '47')!
    expect(cell.box.x + cell.box.w).toBeLessThan(0.4)
    expect(cell.box.y + cell.box.h).toBeLessThanOrEqual(0.2)
    const next = page(5, [header('194 3 • Derivatives'), line('51. Find the slope of the secant line.', 0.1, 0.08), footer], first.exerciseMode)
    expect(next.anchors.map(anchor => anchor.label)).toEqual(['51'])
    const after = page(6, [line('3.2 The Derivative as a Function', 0.1, 0.07, 18), line('1. Let f be a function.', 0.1, 0.12)], next.exerciseMode)
    expect(after.exerciseMode).toBe(false)
    expect(after.anchors.map(anchor => anchor.kind)).toEqual(['section'])
  })

  it('does not read a table of contents or a wrapped reference as checkpoints', () => {
    const toc = page(1, [
      line('Contents', 0.1, 0.07, 14),
      line('3.1 Defining the Derivative 187', 0.12, 0.1), line('3.2 The Derivative as a Function 203', 0.12, 0.116),
      line('3.3 Differentiation Rules 216', 0.12, 0.132), line('3.4 Derivatives as Rates of Change 230', 0.12, 0.148),
    ])
    expect(toc.anchors).toEqual([])
    const wrapped = page(9, [
      line('The values are listed in Table', 0.1, 0.3),
      line('1.8 shows the relationship between degrees and radians.', 0.1, 0.3147),
      line('as we saw in', 0.1, 0.5), line('Example 3.5 shows that the limit exists.', 0.1, 0.5147),
      line('EXAMPLE 3.6', 0.1, 0.6), line('Finding a Limit', 0.1, 0.62),
    ])
    expect(wrapped.anchors.map(anchor => `${anchor.kind} ${anchor.label}`)).toEqual(['example 3.6'])
  })

  it('skips answer keys until a heading as big as theirs', () => {
    const key = page(700, [line('Answer Key', 0.1, 0.07, 18), line('Chapter 1', 0.1, 0.1, 14), line('1.1 For the function the answer is 2.', 0.1, 0.14), line('EXAMPLE 1.1', 0.1, 0.2)], true)
    expect(key.anchors).toEqual([])
    expect(key.answers).toBeGreaterThan(0)
    expect(key.exerciseMode).toBe(false)
    const still = page(701, [line('Chapter 2', 0.1, 0.1, 14), line('2.3 Limits are 4.', 0.1, 0.14)], false, key.answers)
    expect(still.anchors).toEqual([])
    const out = page(702, [line('Index', 0.1, 0.07, 18), line('EXAMPLE 9.1', 0.1, 0.2)], false, still.answers)
    expect(out.answers).toBe(0)
    expect(out.anchors.map(anchor => anchor.label)).toEqual(['9.1'])
  })

  it('keeps boxes inside their column on a two column page', () => {
    const left = Array.from({ length: 8 }, (_, i) => line(`left column body text line number ${i}`, 0.08, 0.3 + i * 0.02, 10, 0.36))
    const right = Array.from({ length: 8 }, (_, i) => line(`right column body text line number ${i}`, 0.53, 0.3 + i * 0.02, 10, 0.36))
    const { anchors } = page(10, [line('EXAMPLE 2.1', 0.08, 0.25), line('EXAMPLE 2.2', 0.53, 0.25), ...left, ...right])
    const a = find(anchors, 'example', '2.1')!, b = find(anchors, 'example', '2.2')!
    expect(a.box.x + a.box.w).toBeLessThan(0.53)
    expect(b.box.x).toBeGreaterThan(0.45)
    expect(a.snippet).toContain('left column')
    expect(a.snippet).not.toContain('right column')
  })

  it('crops a figure from above its caption and gives repeated labels unique ids', () => {
    const { anchors } = page(12, [
      line('Some text above the figure.', 0.1, 0.1),
      line('Figure 1.3 A function maps every element in the domain.', 0.2, 0.5),
      line('Definition', 0.12, 0.6), line('A function is a rule.', 0.12, 0.62),
      line('Definition', 0.12, 0.7), line('A relation is a set of pairs.', 0.12, 0.72),
    ])
    const figure = find(anchors, 'figure', '1.3')!
    expect(figure.box.y).toBeLessThan(0.13)
    expect(figure.box.y + figure.box.h).toBeGreaterThan(0.5 + 0.012)
    const definitions = anchors.filter(anchor => anchor.kind === 'definition')
    expect(definitions.map(anchor => anchor.id)).toEqual(['book#12:definition:', 'book#12:definition::2'])
    expect(definitions[0].heading).toBe('Definition A function is a rule.')
  })

  it('reads "12)" numbering like "12." in an exercise set, and a worksheet stays one set under a big title', () => {
    const set = page(3, [line('SECTION 2.1 EXERCISES', 0.1, 0.1, 14), line('12) Solve 3x + 3 = 5 for x.', 0.1, 0.2), line('13) Solve x + 2 = 7 for x.', 0.1, 0.25)])
    expect(set.anchors.filter(a => a.kind === 'exercise').map(a => a.label)).toEqual(['12', '13'])
    const lines = [line('Unit 4 Quiz', 0.1, 0.1, 18), line('1) Solve 2x = 4 for x.', 0.1, 0.2), line('2) Solve x + 1 = 3 for x.', 0.1, 0.25)]
    const sheet = detectAnchors('book', { index: 0, lines, exerciseMode: false, allExercises: true }, BODY)
    expect(sheet.anchors.map(a => `${a.kind} ${a.label}`)).toEqual(['exercise 1', 'exercise 2'])
    expect(sheet.exerciseMode).toBe(true)
    // without it, a title that big ends an exercise set
    expect(page(0, lines, true).anchors).toEqual([])
  })

  it('handles empty or odd input', () => {
    expect(page(0, []).anchors).toEqual([])
    expect(detectAnchors('b', { index: 0, lines: [line('EXAMPLE 1.1', 0.1, 0.1)], exerciseMode: false }, 0).anchors).toHaveLength(1)
  })
})

/** The number's line an anchor was found on, as a point inside another box would show. */
const inside = (box: Anchor['box'], x: number, y: number) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h
const bottom = (anchor: Anchor) => anchor.box.y + anchor.box.h

describe('grid exercise crops', () => {
  it('ends a cell at the next row even when that row starts further left', () => {
    const cells: Array<[string, number, number]> = [
      ['1 .', 0.118, 0.15], ['2 .', 0.355, 0.15], ['3 .', 0.602, 0.15],
      ['4 .', 0.118, 0.176], ['5 .', 0.415, 0.176], ['6 .', 0.644, 0.176],
      ['7 .', 0.118, 0.202], ['8 .', 0.344, 0.202], ['9 .', 0.603, 0.202],
    ]
    const { anchors } = page(20, [
      line('SECTION 3.1 EXERCISES', 0.17, 0.09, 14),
      ...cells.map(([text, x, y]) => line(text, x, y, 10, 0.012)),
      line('10.', 0.118, 0.228, 10, 0.02),
      line('For the following exercises, given the function', 0.118, 0.262, 10, 0.4),
      line('a. find the slope of the secant line', 0.093, 0.285, 10, 0.3), line('with value given in the table.', 0.513, 0.285, 10, 0.2),
      footer,
    ])
    expect(anchors.map(anchor => anchor.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    const at = (label: string) => find(anchors, 'exercise', label)!
    expect(bottom(at('6'))).toBeLessThanOrEqual(0.202)
    expect(bottom(at('5'))).toBeLessThanOrEqual(0.202)
    expect(bottom(at('3'))).toBeLessThanOrEqual(0.176)
    expect(bottom(at('9'))).toBeLessThanOrEqual(0.228)
    // the next group's instructions are not part of exercise 10
    expect(bottom(at('10'))).toBeLessThanOrEqual(0.262)
    expect(at('10').snippet).not.toContain('For the following')
    for (const anchor of anchors) {
      for (const [text, x, y] of cells) if (text !== `${anchor.label} .`) expect(inside(anchor.box, x + 0.003, y + 0.007)).toBe(false)
    }
  })

  it('keeps a cell’s own words that run past the next number and paints out the neighbours', () => {
    const { anchors } = page(21, [
      line('SECTION 1.1 EXERCISES', 0.17, 0.05, 14),
      line('57. [T] The manager at a skateboard', 0.118, 0.075, 10, 0.235),
      line('58 . [T] Use a graphing calculator to', 0.372, 0.075, 10, 0.227),
      line('shop pays his workers a monthly', 0.146, 0.09, 10, 0.208),
      line('graph the half-circle', 0.401, 0.09, 10, 0.126),
      line('graphing calculator to determine', 0.176, 0.105, 10, 0.209),
      line('of both the intercepts.', 0.401, 0.12, 10, 0.14),
      line('the number of skateboards sold.', 0.176, 0.135, 10, 0.2),
      footer,
    ])
    const left = find(anchors, 'exercise', '57')!, right = find(anchors, 'exercise', '58')!
    // 57's longest line ends at .385, past 58's number at .372
    expect(left.box.x + left.box.w).toBeGreaterThanOrEqual(0.385)
    expect(left.snippet).toContain('graphing calculator to determine')
    expect(left.snippet).not.toContain('half-circle')
    // 58's number inside 57's crop is painted out, and 57's words inside 58's crop too
    expect(left.mask?.some(m => m.x <= 0.373 && m.x + m.w >= 0.38 && m.y <= 0.08 && m.y + m.h >= 0.08)).toBe(true)
    expect(right.mask?.some(m => m.y <= 0.11 && m.y + m.h >= 0.11 && m.x <= right.box.x + 0.001 && m.x + m.w >= 0.385)).toBe(true)
    expect(right.snippet).not.toContain('skateboard')
    // masks never cover the item's own number
    for (const m of right.mask ?? []) expect(inside(m, 0.375, 0.08)).toBe(false)
  })

  it('stops at an instruction row split into pieces by math', () => {
    const { anchors } = page(22, [
      line('SECTION 2.1 EXERCISES', 0.17, 0.05, 14),
      line('1 . [T] Complete the following table', 0.118, 0.1366, 10, 0.224),
      line('2 . Use the values in the right', 0.365, 0.1366, 10, 0.187),
      line('3 . Use the value in the', 0.591, 0.1366, 10, 0.146),
      line('with the appropriate values:', 0.139, 0.1512, 10, 0.177),
      line('column of the table in the', 0.387, 0.1512, 10, 0.162),
      line('preceding exercise to find', 0.612, 0.1512, 10, 0.163),
      line('For the following exercises, points', 0.118, 0.4538, 10, 0.214),
      line('and', 0.386, 0.4538, 10, 0.024), line('are on the graph of the function', 0.465, 0.4538, 10, 0.203),
      line('4 . [T] Complete the following table', 0.118, 0.4764, 10, 0.224),
      line('5 . Use the values in the right', 0.365, 0.4764, 10, 0.187),
      footer,
    ])
    for (const label of ['1', '2', '3']) {
      const anchor = find(anchors, 'exercise', label)!
      expect(bottom(anchor)).toBeLessThanOrEqual(0.4538)
      expect(anchor.snippet).not.toMatch(/graph of the function|For the following/)
      expect(anchor.box.x + anchor.box.w).toBeLessThan(0.9)
    }
  })

  it('drops a hanging exercise at a line back at its number’s margin', () => {
    const { anchors } = page(23, [
      line('11. Show that the sequence converges and find', 0.118, 0.26, 10, 0.3),
      line('its limit.', 0.146, 0.275, 10, 0.1),
      line('12. Find the limit of the function as x grows', 0.118, 0.3, 10, 0.3),
      line('without bound.', 0.146, 0.315, 10, 0.1),
      line('13. Explain the result in words.', 0.118, 0.34, 10, 0.25),
      line('Body text picks up again at the margin.', 0.118, 0.358, 10, 0.3),
      line('14. Show the steps.', 0.118, 0.4, 10, 0.2),
      footer,
    ], true)
    const thirteen = find(anchors, 'exercise', '13')!
    expect(bottom(thirteen)).toBeLessThanOrEqual(0.358)
    expect(thirteen.snippet).not.toContain('Body text')
    expect(find(anchors, 'exercise', '12')!.snippet).toContain('without bound')
  })
})

describe('other layouts', () => {
  it('finds a mixed case "Example 1." right under a subsection heading', () => {
    for (const gap of [18, 20, 22]) {
      const { anchors } = page(30, [
        line('Some text ends the paragraph before.', 0.1, 0.07),
        line('2.3 Limits at Infinity', 0.1, 0.1, 12),
        line('Example 1. Find the limit of the function.', 0.1, 0.1 + gap / 792),
        line('The answer follows from the rules.', 0.1, 0.1 + gap / 792 + 0.0175),
      ])
      expect(anchors.map(anchor => `${anchor.kind} ${anchor.label}`)).toContain('example 1')
    }
    // after a centered equation or a short caption line too
    const { anchors } = page(31, [
      line('y = 3x', 0.25, 0.3, 10, 0.1),
      line('Example 2. Evaluate the limit.', 0.1, 0.3175),
      line('Figure 2.1 The graph of f', 0.2, 0.5, 10, 0.25),
      line('Example 3. Sketch the graph.', 0.1, 0.5175),
    ])
    expect(anchors.map(anchor => `${anchor.kind} ${anchor.label}`)).toEqual(expect.arrayContaining(['example 2', 'example 3']))
  })

  it('still reads a wrapped reference as part of its sentence', () => {
    const { anchors } = page(32, [
      line('We computed this limit with the squeeze theorem, which was the result of', 0.1, 0.3, 10, 0.79),
      line('Example 3.5. The limit exists because the bounds agree.', 0.1, 0.3175),
    ])
    expect(anchors).toEqual([])
  })

  it('never drops an item heading at the top or bottom edge as a running header', () => {
    const top = page(33, [
      line('Example 4', 0.1, 0.05), line('Find the derivative of the function below.', 0.1, 0.066),
      line('More text follows here in the body.', 0.1, 0.082),
    ])
    expect(top.anchors.map(anchor => anchor.label)).toEqual(['4'])
    const low = page(34, [
      line('Body text near the foot of the page.', 0.1, 0.885), line('More body text right above.', 0.1, 0.9),
      line('Example 4', 0.1, 0.919),
    ])
    expect(low.anchors.map(anchor => anchor.label)).toEqual(['4'])
    // a real running header and footer are still left out
    const paged = page(35, [header('3.1 • Defining the Derivative 193'), line('EXAMPLE 3.1', 0.1, 0.1), line('Finding a slope.', 0.1, 0.12), footer])
    expect(paged.anchors.map(anchor => anchor.label)).toEqual(['3.1'])
    expect(paged.anchors[0].snippet).not.toContain('Defining')
  })

  it('ends exercise mode at any heading as big as the one that started it, or at "Section N.N"', () => {
    const first = page(40, [line('Exercises', 0.1, 0.1, 14), line('1. Find the limit.', 0.1, 0.15), line('2. Find the derivative.', 0.1, 0.18)])
    expect(first.anchors.map(anchor => anchor.label)).toEqual(['1', '2'])
    expect(first.exerciseMode).toBe(true)
    expect(first.exerciseSize).toBeCloseTo(14 / 792, 6)
    const next = detectAnchors('book', {
      index: 41, exerciseMode: first.exerciseMode, exerciseSize: first.exerciseSize,
      lines: [line('Continuity', 0.1, 0.1, 14), line('EXAMPLE 4', 0.1, 0.15), line('Solution', 0.12, 0.2), line('1. Let f be continuous.', 0.1, 0.22), line('2. Check the limit.', 0.1, 0.24)],
    }, BODY)
    expect(next.exerciseMode).toBe(false)
    expect(next.anchors.map(anchor => `${anchor.kind} ${anchor.label}`)).toEqual(['example 4'])
    // callers that only carry the flag still stop at a "Section 2.3" heading
    const section = page(42, [line('Section 2.3 Limit Laws', 0.1, 0.1, 12), line('1. Let f be a function.', 0.1, 0.15)], true)
    expect(section.exerciseMode).toBe(false)
    expect(section.anchors).toEqual([])
    // smaller headings inside an exercise set keep it going
    const inside = detectAnchors('book', { index: 43, exerciseMode: true, exerciseSize: 14 / 792, lines: [line('Applications', 0.1, 0.1, 12), line('7. Model the growth.', 0.1, 0.15)] }, BODY)
    expect(inside.anchors.map(anchor => anchor.label)).toEqual(['7'])
  })
})

describe('items split across pages', () => {
  const theoremPage = (index: number) => page(index, [
    header('3.3 • Differentiation Rules 219'),
    line('Thus the rule holds for every power.', 0.118, 0.075, 10, 0.5),
    line('Theorem 3.4', 0.127, 0.51),
    line('Sum, Difference, and Constant Multiple Rules', 0.127, 0.541),
    ...Array.from({ length: 16 }, (_, i) => line(`rule text line number ${i} of the theorem`, 0.127, 0.56 + i * 0.02, 10, 0.6)),
    line('that is,', 0.127, 0.884, 10, 0.04),
    footer,
  ])

  it('finds the rest of a theorem above "Proof" on the next page', () => {
    const first = theoremPage(226)
    const theorem = find(first.anchors, 'theorem', '3.4')!
    expect(first.open.map(item => item.id)).toEqual([theorem.id])
    // the next page opens with the rest (a formula drawn as graphics, so no text) and then the proof
    const next = detectAnchors('book', {
      index: 227, exerciseMode: false, carry: first.open,
      lines: [header('220 3 • Derivatives'), line('Proof', 0.118, 0.1255, 12), line('We provide only the proof of the sum rule.', 0.118, 0.1415, 10, 0.5), footer],
    }, BODY)
    expect(next.continued).toHaveLength(1)
    const { id, continues } = next.continued[0]
    expect(id).toBe(theorem.id)
    expect(continues.pageIndex).toBe(227)
    expect(continues.box.y).toBeLessThan(0.06)
    expect(continues.box.y + continues.box.h).toBeLessThanOrEqual(0.1255)
    expect(continues.box.x).toBeCloseTo(theorem.box.x, 3)
    expect(continues.box.w).toBeCloseTo(theorem.box.w, 3)
  })

  it('does not stitch when the next page starts right away with something else', () => {
    const first = theoremPage(226)
    const proof = detectAnchors('book', { index: 227, exerciseMode: false, carry: first.open, lines: [header('220 3 • Derivatives'), line('Proof', 0.118, 0.075, 12), line('We provide the proof.', 0.118, 0.095), footer] }, BODY)
    expect(proof.continued).toEqual([])
    // a boxed item stops at a figure caption: whatever follows the figure is not its rest
    const figure = detectAnchors('book', { index: 227, exerciseMode: false, carry: first.open, lines: [header('220 3 • Derivatives'), line('Figure 3.18 The derivative of a sum.', 0.3, 0.25, 10, 0.3), line('Body text after the figure.', 0.118, 0.28, 10, 0.5), footer] }, BODY)
    for (const { continues } of figure.continued) expect(continues.box.y + continues.box.h).toBeLessThanOrEqual(0.25)
    // a grid exercise at the foot of the page is followed by new exercises, not by its own rest
    const grid = page(300, [line('41. Find the limit.', 0.43, 0.9, 10, 0.2), line('40. Find the value.', 0.118, 0.9, 10, 0.2), footer], true)
    const after = detectAnchors('book', { index: 301, exerciseMode: true, carry: grid.open, lines: [header('134 2 • Limits'), line('42.', 0.118, 0.083, 10, 0.02), line('43 .', 0.343, 0.083, 10, 0.02), line('x', 0.538, 0.13, 10, 0.01), footer] }, BODY)
    expect(after.continued).toEqual([])
  })

  it('continues an example with its parts on the next page, down to "Solution"', () => {
    const first = page(22, [
      line('Text before the example.', 0.118, 0.075, 10, 0.5),
      line('EXAMPLE 1.4', 0.127, 0.86),
      line('Using Zeros and Intercepts to Sketch a Graph', 0.118, 0.887, 10, 0.4),
      line('Consider the function below.', 0.118, 0.905, 10, 0.3),
      footer,
    ])
    const example = find(first.anchors, 'example', '1.4')!
    const next = detectAnchors('book', {
      index: 23, exerciseMode: false, carry: first.open,
      lines: [line('a. Find all zeros of f.', 0.123, 0.075, 10, 0.2), line('b. Find the intercept (if any).', 0.123, 0.093, 10, 0.25), line('Solution', 0.141, 0.13), line('a. To find the zeros, solve.', 0.118, 0.15, 10, 0.3), footer],
    }, BODY)
    expect(next.continued.map(entry => entry.id)).toEqual([example.id])
    const box = next.continued[0].continues.box
    expect(box.y).toBeLessThan(0.075)
    expect(box.y + box.h).toBeGreaterThan(0.093 + 0.012)
    expect(box.y + box.h).toBeLessThanOrEqual(0.13)
  })

  it('continues a left column item at the top of the right column on the same page', () => {
    const left = Array.from({ length: 30 }, (_, i) => line(`left column body text line ${i}`, 0.08, 0.2 + i * 0.024, 10, 0.36))
    const right = [line('the rest of the definition text', 0.53, 0.075, 10, 0.36), line('and its last words here.', 0.53, 0.095, 10, 0.3),
      ...Array.from({ length: 8 }, (_, i) => line(`right column body text line ${i}`, 0.52, 0.2 + i * 0.024, 10, 0.36))]
    const { anchors } = page(50, [line('text above', 0.08, 0.075, 10, 0.36), line('Definition', 0.09, 0.17), ...left.map(l => ({ ...l, box: { ...l.box, x: 0.09 } })), ...right, footer])
    const definition = find(anchors, 'definition', '')!
    expect(definition.continues?.pageIndex).toBe(50)
    expect(definition.continues!.box.x).toBeGreaterThan(0.45)
    expect(definition.continues!.box.y + definition.continues!.box.h).toBeLessThanOrEqual(0.2)
  })
})

describe('the real test book', () => {
  it.skipIf(!existsSync(book))('finds the items teachers ask for and no false exercises', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(book)), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise
    const pages: TextLine[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const pdfPage = await doc.getPage(i)
      pages.push((await pageLines(pdfPage)).lines)
      pdfPage.cleanup()
    }
    await doc.loadingTask.destroy()
    const body = bodyFontSize(pages.flat())
    const anchors: Anchor[] = []
    let exerciseMode = false, answers = 0
    pages.forEach((lines, index) => {
      const result = detectAnchors('calc', { index, lines, exerciseMode, answers }, body)
      anchors.push(...result.anchors)
      exerciseMode = result.exerciseMode; answers = result.answers
    })
    const at = (index: number) => anchors.filter(anchor => anchor.pageIndex === index).map(anchor => `${anchor.kind} ${anchor.label}`)
    expect(at(199)).toContain('example 3.2')
    expect(at(201)).toContain('checkpoint 3.2')
    expect(at(210)).toContain('section 3.2')
    expect(at(194)).not.toContain('checkpoint 3.2')
    const example = anchors.find(anchor => anchor.pageIndex === 199 && anchor.kind === 'example' && anchor.label === '3.2')!
    expect(example.heading).toBe('EXAMPLE 3.2 The Slope of a Tangent Line Revisited')
    expect(example.box.y + example.box.h).toBeLessThan(0.15)
    // one of each numbered example, checkpoint and section, and none from the table of contents or answer key
    for (const kind of ['example', 'checkpoint', 'section']) {
      const labels = anchors.filter(anchor => anchor.kind === kind).map(anchor => anchor.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
    expect(anchors.filter(anchor => anchor.kind === 'section')).toHaveLength(45)
    expect(anchors.some(anchor => anchor.pageIndex < 14 || anchor.pageIndex >= 684)).toBe(false)
    // exercises only inside exercise sections: none on the example pages of section 3.1
    for (const index of [196, 197, 198, 199, 200, 201, 202, 203]) expect(at(index).some(item => item.startsWith('exercise'))).toBe(false)
    expect(at(219)).toEqual(expect.arrayContaining(['exercise 54', 'exercise 55', 'exercise 56', 'exercise 66']))
    const cell = anchors.find(anchor => anchor.pageIndex === 219 && anchor.label === '54')!
    expect(cell.box.x + cell.box.w).toBeLessThan(0.343)
  }, 120_000)
})
