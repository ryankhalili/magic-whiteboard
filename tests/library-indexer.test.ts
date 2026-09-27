import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { INDEX_VERSION, bookTitle, ensureIndexed, importBook, inspectPdf, needsReindex } from '../src/library/indexer'
import { hasPdfHeader, isPdfFile, setPdfJsLoader, textLinesFrom } from '../src/library/pdfjs'
import { bookIdFor, getAnchors, getBook, getBookBytes, getPages, getThumb, listBooks, putAnchors, putBookBytes, putThumb, removeBook, saveBook } from '../src/library/store'
import type { Anchor, BookRecord, ImportProgress } from '../src/library/types'

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

  it('starts a line at an exercise number set after math or right against the cell before it', () => {
    const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, hasEOL })
    const toView = (x: number, y: number) => [x, 792 - y]
    const lines = textLinesFrom([
      // "with" then math drawn as graphics, then the next cell's number: "with 413 ." used to be one line
      item('412', 210, 500, 14), item(' .', 224, 500, 2), item(' ', 226, 500, 50), item('with', 315, 500, 17), item(' ', 332, 500, 17),
      item('413', 348, 500, 14), item(' .', 362, 500, 2), item(' ', 364, 500, 6), item('What is the value of', 370, 500, 76),
      // a cell whose words reach the next cell's number: "from a11 ." used to be one line
      item('10', 72, 400, 9), item('.', 81, 400, 2), item(' ', 83, 400, 6), item('person walks away from a', 90, 400, 138, true),
      item('', 228, 400, 0, true), item('11', 228, 400, 9), item(' .', 237, 400, 2), item(' ', 239, 400, 6), item('Using the previous', 245, 400, 72, true),
      // a numbered step inside a sentence stays whole
      item('Step', 72, 300, 20), item(' ', 92, 300, 3), item('1', 95, 300, 5), item('.', 100, 300, 2), item(' Let h go to zero', 102, 300, 70),
    ], toView, 612, 792)
    expect(lines.map(line => line.text)).toEqual(['412 .', 'with', '413 . What is the value of', '10. person walks away from a', '11 . Using the previous', 'Step 1. Let h go to zero'])
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
    expect(record).toMatchObject({ title: 'Calculus Volume 1', pageCount: 769, indexed: true, indexVersion: INDEX_VERSION })
    expect(record.labels[30]).toBe('23')
    expect(record.textPages).toBeGreaterThan(700)
    expect(record.outline.find(entry => entry.title === '3.2 The Derivative as a Function')?.pageIndex).toBe(210)
    const anchors = await getAnchors(record.id)
    expect(anchors.some(anchor => anchor.pageIndex === 199 && anchor.kind === 'example' && anchor.label === '3.2')).toBe(true)
    expect(anchors.length).toBeGreaterThan(1000)

    // grid exercises end at the next row: exercise 6 on file page 206 used to run down through 9, 13, 16 and more
    const at = (index: number, kind: string, label: string) => anchors.find(anchor => anchor.pageIndex === index && anchor.kind === kind && anchor.label === label)!
    const six = at(206, 'exercise', '6')
    expect(six.box.y + six.box.h).toBeLessThanOrEqual(0.2021)
    // 57's own words run past 58's number and are kept whole
    const fiftySeven = at(37, 'exercise', '57')
    expect(fiftySeven.box.x + fiftySeven.box.w).toBeGreaterThanOrEqual(0.385)
    // Theorem 3.4 goes on at the top of the next page, above its proof
    const theorem = at(226, 'theorem', '3.4')
    expect(theorem.continues?.pageIndex).toBe(227)
    expect(theorem.continues!.box.y + theorem.continues!.box.h).toBeLessThan(0.1255)

    const pages = await getPages(record.id)
    const exercises = anchors.filter(anchor => anchor.kind === 'exercise')
    const masked = (anchor: Anchor, x: number, y: number) => (anchor.mask ?? []).some(m => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)
    const inBox = (anchor: Anchor, x: number, y: number) => x > anchor.box.x && x < anchor.box.x + anchor.box.w && y > anchor.box.y && y < anchor.box.y + anchor.box.h && !masked(anchor, x, y)
    // no crop takes in the next group's "For the following exercises" line (134 did before)
    const instructions = exercises.filter(anchor => pages[anchor.pageIndex].lines.some(line => /^(For|In) the following/.test(line.text)
      && line.box.y > anchor.box.y + 0.01 && line.box.x + line.box.w > anchor.box.x + 0.01 && inBox(anchor, Math.max(line.box.x, anchor.box.x) + 0.005, line.box.y + line.box.h / 2)))
    expect(instructions.map(anchor => anchor.id)).toEqual([])
    // no crop takes in another exercise's number, except where the book itself prints two cells over each other
    // (160 and 162 on file page 491 end their first line on top of 161 and 163)
    const spills = exercises.filter(anchor => exercises.some(other => other !== anchor && other.pageIndex === anchor.pageIndex
      && pages[anchor.pageIndex].lines.some(line => line.text.startsWith(other.label) && Math.abs(line.box.y - other.box.y) < 0.012 && Math.abs(line.box.x - other.box.x - 0.01) < 0.012
        && inBox(anchor, line.box.x + 0.003, line.box.y + line.box.h / 2))))
    expect(spills.length).toBeLessThanOrEqual(7)
    // exercise numbers set right after math or another cell's words are found: 413 on file page 424 was part of "with 413 ."
    for (const [index, label] of [[424, '413'], [311, '11'], [335, '126'], [491, '161'], [538, '419']] as const) expect(at(index, 'exercise', label)).toBeDefined()
    expect(exercises.length).toBeGreaterThanOrEqual(2436)
    const twelve = at(424, 'exercise', '412')
    expect(twelve.box.x + twelve.box.w).toBeLessThan(at(424, 'exercise', '413').box.x + 0.01)
    // a full reindex of the old version gives the same items
    await saveBook({ ...record, indexVersion: undefined })
    const again = await ensureIndexed(record.id)
    expect(again.indexVersion).toBe(INDEX_VERSION)
    expect((await getAnchors(record.id)).length).toBe(anchors.length)
  }, 180_000)
})

type Placed = [text: string, x: number, top: number, size?: number]

/** A theorem that runs off the foot of its page; its last formula (drawn, not text) and the proof are on the next. */
async function splitBook(title = 'Split Theorem Book'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const pages: Placed[][] = [
    [[title, 72, 200, 28]],
    [['Thus the rule holds for every power.', 72, 60], ['Theorem 3.4', 80, 420], ['Sum and Constant Multiple Rules', 80, 445],
      ...Array.from({ length: 16 }, (_, i): Placed => [`rule text line number ${i} of the theorem statement`, 80, 465 + 16 * i]), ['that is,', 80, 722]],
    [['Proof', 72, 140, 12], ['We prove the sum rule only.', 72, 162], ['EXAMPLE 3.20', 80, 220], ['Applying the Rule', 72, 240], ['Solution', 86, 270]],
  ]
  pages.forEach((lines, index) => {
    const page = pdf.addPage([612, 792])
    if (index >= 1) {
      page.drawText(index % 2 ? `3.3 \u2022 Differentiation Rules ${index}` : `${index} 3 \u2022 Derivatives`, { x: index % 2 ? 380 : 72, y: 792 - 36, size: 8, font })
      page.drawText('Access for free at example.org', { x: 72, y: 30, size: 8, font })
    }
    // the formula at the top of the second page is a drawing, like math in the real book
    if (index === 2) page.drawRectangle({ x: 200, y: 792 - 110, width: 200, height: 30, color: rgb(0.1, 0.1, 0.1) })
    for (const [text, x, top, size = 10] of lines) page.drawText(text, { x, y: 792 - top - size * 0.8, size, font })
  })
  return pdf.save()
}

/** Two pages of worksheet problems under a big title, numbered "1)" or "1.", with "Page 1 of 2" footers and no exercises heading. */
async function worksheet(mark: ')' | '.'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Unit 4 Quiz ${mark}`)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  let n = 1
  for (let p = 0; p < 2; p++) {
    const page = pdf.addPage([612, 792])
    page.drawText('Unit 4 Quiz', { x: 72, y: 792 - 60, size: 20, font })
    page.drawText('Solve each equation. Show your work.', { x: 72, y: 792 - 110, size: 10, font })
    for (let row = 0; row < 4; row++) for (const x of [72, 330]) { page.drawText(`${n}${mark} ${n + 2}x + 3 = ${n * 4 + 1}`, { x, y: 792 - 150 - row * 120, size: 10, font }); n++ }
    page.drawText(`Page ${p + 1} of 2`, { x: 280, y: 30, size: 9, font })
  }
  return pdf.save()
}

describe('worksheets and removed books', () => {
  it('finds the numbered problems of a worksheet with no exercises heading', async () => {
    for (const mark of [')', '.'] as const) {
      const record = await importBook(pdfFile(await worksheet(mark), `quiz${mark === ')' ? 'paren' : 'dot'}.pdf`))
      expect(record.labels).toEqual(['1', '2'])
      const anchors = await getAnchors(record.id)
      expect(anchors.filter(anchor => anchor.kind === 'exercise').map(anchor => Number(anchor.label)).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
      const fourteen = anchors.find(anchor => anchor.label === '14')!
      expect(fourteen.pageIndex).toBe(1)
      expect(fourteen.box.w).toBeLessThan(0.5)
    }
  })

  it('keeps a book removed during a re index removed, and importing it again brings it back whole', async () => {
    const bytes = await splitBook('Removed Midway')
    const record = await importBook(pdfFile(bytes, 'removed.pdf'))
    await saveBook({ ...record, indexVersion: undefined })
    let removing: Promise<void> | null = null
    const job = ensureIndexed(record.id, p => { if (p.phase === 'reading' && p.done > 0 && !removing) removing = removeBook(record.id) })
    await expect(job).rejects.toThrow('This book was removed from the library.')
    await removing
    expect(await getBook(record.id)).toBeNull()
    expect(await getPages(record.id)).toEqual([])
    expect(await getAnchors(record.id)).toEqual([])
    expect((await listBooks()).some(book => book.id === record.id)).toBe(false)
    const again = await importBook(pdfFile(bytes, 'removed.pdf'))
    expect(again).toMatchObject({ id: record.id, indexed: true, indexVersion: INDEX_VERSION })
    expect((await getBookBytes(record.id))?.byteLength).toBe(bytes.byteLength)
    expect(await getPages(record.id)).toHaveLength(3)
  })

  it('puts back a missing file when the same PDF is imported again', async () => {
    const bytes = await splitBook('Lost File Book')
    const record = await importBook(pdfFile(bytes, 'lost.pdf'))
    // a book an older version left without its file
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('magic-whiteboard-textbooks-v1', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete(record.id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
    db.close()
    expect(await getBookBytes(record.id)).toBeNull()
    await importBook(pdfFile(bytes, 'lost.pdf'))
    expect((await getBookBytes(record.id))?.byteLength).toBe(bytes.byteLength)
  })
})

describe('reindexing', () => {
  it('knows which books need reading again', () => {
    const base = { indexed: true, indexVersion: INDEX_VERSION } as BookRecord
    expect(INDEX_VERSION).toBe(3)
    expect(needsReindex(base)).toBe(false)
    expect(needsReindex({ ...base, indexVersion: undefined })).toBe(true)
    expect(needsReindex({ ...base, indexVersion: 1 })).toBe(true)
    expect(needsReindex({ ...base, indexed: false })).toBe(true)
  })

  it('stitches a theorem that runs onto the next page', async () => {
    const record = await importBook(pdfFile(await splitBook(), 'split.pdf'))
    expect(record.indexVersion).toBe(INDEX_VERSION)
    const theorem = (await getAnchors(record.id)).find(anchor => anchor.kind === 'theorem' && anchor.label === '3.4')!
    expect(theorem.pageIndex).toBe(1)
    expect(theorem.continues?.pageIndex).toBe(2)
    const rest = theorem.continues!.box
    // from under the running header down to just above "Proof", taking in the drawn formula at 82..112 points
    expect(rest.y).toBeLessThan(82 / 792)
    expect(rest.y + rest.h).toBeGreaterThan(112 / 792)
    expect(rest.y + rest.h).toBeLessThanOrEqual(140 / 792)
  })

  it('reads an old book again from its stored bytes, keeping its name and dates and dropping stale items', async () => {
    const bytes = await splitBook('Old Version Book')
    const fresh = await importBook(pdfFile(bytes, 'old-version.pdf'))
    const items = await getAnchors(fresh.id)
    // what a version 1 index left behind: no version, a renamed title and an item the new finder does not see
    const old: BookRecord = { ...fresh, title: 'Old Version Book (my copy)', indexVersion: undefined, addedAt: 1000, openedAt: 2000 }
    await saveBook(old)
    const stale: Anchor = { ...items[0], id: `${fresh.id}#1:exercise:99`, kind: 'exercise', label: '99' }
    await putAnchors([stale])
    // a page picture made before; the book is updated in place, never removed and written again
    await putThumb(`${fresh.id}:2:240`, 'data:image/jpeg;base64,AAAA')
    const events: ImportProgress[] = []
    const first = ensureIndexed(fresh.id, p => events.push(p))
    expect(ensureIndexed(fresh.id)).toBe(first)
    const done = await first
    expect(done).toMatchObject({ id: fresh.id, title: 'Old Version Book (my copy)', fileName: 'old-version.pdf', addedAt: 1000, openedAt: 2000, indexed: true, indexVersion: INDEX_VERSION })
    expect(await getBook(fresh.id)).toEqual(done)
    const now = await getAnchors(fresh.id)
    expect(now.map(anchor => anchor.id).sort()).toEqual(items.map(anchor => anchor.id).sort())
    expect(now.find(anchor => anchor.label === '3.4')?.continues?.pageIndex).toBe(2)
    expect((await getBookBytes(fresh.id))?.byteLength).toBe(bytes.byteLength)
    expect((await getPages(fresh.id)).length).toBe(3)
    expect(await getThumb(`${fresh.id}:2:240`)).toBe('data:image/jpeg;base64,AAAA')
    expect(events.some(event => event.phase === 'reading')).toBe(true)
    expect(events.at(-1)).toEqual({ phase: 'saving', done: 3, total: 3 })
    // an up to date book is returned as it is
    const quiet: ImportProgress[] = []
    expect(await ensureIndexed(fresh.id, p => quiet.push(p))).toEqual(done)
    expect(quiet).toEqual([])
  })

  it('finishes an import that stopped half way, and importing an old book again updates it', async () => {
    const bytes = await splitBook('Interrupted Book')
    const id = await bookIdFor(bytes)
    await putBookBytes(id, bytes)
    await saveBook({ id, title: 'Interrupted Book', fileName: 'interrupted.pdf', size: bytes.byteLength, pageCount: 3, addedAt: 5, openedAt: 6, labels: [null, null, null], outline: [], cover: null, indexed: false, textPages: 0 })
    const done = await ensureIndexed(id)
    expect(done).toMatchObject({ id, indexed: true, indexVersion: INDEX_VERSION, addedAt: 5, fileName: 'interrupted.pdf' })
    expect((await getAnchors(id)).some(anchor => anchor.kind === 'theorem')).toBe(true)
    await saveBook({ ...done, indexVersion: 1 })
    const reopened = await importBook(pdfFile(bytes, 'interrupted.pdf'))
    expect(reopened.indexVersion).toBe(INDEX_VERSION)
    expect(reopened.openedAt).toBeGreaterThan(6)
    await expect(ensureIndexed('sha256:missing')).rejects.toThrow('This book is no longer in the library. Import it again.')
  })

  it('lets a lookup during an import wait for that import instead of reading the book twice', async () => {
    const bytes = await splitBook('Busy Book')
    const id = await bookIdFor(bytes)
    let joined: Promise<BookRecord> | null = null
    const extra: ImportProgress[] = []
    const importing = importBook(pdfFile(bytes, 'busy.pdf'), p => {
      // the teacher asks for a page while the book is still being read
      if (!joined && p.phase === 'reading' && p.done > 0) joined = ensureIndexed(id, q => extra.push(q))
    })
    const done = await importing
    expect(joined).not.toBeNull()
    expect(await joined).toEqual(done)
    expect(extra).toEqual([])
    expect(done).toMatchObject({ id, indexed: true, indexVersion: INDEX_VERSION })
  })
})
