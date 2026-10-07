import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { importBook } from '../src/library/indexer'
import { setPdfJsLoader } from '../src/library/pdfjs'
import { rankItems } from '../src/library/rank'
import type { RankRequest } from '../shared/ranking'
import { clampBox, cropScale, inkBounds, renderCrop, renderPage, renderThumb } from '../src/library/render'
import { LIBRARY_CONTEXT, forgetBookData, matchLibrary, problemImage } from '../src/library/resolve'
import { parseLibraryQuery } from '../src/library/search'
import { getThumb, removeBook, saveBook, touchBook } from '../src/library/store'
import type { BookRecord, LibraryMatch } from '../src/library/types'

// pdf.js draws in node through its optional @napi-rs/canvas dependency; skip drawing where it is missing
const canvas = await import('@napi-rs/canvas').catch(() => null)

type Text = [text: string, x: number, top: number, size?: number]

async function fixtureBook(title: string, extra: Text[] = []): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const body: Text[][] = [
    [[title, 72, 200, 28]],
    [['3.1 Defining the Derivative', 72, 70, 18], ['EXAMPLE 3.1', 80, 150], ['Finding a Slope', 72, 170], ['Find the slope of the secant line.', 72, 186], ['Solution', 86, 210]],
    [['EXAMPLE 3.2', 80, 70], ['The Slope of a Tangent Line Revisited', 72, 90], ['Use Equation 3.4 to find the slope of the tangent line at x = 3.', 72, 106],
      ['Solution', 86, 130], ['The slope is 6.', 72, 148], ['3.2 For f(x) = x squared, use a table to estimate the slope at 3.', 92, 230], ['After the checkpoint the text goes on.', 72, 280]],
    [['SECTION 3.1 EXERCISES', 100, 70, 14], ['48. f(x) = x + 1', 72, 130], ['49. f(x) = 2', 250, 130]],
    [['3.2 The Derivative as a Function', 72, 70, 18], ['The chain rule appears here once.', 72, 110]],
    [['SECTION 3.2 EXERCISES', 100, 70, 14], ['48. Find the derivative of the cube function.', 72, 100]],
    [['3.3 Differentiation Rules', 72, 70, 18], ['EXAMPLE 3.12', 80, 110], ['Using the Chain Rule', 72, 130], ['Differentiate a composite function with the chain rule.', 72, 146],
      ['Solution', 86, 170], ['Apply the chain rule twice.', 72, 188], ...extra],
  ]
  body.forEach((lines, index) => {
    const page = pdf.addPage([612, 792])
    if (index >= 1) {
      page.drawText(index % 2 ? `3.1 • Derivatives ${index + 9}` : `${index + 9} 3 • Derivatives`, { x: index % 2 ? 380 : 72, y: 792 - 36, size: 8, font })
      page.drawText('Access for free at example.org', { x: 72, y: 30, size: 8, font })
    }
    // a separator rule under the checkpoint, like the textbook's boxes
    if (index === 2) page.drawLine({ start: { x: 72, y: 792 - 255 }, end: { x: 540, y: 792 - 255 }, thickness: 1, color: rgb(0.2, 0.2, 0.2) })
    for (const [text, x, top, size = 10] of lines) page.drawText(text, { x, y: 792 - top - size * 0.8, size, font })
  })
  return pdf.save()
}

const file = (bytes: Uint8Array, name: string) => new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' })
let calc: BookRecord
const fetchMock = vi.fn<(url: unknown, init?: unknown) => Promise<Response>>(async () => { throw new TypeError('offline') })

beforeAll(async () => {
  setPdfJsLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs'), { standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` })
  vi.stubGlobal('fetch', fetchMock)
  if (canvas) vi.stubGlobal('document', { createElement: () => canvas.createCanvas(1, 1) })
  calc = await importBook(file(await fixtureBook('Calculus Volume 1'), 'calc.pdf'))
})

afterEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(async () => { throw new TypeError('offline') }) })
afterAll(() => { vi.unstubAllGlobals() })

async function match(text: string, openBookId: string | null = null, near: { bookId: string; pageIndex: number } | null = null) {
  return matchLibrary(parseLibraryQuery(text)!, { openBookId, near })
}
const sentBody = (call = 0) => JSON.parse(String((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body))

describe('matchLibrary', () => {
  it('finds printed pages exactly, with no ranking call', async () => {
    const result = await match('page 12') as LibraryMatch
    expect(result.confident).toBe(true)
    expect(result.source).toBe('exact')
    expect(result.book.id).toBe(calc.id)
    expect(result.ranked).toHaveLength(1)
    expect(result.ranked[0]).toMatchObject({ kind: 'page', pageIndex: 3, label: '12', p: 1, id: `${calc.id}#3:page` })
    expect(result.ranked[0].description.startsWith('Page 12: SECTION 3.1 EXERCISES')).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await match('page 99')).toEqual({ error: 'Page 99 is not in Calculus Volume 1.' })
  })

  it('inserts a named item right away', async () => {
    const result = await match('example 3.12') as LibraryMatch
    expect(result).toMatchObject({ confident: true, source: 'exact' })
    expect(result.ranked[0].anchor).toMatchObject({ kind: 'example', label: '3.12', pageIndex: 6 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('offers the practice items when several kinds share the label, ranked locally when the server is away', async () => {
    const result = await match('problem 3.2') as LibraryMatch
    expect(result.confident).toBe(false)
    expect(result.source).toBe('local')
    expect(result.ranked.map(candidate => candidate.anchor?.kind)).toEqual(['example', 'checkpoint'])
    expect(result.ranked[0].p).toBeGreaterThan(result.ranked[1].p)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/rank')
    expect(init.headers).toMatchObject({ 'X-Marginalia': '1', 'Content-Type': 'application/json' })
    expect(init.credentials).toBe('same-origin')
    const sent = JSON.parse(String(init.body))
    expect(sent.task).toBe('library')
    expect(sent.query).toBe('problem 3.2')
    expect(sent.context).toContain(LIBRARY_CONTEXT)
    expect(sent.context).toContain('Book structure (source data)')
    expect(sent.items.every((item: { text: string }) => item.text.length <= 300)).toBe(true)
  })

  it('uses the server ranking to order the choices, but never inserts when two kinds share the number', async () => {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const items = JSON.parse(String((init as RequestInit).body)).items as { id: string; text: string }[]
      const checkpoint = items.find(item => item.text.startsWith('Checkpoint'))!
      return new Response(JSON.stringify({ ranked: [{ id: checkpoint.id, p: 0.9 }], confident: true, source: 'jev', model: 'jev-1', ms: 20 }), { status: 200 })
    })
    const result = await match('3.2') as LibraryMatch
    expect(result).toMatchObject({ confident: false, source: 'jev' })
    expect(result.ranked.map(candidate => candidate.anchor?.kind)).toEqual(['checkpoint', 'example'])
  })

  it('still lets the ranker decide for a described item', async () => {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const items = JSON.parse(String((init as RequestInit).body)).items as { id: string; text: string }[]
      return new Response(JSON.stringify({ ranked: [{ id: items[0].id, p: 0.95 }], confident: true, source: 'jev', ms: 20 }), { status: 200 })
    })
    expect(await match('the chain rule example from the book')).toMatchObject({ confident: true, source: 'jev' })
  })

  it('prefers the repeated exercise in the chapter and section the teacher is on', async () => {
    const at = (pageIndex: number) => ({ bookId: calc.id, pageIndex })
    const first = async (near: { bookId: string; pageIndex: number } | null) => (await match('exercise 48', null, near) as LibraryMatch)
    const plain = await first(null)
    expect(plain.confident).toBe(false)
    expect(plain.ranked.map(candidate => candidate.pageIndex)).toEqual([3, 5])
    const there = await first(at(5))
    expect(there.confident).toBe(false)
    expect(there.ranked[0].pageIndex).toBe(5)
    expect(sentBody(1).context).toContain('The teacher is currently working in chapter 3, on page 14. When the same number is in several chapters, the teacher means the one in chapter 3.')
    expect(sentBody(1).context.length).toBeLessThanOrEqual(2000)
    expect((await first(at(3))).ranked[0].pageIndex).toBe(3)
    // near another book, or off the end of this one, changes nothing
    expect((await first({ bookId: 'sha256:other', pageIndex: 5 })).ranked[0].pageIndex).toBe(3)
    expect((await first(at(500))).ranked[0].pageIndex).toBe(3)
  })

  it('inserts right away when a section or chapter leaves one exercise', async () => {
    fetchMock.mockClear()
    for (const text of ['exercise 48 in section 3.2', 'section 3.2 exercise 48', 'exercise 48 in 3.2']) {
      const result = await match(text) as LibraryMatch
      expect(result).toMatchObject({ confident: true, source: 'exact' })
      expect(result.ranked[0].pageIndex).toBe(5)
    }
    expect((await match('exercise 48 in section 3.1') as LibraryMatch).ranked[0].pageIndex).toBe(3)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tells the teacher when an item or topic is missing', async () => {
    expect(await match('example 9.9')).toEqual({ error: 'Example 9.9 was not found in the local index for Calculus Volume 1. Try its name or the printed page number.' })
    expect(await match('problem 9.9')).toEqual({ error: 'Problem 9.9 was not found in the local index for Calculus Volume 1. Try its name or the printed page number.' })
    expect(await match('zebra stripes from the book')).toEqual({ error: 'No matching passage was found in Calculus Volume 1. Try a distinctive phrase, its chapter, or a page number.' })
  })

  it('finds topics through the page text', async () => {
    const result = await match('the chain rule example from the book') as LibraryMatch
    expect(result.ranked[0].anchor?.label).toBe('3.12')
  })

  it('uses chapter structure, not matching problem numbers, for opening pages', async () => {
    await saveBook({ ...calc, guide: { version: 1, sections: [{ title: 'Chapter 3 Derivatives', pageIndex: 1, depth: 0, source: 'outline' }], itemCounts: {}, exercisePages: [], unreadablePages: [], notes: [] } })
    forgetBookData(calc.id)
    try {
      const result = await match('pull the first page of chapter 3', calc.id) as LibraryMatch
      expect(result).toMatchObject({ confident: true, source: 'exact' })
      expect(result.ranked[0]).toMatchObject({ kind: 'page', pageIndex: 1 })
    } finally { await saveBook(calc); forgetBookData(calc.id) }
  })
  it('never swaps a named book that is not in the library for another one', async () => {
    const result = await match('page 12 from the chemistry book') as { error: string; books: BookRecord[] }
    expect(result.error).toBe('Which textbook do you mean by "chemistry"? Choose one below.')
    expect(result.books.map(book => book.id)).toEqual([calc.id])
    expect(await match('problem 3.2 in physics', calc.id)).toMatchObject({ error: 'Which textbook do you mean by "physics"? Choose one below.' })
    // words that are not book names still work
    expect(await match('page 12 in the new book')).toMatchObject({ confident: true, book: { id: calc.id } })
    expect(await match('example 3.12 in pencil')).toMatchObject({ confident: true, source: 'exact' })
  })

  it('asks rather than guessing from recency, and follows an unambiguous open or named book', async () => {
    const physics = await importBook(file(await fixtureBook('University Physics', [['Physics only line', 72, 400]]), 'physics.pdf'))
    try {
      // Recency alone must not select the wrong textbook.
      expect(await match('page 12')).toMatchObject({ error: 'Which textbook do you mean? Choose one below.' })
      await saveBook({ ...physics, openedAt: calc.openedAt })
      await saveBook(calc)
      const unsure = await match('page 12') as { error: string; books: BookRecord[] }
      expect(unsure.error).toBe('Which textbook do you mean? Choose one below.')
      expect(unsure.books.map(book => book.id).sort()).toEqual([calc.id, physics.id].sort())
      expect((await match('page 12', physics.id) as LibraryMatch).book.id).toBe(physics.id)
      expect((await match('page 12 from the calculus book', physics.id) as LibraryMatch).book.id).toBe(calc.id)
      expect((await match('page 12 in physics') as LibraryMatch).book.id).toBe(physics.id)
    } finally {
      await removeBook(physics.id)
      forgetBookData(physics.id)
    }
  })

  it('asks for a re index of an unfinished or older book instead of using another one', async () => {
    const other = await importBook(file(await fixtureBook('University Physics'), 'physics.pdf'))
    try {
      await saveBook({ ...calc, indexed: false })
      const reindex = { error: 'This book needs a quick update. Opening it now.', code: 'reindex', bookId: calc.id }
      expect(await match('page 12', calc.id)).toEqual(reindex)
      expect(await match('problem 3.2', calc.id)).toEqual(reindex)
      expect(await match('page 12 from the calculus book')).toEqual(reindex)
      // an index made by an older version: pages still work, items are read again first
      await saveBook({ ...calc, indexVersion: undefined })
      expect(await match('page 12', calc.id)).toMatchObject({ confident: true, book: { id: calc.id } })
      expect(await match('example 3.12', calc.id)).toEqual(reindex)
    } finally {
      await removeBook(other.id); forgetBookData(other.id)
      await saveBook(calc); await touchBook(calc.id)
    }
  })

  it('uses the file page when no printed page has the number, and says so', async () => {
    const result = await match('page 5') as LibraryMatch
    expect(result).toMatchObject({ confident: true, source: 'exact', note: 'No printed page 5, added file page 5.' })
    expect(result.ranked[0].pageIndex).toBe(4)
    expect((await match('page 12') as LibraryMatch).note).toBeUndefined()
    expect(await match('page 8')).toEqual({ error: 'Page 8 is not in Calculus Volume 1.' })
  })

  it('picks the repeated page number nearest the teacher, else offers each one', async () => {
    const packet: BookRecord = { ...calc, id: 'sha256:packet', title: 'Unit Packet', fileName: 'packet.pdf', labels: [null, '1', '2', '3', '1', '2', '3'], openedAt: Date.now() }
    await saveBook(packet)
    try {
      const near = await match('page 2', packet.id, { bookId: packet.id, pageIndex: 5 }) as LibraryMatch
      expect(near).toMatchObject({ confident: true, book: { id: packet.id } })
      expect(near.ranked.map(candidate => candidate.pageIndex)).toEqual([5])
      expect((await match('page 2', packet.id, { bookId: packet.id, pageIndex: 1 }) as LibraryMatch).ranked[0].pageIndex).toBe(2)
      const unsure = await match('page 2', packet.id) as LibraryMatch
      expect(unsure.confident).toBe(false)
      expect(unsure.ranked.map(candidate => candidate.pageIndex)).toEqual([2, 5])
    } finally {
      await removeBook(packet.id); forgetBookData(packet.id); await touchBook(calc.id)
    }
  })

  it('reads "the math book" as the book of that subject, the open one or the only one', async () => {
    expect(await match('page 12 in my math textbook')).toMatchObject({ confident: true, book: { id: calc.id } })
    expect(await match('page 12 in the science book')).toMatchObject({ error: 'Which textbook do you mean by "science"? Choose one below.' })
    const physics: BookRecord = { ...calc, id: 'sha256:physics', title: 'University Physics', fileName: 'physics.pdf', openedAt: Date.now() }
    const notes: BookRecord = { ...calc, id: 'sha256:notes', title: 'Unit 4 Notes', fileName: 'notes.pdf', openedAt: Date.now() }
    await saveBook(physics)
    try {
      expect(await match('page 12 in the math book', physics.id)).toMatchObject({ book: { id: calc.id } })
      expect(await match('page 12 in the science book')).toMatchObject({ book: { id: physics.id } })
      // two books with no subject in their titles: the open one, else ask
      await removeBook(physics.id)
      await saveBook({ ...calc, title: 'Unit 3 Notes' }); await saveBook(notes)
      expect(await match('page 12 in the math book', notes.id)).toMatchObject({ error: 'Which book? Say its title or open it from the Library.' })
      expect(await match('page 12 in the math book')).toMatchObject({ error: 'Which book? Say its title or open it from the Library.' })
    } finally {
      await removeBook(physics.id); await removeBook(notes.id); forgetBookData(physics.id); forgetBookData(notes.id)
      await saveBook(calc); await touchBook(calc.id)
    }
  })

  it('says when a section the book has holds no such item instead of offering other sections', async () => {
    expect(await match('exercise 48 in section 3.3')).toEqual({ error: 'The local index did not identify exercise 48 in section 3.3. Try its printed number or page, or open the chapter and crop it visually.' })
    expect(await match('problem 49 in section 3.2')).toEqual({ error: 'The local index did not identify problem 49 in section 3.2. Try its printed number or page, or open the chapter and crop it visually.' })
    expect(await match('exercise 48 in chapter 3')).toMatchObject({ book: { id: calc.id } })
    // a section or chapter the book does not show still offers what it has
    expect(await match('exercise 48 in section 3.9')).toMatchObject({ confident: false })
    expect(await match('exercise 48 in chapter 4')).toMatchObject({ confident: false })
  })

  it('imports chapter-end decimal problems and resolves spoken local numbers to the correct crop', async () => {
    const pdf = await PDFDocument.create()
    pdf.setTitle('Scattering Reference Fixture')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const content: Text[][] = [
      [['Chapter 6 Scattering', 72, 70, 18], ['6.1 Foundations', 72, 110, 16], ['A synthetic chapter for testing numbered problems.', 72, 150]],
      [['Problems', 250, 60, 14], ['6.1 Consider a one-dimensional model.', 72, 120], ['Find its boundary conditions.', 90, 145]],
      [['Problems', 250, 60, 14], ['6.2 Prove', 72, 110], ['A = B + C', 200, 160], ['in each of the following ways.', 90, 210],
        ['a. By integrating the supplied expression.', 90, 235], ['b. By applying the stated identity.', 90, 260],
        ['6.3 Estimate the radius of the sample.', 72, 380]],
      [['Chapter 7 Applications', 72, 70, 18], ['7.1 Foundations', 72, 110, 16], ['7.2 Prove a different identity.', 72, 200]],
    ]
    for (const lines of content) {
      const page = pdf.addPage([612, 792])
      for (const [text, x, top, size = 10] of lines) page.drawText(text, { x, y: 792 - top - size * .8, size, font })
    }
    const book = await importBook(file(await pdf.save(), 'scattering-fixture.pdf'))
    try {
      for (const phrase of ['question 2 in chapter 6', 'problem 6.2', 'chapter 6 exercise 2']) {
        const found = await match(phrase, book.id) as LibraryMatch
        expect(found).toMatchObject({ confident: true, source: 'exact' })
        expect(found.ranked[0].anchor).toMatchObject({ label: '6.2', pageIndex: 2 })
        const crop = found.ranked[0].anchor!.box
        expect(crop.y).toBeLessThan(110 / 792)
        expect(crop.y + crop.h).toBeGreaterThan(260 / 792)
        expect(crop.y + crop.h).toBeLessThan(380 / 792)
      }
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await removeBook(book.id); forgetBookData(book.id); await touchBook(calc.id) }
  })

  it('finds the last exercises of a section on the page where the next section starts', async () => {
    const pdf = await PDFDocument.create()
    pdf.setTitle('Boundary Calculus')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const pages: Text[][] = [
      [['Boundary Calculus', 72, 200, 28]],
      [['1.1 Review of Functions', 72, 70, 18], ['Functions take inputs to outputs.', 72, 110]],
      [['SECTION 1.1 EXERCISES', 100, 70, 14], ['56. f(x) = x + 1', 72, 130], ['57. f(x) = 2x', 72, 400]],
      [['58. f(x) = x squared', 72, 70], ['59. f(x) = 3', 72, 110], ['1.2 Basic Classes of Functions', 72, 300, 18], ['Lines have a constant slope.', 72, 340]],
    ]
    for (const lines of pages) {
      const page = pdf.addPage([612, 792])
      for (const [text, x, top, size = 10] of lines) page.drawText(text, { x, y: 792 - top - size * 0.8, size, font })
    }
    const book = await importBook(file(await pdf.save(), 'boundary.pdf'))
    try {
      const found = await matchLibrary(parseLibraryQuery('exercise 58 in section 1.1')!, { openBookId: book.id, near: null })
      expect(found).toMatchObject({ book: { id: book.id } })
      expect((found as LibraryMatch).ranked[0]).toMatchObject({ pageIndex: 3, anchor: { label: '58' } })
      expect(await matchLibrary(parseLibraryQuery('exercise 58 in chapter 1')!, { openBookId: book.id, near: null })).toMatchObject({ book: { id: book.id } })
      expect(await matchLibrary(parseLibraryQuery('exercise 60 in section 1.1')!, { openBookId: book.id, near: null })).toEqual({ error: 'The local index did not identify exercise 60 in section 1.1. Try its printed number or page, or open the chapter and crop it visually.' })
    } finally {
      await removeBook(book.id); forgetBookData(book.id); await touchBook(calc.id)
    }
  })

  it('reads "the page I am looking at" as the page the teacher is on', async () => {
    const query = { kind: 'topic' as const, terms: 'the page I am looking at', raw: 'the page I am looking at' }
    const result = await matchLibrary(query, { openBookId: calc.id, near: { bookId: calc.id, pageIndex: 4 } }) as LibraryMatch
    expect(result).toMatchObject({ confident: true, source: 'exact' })
    expect(result.ranked[0]).toMatchObject({ kind: 'page', pageIndex: 4, label: '13' })
  })

  it('reports an empty library', async () => {
    await removeBook(calc.id)
    try { expect(await match('page 12')).toEqual({ error: 'The library is empty. Import a textbook first.' }) }
    finally { forgetBookData(calc.id); calc = await importBook(file(await fixtureBook('Calculus Volume 1'), 'calc.pdf')) }
  })
})

describe('rankItems', () => {
  const req: RankRequest = { task: 'library', query: 'problem 1', items: [{ id: 'a', text: 'A', features: { exactLabel: 1, kindMatch: 1 } }, { id: 'b', text: 'B', features: { exactLabel: 1 } }] }

  it('falls back to the local ranker on any failure', async () => {
    for (const reply of [async () => new Response('nope', { status: 500 }), async () => new Response('not json', { status: 200 }),
      async () => new Response(JSON.stringify({ ranked: [{ id: 'zzz', p: 1 }], confident: true, source: 'jev', ms: 1 }), { status: 200 })]) {
      fetchMock.mockImplementation(reply)
      const result = await rankItems(req)
      expect(result).toMatchObject({ source: 'local', note: 'offline' })
      expect(result.ranked.map(entry => entry.id)).toEqual(['a', 'b'])
    }
  })

  it('keeps every item, trims what it sends and skips the call when there is nothing to rank', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ranked: [{ id: 'b', p: 0.7 }], confident: false, source: 'jev', ms: 3 }), { status: 200 }))
    const result = await rankItems({ ...req, query: 'q'.repeat(900), items: [...req.items, { id: 'c', text: 't'.repeat(900) }] })
    expect(result.ranked.map(entry => entry.id)).toEqual(['b', 'a', 'c'])
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(sent.query).toHaveLength(500)
    expect(sent.items[2].text).toHaveLength(400)
    fetchMock.mockClear()
    expect(await rankItems({ ...req, items: [] })).toMatchObject({ ranked: [], confident: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('crop helpers', () => {
  it('clamps boxes and picks a crisp scale', () => {
    expect(clampBox({ x: -1, y: 0.5, w: 3, h: 0 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.01 })
    expect(clampBox({ x: 0.95, y: 0.95, w: 0.2, h: 0.2 })).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 })
    expect(clampBox({ x: Number.NaN, y: 0, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(cropScale({ width: 612, height: 792 }, { x: 0, y: 0, w: 0.5, h: 0.1 }, 1400)).toBe(4)
    expect(cropScale({ width: 612, height: 792 }, { x: 0, y: 0, w: 1, h: 1 }, 1400)).toBeCloseTo(1400 / 612, 5)
    expect(cropScale({ width: 5000, height: 5000 }, { x: 0, y: 0, w: 1, h: 1 }, 20000)).toBeLessThanOrEqual(Math.sqrt(16e6 / 25e6))
  })

  it('trims blank space, a separator rule with the next item under it, and ink cut by the edge', () => {
    const width = 100, height = 120, data = new Uint8ClampedArray(width * height * 4).fill(255)
    const paint = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([20, 20, 20, 255], (y * width + x) * 4)
    }
    paint(5, 60, 10, 20) // text
    paint(5, 40, 30, 40) // more text
    paint(0, 100, 70, 72) // rule
    paint(0, 15, 72, 80) // next item's label under the rule
    expect(inkBounds(data, width, height, 4)).toEqual({ top: 0, w: 64, h: 44 })
    const cut = new Uint8ClampedArray(width * height * 4).fill(255)
    for (let y = 10; y < 20; y++) for (let x = 5; x < 50; x++) cut.set([0, 0, 0, 255], (y * width + x) * 4)
    for (let y = 112; y < 120; y++) for (let x = 5; x < 12; x++) cut.set([0, 0, 0, 255], (y * width + x) * 4)
    expect(inkBounds(cut, width, height, 4)).toEqual({ top: 0, w: 54, h: 24 })
    const blank = new Uint8ClampedArray(width * height * 4).fill(255)
    expect(inkBounds(blank, width, height)).toEqual({ top: 0, w: width, h: height })
    paint(0, 100, 0, 2) // a rule on the top edge
    expect(inkBounds(data, width, height, 4).top).toBe(2)
  })
})

describe.skipIf(!canvas)('drawing pages', () => {
  it('renders whole pages as JPEG and items as trimmed PNG crops', async () => {
    const page = await renderPage(calc.id, 2, { maxEdge: 600 })
    expect(page.mimeType).toBe('image/jpeg')
    expect(page.src.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Math.max(page.w, page.h)).toBe(600)
    const result = await match('checkpoint 3.2') as LibraryMatch
    const box = result.ranked[0].anchor!.box
    const image = await problemImage(result.ranked[0])
    expect(image.mimeType).toBe('image/png')
    expect(image.src.startsWith('data:image/png;base64,')).toBe(true)
    // the checkpoint text is short and the rule under it is dropped
    const full = await renderCrop(calc.id, 2, box)
    expect(image.w).toBeLessThan(full.w)
    expect(image.h).toBeLessThan(full.h)
    expect(image.h).toBeLessThan(0.05 * 792 * cropScale({ width: 612, height: 792 }, box))
    const pageImage = await problemImage((await match('page 12') as LibraryMatch).ranked[0])
    expect(pageImage.mimeType).toBe('image/jpeg')
    await expect(renderPage(calc.id, 99)).rejects.toThrow('That page is not in this book.')
    await expect(renderPage('sha256:missing', 0)).rejects.toThrow('This book is no longer in the library. Import it again.')
  })

  it('caches thumbnails and made a cover on import', async () => {
    expect(calc.cover?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const thumb = await renderThumb(calc.id, 1, 120)
    expect(thumb.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(await getThumb(`${calc.id}:1:120`)).toBe(thumb)
    expect(await renderThumb(calc.id, 1, 120)).toBe(thumb)
  })
})
