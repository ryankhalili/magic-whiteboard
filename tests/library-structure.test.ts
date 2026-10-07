import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { detectAnchors } from '../src/library/anchors'
import { contentsRows, isContentsPage, repeatedMargins, isRepeatedMargin } from '../src/library/structure'
import { importBook, ensureIndexed, INDEX_VERSION } from '../src/library/indexer'
import { setPdfJsLoader } from '../src/library/pdfjs'
import { getAnchors, removeBook, saveBook, putAnchors } from '../src/library/store'
import { forgetBookData, matchLibrary } from '../src/library/resolve'
import { parseLibraryQuery } from '../src/library/search'
import type { TextLine } from '../src/library/types'

const line = (text: string, x = .2, y = .1, size = .014, w = .65): TextLine => ({ text, size, box: { x, y, w, h: size * 1.1 } })
beforeAll(() => setPdfJsLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs'), { standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }))

describe('publisher-aware textbook structure', () => {
  it('joins a contents title to its separately positioned page number', () => {
    const lines = [line('ix', .14, .03, .014, .02), line('Contents', .5, .03, .014, .1),
      line('5.2 Perturbation Theory', .23, .2, .014, .4), line('300', .85, .2, .014, .03)]
    expect(contentsRows(lines)).toContain('5.2 Perturbation Theory 300')
    expect(isContentsPage({ text: lines.map(l => l.text).join('\n'), lines })).toBe(true)
  })

  it('excludes repeated margin titles without dropping their body heading', () => {
    const header = line('5.2 Perturbation Theory', .35, .039)
    const repeated = repeatedMargins([{ lines: [header] }, { lines: [header] }])
    expect(isRepeatedMargin(header, repeated)).toBe(true)
    expect(isRepeatedMargin({ ...header, box: { ...header.box, y: .3 } }, repeated)).toBe(false)
  })

  it('does not turn a one-off running head or scientific decimal into a question', () => {
    const result = detectAnchors('b', { index: 1, exerciseMode: false, lines: [
      line('301', .14, .039, .014, .03), line('5.2 Perturbation Theory', .35, .039, .014, .5),
      line('Some ordinary body text.', .2, .1), line('2.1 x 10 cm', .4, .3),
    ] }, .014)
    expect(result.anchors).toEqual([])
  })

  it.each([['Problems', 'problem'], ['Exercises', 'exercise'], ['Questions', 'question']] as const)('uses the printed %s category across pages', (heading, kind) => {
    const first = detectAnchors('b', { index: 0, exerciseMode: false, lines: [line(heading, .3, .1, .021), line('5.1 Consider a model.', .2, .2)] }, .014)
    const second = detectAnchors('b', { ...first, index: 1, lines: [line('5.2 Find the result.', .2, .1), line('2 .', .6, .2), line('5.3 Prove the identity.', .2, .3)] }, .014)
    expect(second.anchors.map(a => [a.kind, a.label])).toEqual([[kind, '5.2'], [kind, '5.3']])
  })

  it('recognizes explicit checkpoints but does not invent them for standalone prompts', () => {
    const found = detectAnchors('b', { index: 0, exerciseMode: false, lines: [line('Checkpoint 2.1 Find the limit.'), line('3.2 Prove the identity.', .2, .4)] }, .014)
    expect(found.anchors.map(a => [a.kind, a.label])).toEqual([['checkpoint', '2.1'], ['question', '3.2']])
  })

  it('reindexes stale false matches and resolves the actual chapter problem with a complete crop', async () => {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    const contents: [string, number, number, number?][][] = [
      [['Contents', 300, 30], ['5.2 Perturbation Theory', 120, 110], ['300', 530, 110], ['Problems', 120, 170], ['359', 530, 170]],
      [['300', 75, 30], ['5.2 Perturbation Theory', 150, 140, 16], ['We introduce the theory.', 120, 180]],
      [['301', 75, 30], ['5.2 Perturbation Theory', 240, 30], ['Some body text here.', 120, 100]],
      [['302', 75, 30], ['5.2 Perturbation Theory', 240, 30], ['More body text here.', 120, 100]],
      [['358', 75, 30], ['Problems', 280, 400, 16], ['5.1 Consider a model.', 120, 450]],
      [['359', 75, 30], ['Problems', 300, 30], ['5.2 A model has a boundary at x = L.', 120, 100],
        ['Find the shift as a function of n.', 150, 125], ['5.3 Consider another model.', 120, 190]],
    ]
    for (const rows of contents) {
      const page = pdf.addPage([612, 792])
      for (const [text, x, top, size = 10] of rows) page.drawText(text, { font, x, y: 792 - top - .8 * size, size })
    }
    let book = await importBook(new File([await pdf.save() as Uint8Array<ArrayBuffer>], 'structure-fixture.pdf', { type: 'application/pdf' }))
    try {
      const actual = (await getAnchors(book.id)).find(a => a.kind === 'problem' && a.label === '5.2')!
      await putAnchors([{ ...actual, id: `${book.id}#0:checkpoint:5.2`, kind: 'checkpoint', pageIndex: 0 }])
      await saveBook({ ...book, indexVersion: INDEX_VERSION - 1 })
      const query = parseLibraryQuery('question 2 from chapter 5')!
      expect(await matchLibrary(query, { openBookId: book.id })).toMatchObject({ code: 'reindex' })
      book = await ensureIndexed(book.id)
      const anchors = await getAnchors(book.id)
      expect(anchors.some(a => a.kind === 'checkpoint')).toBe(false)
      expect(anchors.some(a => a.pageIndex === 0)).toBe(false)
      expect(book.guide?.sections).toContainEqual(expect.objectContaining({ title: '5.2 Perturbation Theory', pageIndex: 1, source: 'contents' }))
      for (const request of ['question 2 from chapter 5', 'problem 5.2', 'chapter 5 exercise 2']) {
        const result = await matchLibrary(parseLibraryQuery(request)!, { openBookId: book.id })
        expect(result).toMatchObject({ confident: true, source: 'exact', ranked: [{ anchor: { kind: 'problem', label: '5.2', pageIndex: 5 } }] })
        if ('error' in result) throw new Error(result.error)
        const crop = result.ranked[0].anchor!.box
        expect(crop.y + crop.h).toBeGreaterThan(135 / 792)
        expect(crop.y + crop.h).toBeLessThan(190 / 792)
      }
    } finally { await removeBook(book.id); forgetBookData(book.id) }
  })
})
