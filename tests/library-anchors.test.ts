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

  it('handles empty or odd input', () => {
    expect(page(0, []).anchors).toEqual([])
    expect(detectAnchors('b', { index: 0, lines: [line('EXAMPLE 1.1', 0.1, 0.1)], exerciseMode: false }, 0).anchors).toHaveLength(1)
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
