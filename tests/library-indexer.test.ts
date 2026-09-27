import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { bookTitle, importBook, inspectPdf } from '../src/library/indexer'
import { hasPdfHeader, isPdfFile, setPdfJsLoader, textLinesFrom } from '../src/library/pdfjs'
import { getAnchors, getBook, getBookBytes, getPages, listBooks } from '../src/library/store'
import type { ImportProgress } from '../src/library/types'

const book = `${process.cwd()}/.local/test-books/calculus-volume-1.pdf`
const fonts = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`

beforeAll(() => {
  setPdfJsLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs'), { standardFontDataUrl: fonts, cMapUrl: `${process.cwd()}/node_modules/pdfjs-dist/cmaps/`, cMapPacked: true })
})

// a one page PDF locked with a user password
const LOCKED = [
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDMxOTJkZDdkYWI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW',
  '5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAu',
  'MCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAxCi9SIDIKL0xlbmd0aCA0MAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw5MmZlMGY0ND',
  'U0YWQ0Yzk2NDQ2OTNmMzNjMDdjYjU0ZjU4N2RjZTFlMjY4MmZlOWVjZWE2MTA3YTFlZjYzMGRkPgovVSA8ZWEzOGIzOWFlOGEwMDY0OWJiYThkOTA2OGY2NTc4MmE3NTMxOTVjZTAwNzA0OGNlZWYz',
  'NTI5NTZjNzQwMzExMT4KPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbi',
  'AKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjYxIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzUzOTYzMzIzMDYyNjI2MTY1NjMz',
  'ODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IF',
  '0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjQ3NQolJUVPRgo=',
].join('')

type Text = [text: string, x: number, top: number, size?: number]

/** A small textbook: title, contents, then printed pages 1..6 with running headers. */
async function fixtureBook(title = 'Fixture Calculus'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const body: Text[][] = [
    [['Fixture Calculus', 72, 200, 28]],
    [['Contents', 72, 80, 16], ['3.1 Defining the Derivative 1', 90, 120], ['3.2 The Derivative as a Function 4', 90, 136], ['3.3 Differentiation Rules 6', 90, 152]],
    [['3.1 Defining the Derivative', 72, 70, 18], ['We start with slopes of secant lines and tangent lines.', 72, 110],
      ['EXAMPLE 3.1', 80, 150], ['Finding a Slope', 72, 170], ['Find the slope of the secant line through two points.', 72, 186], ['Solution', 86, 210],
      ['1. Let h approach zero.', 72, 228], ['2. Simplify the quotient.', 72, 244]],
    [['EXAMPLE 3.2', 80, 70], ['The Slope of a Tangent Line Revisited', 72, 90], ['Use Equation 3.4 to find the slope of the tangent line at x = 3.', 72, 106],
      ['Solution', 86, 130], ['1. Let x = 3.', 72, 148], ['The slope is 6.', 72, 164],
      ['3.2 For f(x) = x squared, use a table to estimate the slope at 3.', 92, 230], ['After the checkpoint the text goes on.', 72, 280]],
    [['SECTION 3.1 EXERCISES', 100, 70, 14], ['For the following exercises, find the derivative.', 72, 100],
      ['47. f(x) = 3x', 72, 130], ['48. f(x) = x + 1', 250, 130], ['49. f(x) = 2', 430, 130], ['50. Explain what a derivative means in words.', 72, 170]],
    [['3.2 The Derivative as a Function', 72, 70, 18], ['1. Let f be a function defined on an interval.', 72, 110],
      ['Figure 3.2 The derivative of a function drawn as a graph.', 150, 300]],
    [['SECTION 3.2 EXERCISES', 100, 70, 14], ['48. Find the derivative of the cube function.', 72, 100], ['51. Explain the chain rule for composite functions.', 72, 130]],
    [['3.3 Differentiation Rules', 72, 70, 18], ['EXAMPLE 3.12', 80, 110], ['Using the Chain Rule', 72, 130], ['Differentiate a composite function with the chain rule.', 72, 146],
      ['Solution', 86, 170], ['Apply the chain rule twice.', 72, 188]],
  ]
  body.forEach((lines, index) => {
    const page = pdf.addPage([612, 792])
    if (index >= 2) {
      const n = index - 1
      page.drawText(n % 2 ? `3.1 • Defining the Derivative ${n}` : `${n} 3 • Derivatives`, { x: n % 2 ? 380 : 72, y: 792 - 36, size: 8, font })
      page.drawText('Access for free at example.org', { x: 72, y: 30, size: 8, font })
    }
    for (const [text, x, top, size = 10] of lines) page.drawText(text, { x, y: 792 - top - size * 0.8, size, font })
  })
  return pdf.save()
}

const pdfFile = (bytes: Uint8Array, name = 'fixture-calculus.pdf') => new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' })

describe('pdf helpers', () => {
  it('recognizes PDFs', () => {
    expect(hasPdfHeader(new TextEncoder().encode('%PDF-1.7 rest'))).toBe(true)
    expect(hasPdfHeader(new TextEncoder().encode('<html>'))).toBe(false)
    expect(isPdfFile({ name: 'Book.PDF', type: '' })).toBe(true)
    expect(isPdfFile({ name: 'notes', type: 'application/pdf' })).toBe(true)
    expect(isPdfFile({ name: 'photo.png', type: 'image/png' })).toBe(false)
  })

  it('names books by a real metadata title, else the file name', () => {
    expect(bookTitle('Calculus Volume 1', 'x.pdf')).toBe('Calculus Volume 1')
    expect(bookTitle('untitled', 'calculus_volume_1.pdf')).toBe('calculus volume 1')
    expect(bookTitle('Microsoft Word - Notes.docx', 'notes.pdf')).toBe('notes')
    expect(bookTitle(undefined, '.pdf')).toBe('Untitled book')
  })

  it('builds lines in reading order and keeps side by side columns apart', () => {
    const item = (str: string, x: number, y: number, width: number, hasEOL = false, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width, hasEOL })
    const toView = (x: number, y: number) => [x, 792 - y]
    const lines = textLinesFrom([
      item('93.', 72, 500, 14), item(' ', 86, 500, 20), item('denotes the grade', 110, 500, 80, true),
      item('94.', 210, 500, 14), item('denotes the cost', 230, 500, 80, true),
      item('x', 72, 400, 6), item('2', 78, 404, 4, false, 7), item(' + 1', 83, 400, 20),
      item('tail', 150, 300, 20), item('head', 100, 300, 45),
      { type: 'beginMarkedContent' }, item('', 0, 0, 0, true), null,
    ], toView, 612, 792)
    expect(lines.map(line => line.text)).toEqual(['93. denotes the grade', '94. denotes the cost', 'x2 + 1', 'head tail'])
    const grade = lines[0]
    expect(grade.box.x).toBeCloseTo(72 / 612, 4)
    expect(grade.box.x + grade.box.w).toBeCloseTo(190 / 612, 3)
    expect(grade.size).toBeCloseTo(10 / 792, 5)
    expect(textLinesFrom([], toView, 0, 0)).toEqual([])
  })
})

describe('importBook', () => {
  it('saves a book with printed labels, pages and items, and reports progress', async () => {
    const bytes = await fixtureBook()
    const events: ImportProgress[] = []
    expect(await inspectPdf(pdfFile(bytes))).toEqual({ pageCount: 8, title: 'Fixture Calculus', size: bytes.byteLength })
    const record = await importBook(pdfFile(bytes), p => events.push(p))
    expect(record).toMatchObject({ title: 'Fixture Calculus', fileName: 'fixture-calculus.pdf', pageCount: 8, indexed: true, size: bytes.byteLength })
    expect(record.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(record.labels).toEqual([null, null, '1', '2', '3', '4', '5', '6'])
    expect(record.textPages).toBe(7)
    expect(events[0].phase).toBe('reading')
    expect(events.at(-1)).toEqual({ phase: 'saving', done: 8, total: 8 })
    expect(events.some(event => event.phase === 'indexing')).toBe(true)

    expect(await getBook(record.id)).toEqual(record)
    expect((await getBookBytes(record.id))?.byteLength).toBe(bytes.byteLength)
    const pages = await getPages(record.id)
    expect(pages.map(page => page.label)).toEqual(record.labels)
    expect(pages[3].text).toContain('EXAMPLE 3.2')
    expect(pages[3].lines.length).toBeGreaterThan(5)

    const anchors = await getAnchors(record.id)
    const names = anchors.map(anchor => `${anchor.pageIndex} ${anchor.kind} ${anchor.label}`)
    expect(names).toEqual(expect.arrayContaining([
      '2 section 3.1', '2 example 3.1', '3 example 3.2', '3 checkpoint 3.2', '4 exercise 47', '4 exercise 48', '4 exercise 49', '4 exercise 50',
      '5 section 3.2', '5 figure 3.2', '6 exercise 48', '6 exercise 51', '7 section 3.3', '7 example 3.12',
    ]))
    // contents lines, worked solution steps and numbered steps after a section heading are not items
    expect(names.filter(name => name.startsWith('1 '))).toEqual([])
    expect(names.filter(name => / exercise /.test(name) && !/^[46] /.test(name))).toEqual([])
    const cell = anchors.find(anchor => anchor.pageIndex === 4 && anchor.label === '47')!
    expect(cell.box.x + cell.box.w).toBeLessThan(250 / 612)
  })

  it('reopens a book that is already in the library instead of reading it again', async () => {
    const bytes = await fixtureBook()
    const first = await importBook(pdfFile(bytes))
    const events: ImportProgress[] = []
    const again = await importBook(pdfFile(bytes, 'renamed.pdf'), p => events.push(p))
    expect(again.id).toBe(first.id)
    expect(again.fileName).toBe('fixture-calculus.pdf')
    expect(again.openedAt).toBeGreaterThanOrEqual(first.openedAt)
    expect(events.every(event => event.phase === 'reading')).toBe(true)
  })

  it('rejects files that are not usable PDFs and leaves nothing behind', async () => {
    const before = (await listBooks()).length
    await expect(importBook(new File(['hello'], 'notes.pdf'))).rejects.toThrow('This file is not a PDF.')
    await expect(importBook(new File([], 'empty.pdf'))).rejects.toThrow('This file is empty.')
    await expect(importBook(new File(['%PDF-1.4\nthis is not really a pdf'], 'broken.pdf'))).rejects.toThrow('This PDF could not be opened.')
    await expect(importBook(pdfFile(new Uint8Array(Buffer.from(LOCKED, 'base64')), 'locked.pdf'))).rejects.toThrow('This PDF is password protected. Save an unlocked copy and import that.')
    const huge = { name: 'huge.pdf', type: 'application/pdf', size: 401 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File
    await expect(importBook(huge)).rejects.toThrow('Choose a PDF smaller than 400 MB.')
    await expect(inspectPdf(new File(['nope'], 'x.pdf'))).rejects.toThrow('This file is not a PDF.')
    expect((await listBooks()).length).toBe(before)
  })

  it.skipIf(!existsSync(book))('indexes the real 769 page book quickly', async () => {
    const started = Date.now()
    const record = await importBook(pdfFile(new Uint8Array(readFileSync(book)), 'calculus-volume-1.pdf'))
    expect(Date.now() - started).toBeLessThan(60_000)
    expect(record).toMatchObject({ title: 'Calculus Volume 1', pageCount: 769, indexed: true })
    expect(record.labels[30]).toBe('23')
    expect(record.textPages).toBeGreaterThan(700)
    expect(record.outline.find(entry => entry.title === '3.2 The Derivative as a Function')?.pageIndex).toBe(210)
    const anchors = await getAnchors(record.id)
    expect(anchors.some(anchor => anchor.pageIndex === 199 && anchor.kind === 'example' && anchor.label === '3.2')).toBe(true)
    expect(anchors.length).toBeGreaterThan(1000)
  }, 120_000)
})
