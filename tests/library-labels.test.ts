import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { assignPrintedLabels, findPageIndex, printedNumberCandidates, romanValue, toRoman } from '../src/library/labels'
import { pageLines } from '../src/library/pdfjs'

const book = `${process.cwd()}/.local/test-books/calculus-volume-1.pdf`

describe('printed page number candidates', () => {
  it('reads numbers at the start or end of running headers and footers', () => {
    expect(printedNumberCandidates(['22 1 • Functions and Graphs'])).toEqual(['22'])
    expect(printedNumberCandidates(['1.1 • Review of Functions 23'])).toEqual(['23'])
    expect(printedNumberCandidates(['Page 7'])).toEqual(['7'])
    expect(printedNumberCandidates(['xii Preface', 'Contents vii'])).toEqual(['xii', 'vii'])
    expect(printedNumberCandidates(['  41  '])).toEqual(['41'])
  })

  it('ignores item numbers, decimals and plain text', () => {
    expect(printedNumberCandidates(['Access for free at openstax.org'])).toEqual([])
    expect(printedNumberCandidates(['23.', '7 .', '4.10 Antiderivatives', 'Figure 1.2 A graph', '0', '007'])).toEqual([])
    expect(printedNumberCandidates(['', '   '])).toEqual([])
  })

  it('knows roman numerals up to lxxx', () => {
    expect(romanValue('xii')).toBe(12)
    expect(romanValue('xliv')).toBe(44)
    expect(romanValue('lxxx')).toBe(80)
    expect(romanValue('iiii')).toBeNull()
    expect(romanValue('XII')).toBeNull()
    expect(romanValue('mix')).toBeNull()
    expect(toRoman(14)).toBe('xiv')
    expect(toRoman(49)).toBe('xlix')
  })
})

/** A book: 3 unnumbered pages, roman front matter i..v, then arabic 1..n with the given edges. */
function fakeBook(arabic: number, options: { gapAt?: number[]; noise?: Record<number, string> } = {}) {
  const pages: { index: number; edges: string[] }[] = []
  for (let index = 0; index < 3; index++) pages.push({ index, edges: ['Cover', 'A Title'] })
  for (let n = 1; n <= 5; n++) pages.push({ index: pages.length, edges: [n % 2 ? `Preface ${toRoman(n)}` : `${toRoman(n)} Preface`, 'Some text'] })
  for (let n = 1; n <= arabic; n++) {
    const index = pages.length
    const header = options.gapAt?.includes(n) ? 'Chapter 2 Limits' : n % 2 ? `2.1 • A Preview of Calculus ${n}` : `${n} 2 • Limits`
    pages.push({ index, edges: [header, 'body line', 'more body', options.noise?.[n] ?? 'last line', 'Access for free at openstax.org'] })
  }
  return pages
}

describe('assignPrintedLabels', () => {
  it('votes offsets, fills gaps inside a run and labels roman front matter', () => {
    const pages = fakeBook(30, { gapAt: [10, 11], noise: { 5: '2016', 20: '999' } })
    const labels = assignPrintedLabels(pages, null)
    expect(labels.slice(0, 3)).toEqual([null, null, null])
    expect(labels.slice(3, 8)).toEqual(['i', 'ii', 'iii', 'iv', 'v'])
    expect(labels[8]).toBe('1')
    expect(labels[8 + 9]).toBe('10')
    expect(labels[8 + 10]).toBe('11')
    expect(labels[8 + 29]).toBe('30')
    expect(labels).toHaveLength(pages.length)
  })

  it('handles an excerpt whose pages start in the middle of a book', () => {
    const pages = Array.from({ length: 11 }, (_, index) => ({ index, edges: [`${200 + index} Chapter 4`, 'text'] }))
    expect(assignPrintedLabels(pages)).toEqual(Array.from({ length: 11 }, (_, i) => String(200 + i)))
  })

  it('carries a run onto an unnumbered chapter opener next to it', () => {
    const pages = [{ index: 0, edges: ['CHAPTER 3', 'Derivatives'] }, ...Array.from({ length: 6 }, (_, i) => ({ index: i + 1, edges: [`${i + 8} Derivatives`] }))]
    expect(assignPrintedLabels(pages)[0]).toBe('7')
  })

  it('uses the PDF labels only when they add something and agree with the pages', () => {
    const pages = fakeBook(10)
    const trivial = pages.map((_, i) => String(i + 1))
    expect(assignPrintedLabels(pages, trivial)[8]).toBe('1')
    const agreeing = pages.map((_, i) => i < 3 ? `C${i}` : i < 8 ? toRoman(i - 2) : String(i - 7))
    expect(assignPrintedLabels(pages, agreeing)[0]).toBe('C0')
    const wrong = pages.map((_, i) => `X${i}`)
    expect(assignPrintedLabels(pages, wrong)[8]).toBe('1')
  })

  it('falls back to the PDF labels when the pages show no numbers', () => {
    const pages = Array.from({ length: 4 }, (_, index) => ({ index, edges: ['Worksheet', 'Name:'] }))
    expect(assignPrintedLabels(pages, ['a', 'b', '', null])).toEqual(['a', 'b', null, null])
    expect(assignPrintedLabels(pages, ['1', '2', '3', '4'])).toEqual(['1', '2', '3', '4'])
    expect(assignPrintedLabels(pages, null)).toEqual([null, null, null, null])
  })

  it('does not trust a single stray number', () => {
    const pages = Array.from({ length: 20 }, (_, index) => ({ index, edges: index === 7 ? ['12 Things'] : ['No numbers here'] }))
    expect(assignPrintedLabels(pages).every(label => label === null)).toBe(true)
    expect(assignPrintedLabels([{ index: 0, edges: ['Worksheet 3'] }])).toEqual(['3'])
    expect(assignPrintedLabels([])).toEqual([])
  })
})

describe('findPageIndex', () => {
  const labels = [null, 'i', 'ii', 'xii', '1', '2', '22', null]
  it('finds exact labels first, roman numerals in any case', () => {
    expect(findPageIndex(labels, '22')).toBe(6)
    expect(findPageIndex(labels, 'XII')).toBe(3)
    expect(findPageIndex(labels, ' 2 ')).toBe(5)
    expect(findPageIndex(labels, '23')).toBeNull()
    expect(findPageIndex(labels, '')).toBeNull()
  })
})

describe('the real test book', () => {
  it.skipIf(!existsSync(book))('reads printed page numbers from the running headers', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(book)), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise
    const pages: { index: number; edges: string[] }[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const { lines } = await pageLines(page)
      pages.push({ index: i - 1, edges: [...lines.slice(0, 2), ...lines.slice(Math.max(2, lines.length - 3))].map(line => line.text) })
      page.cleanup()
    }
    const labels = assignPrintedLabels(pages, await doc.getPageLabels())
    await doc.loadingTask.destroy()
    expect(labels[29]).toBe('22')
    expect(labels[30]).toBe('23')
    expect(labels[31]).toBe('24')
    expect(labels[199]).toBe('192')
    expect(labels[768]).toBe('761')
    expect(labels.slice(0, 8).every(label => label === null)).toBe(true)
    expect(labels.every((label, i) => label === null || Number(label) === i - 7)).toBe(true)
    expect(findPageIndex(labels, '23')).toBe(30)
  }, 120_000)
})
