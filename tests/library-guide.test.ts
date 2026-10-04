import { describe, expect, it } from 'vitest'
import { detectAnchors } from '../src/library/anchors'
import { bookGuideText, buildBookGuide, getBookGuideContext, guidePageScopes } from '../src/library/guide'
import { buildCandidates, certainTopic, parseLibraryQuery, searchPages } from '../src/library/search'
import type { Anchor, BookRecord, PageRecord, TextLine } from '../src/library/types'

const book: BookRecord = { id: 'test', title: 'Calculus', fileName: 'calculus.pdf', size: 10, pageCount: 8, addedAt: 1, openedAt: 1, labels: ['i', 'ii', '1', '2', '3', '4', '5', '6'], outline: [], cover: null, indexed: true, textPages: 7 }
const line = (text: string, y = .1, size = .018): TextLine => ({ text, size, box: { x: .1, y, w: .8, h: .02 } })
const page = (index: number, text: string, lines: TextLine[] = []): PageRecord => ({ bookId: book.id, index, text, lines, label: book.labels[index], width: 612, height: 792 })
const item = (kind: Anchor['kind'], label: string, heading: string, pageIndex = 3): Anchor => ({ id: `${book.id}#${pageIndex}:${kind}:${label}`, bookId: book.id, pageIndex, kind, label, heading, snippet: heading, box: { x: .1, y: .2, w: .8, h: .25 } })

describe('durable local book guide', () => {
  it('resolves a printed contents page to file pages without inventing offsets', () => {
    const contents = 'Contents\nChapter 1 Limits ........ 1\n1.1 Continuous functions ........ 2\nExercises ........ 4\nChapter 2 Derivatives ........ 6'
    const pages = [page(0, contents, contents.split('\n').map(text => line(text)))]
    const guide = buildBookGuide(book, pages, [item('exercise', '1', '1. Find the limit', 5)])
    expect(guide.sections.map(entry => [entry.title, entry.pageIndex])).toEqual([
      ['Chapter 1 Limits', 2], ['1.1 Continuous functions', 3], ['Exercises', 5], ['Chapter 2 Derivatives', 7],
    ])
    expect(guide.exercisePages).toEqual([5])
    expect(guide.itemCounts.exercise).toBe(1)
    const saved = { ...book, guide }
    expect(bookGuideText(saved)).toContain('printed p. 4 (file page 6)')
    expect(getBookGuideContext(saved)).toContain('Printed page labels may differ')
    expect(guidePageScopes(saved, 8).chapters).toEqual([null, null, 1, 1, 1, 1, 1, 2])
  })

  it('does not treat a chapter listed in the TOC as starting on the TOC page', () => {
    const contents = 'Contents\nChapter 2 Calculus ........ 2\nChapter 3 Applications 3'
    const guide = buildBookGuide(book, [
      page(0, contents, contents.split('\n').map(text => line(text))),
      page(3, 'Chapter 2 Calculus', [line('Chapter 2 Calculus')]),
    ], [])
    expect(guide.sections.map(entry => [entry.title, entry.pageIndex])).toEqual([
      ['Chapter 2 Calculus', 3], ['Chapter 3 Applications', 4],
    ])
    expect(guidePageScopes({ ...book, guide }, 8).chapters).toEqual([null, null, null, 2, 3, 3, 3, 3])
  })

  it('skips dotted-leader chapter references even outside the initial TOC scan', () => {
    const text = 'Chapter 2 Calculus ........ 2\nChapter 3 Applications · · · 3\nChapter 4 Analysis'
    const guide = buildBookGuide(book, [page(7, text, text.split('\n').map(value => line(value)))], [])
    expect(guide.sections).toEqual([{ title: 'Chapter 4 Analysis', pageIndex: 7, depth: 0, source: 'heading' }])
  })

  it('does not guess missing or ambiguous printed TOC destinations', () => {
    const guide = buildBookGuide({ ...book, labels: ['i', 'ii', '1', '1', '3', '4', '5', '6'] }, [page(0, 'Contents\nChapter 1 Limits .... 1\nMissing chapter .... 99')], [])
    expect(guide.sections).toEqual([])
  })

  it('stores coverage limitations and keeps model context bounded', () => {
    const outline = Array.from({ length: 600 }, (_, i) => ({ title: `Chapter ${i + 1} Long mathematical textbook title`, pageIndex: i % 8, depth: 0 }))
    const guide = buildBookGuide({ ...book, outline }, [page(0, ''), page(1, 'A full page of searchable textbook text')], [])
    expect(guide.unreadablePages).toEqual([0])
    expect(guide.notes.join(' ')).toContain('OCR is not enabled')
    expect(getBookGuideContext({ ...book, guide }, 6).length).toBeLessThanOrEqual(2500)
  })
})

describe('textbook retrieval regressions', () => {
  it.each(['Mean Value Theorem', 'MEAN VALUE THEOREM', "Rolle’s Theorem", 'Fundamental Theorem of Calculus', 'Theorem of Pythagoras'] )('detects the unnumbered heading %s', heading => {
    const found = detectAnchors(book.id, { index: 3, exerciseMode: false, lines: [line(heading), line('Let f be continuous on the closed interval.', .14, .012), line('Then there is a point with the required derivative.', .18, .012)] }, .012)
    expect(found.anchors).toContainEqual(expect.objectContaining({ kind: 'theorem', label: '', heading: expect.stringContaining(heading) }))
  })

  it('does not turn sentence references into named theorem headings', () => {
    const found = detectAnchors(book.id, { index: 3, exerciseMode: false, lines: [line('We now apply the Mean Value Theorem', .1, .012), line('to obtain the desired conclusion.', .13, .012)] }, .012)
    expect(found.anchors.some(anchor => anchor.kind === 'theorem')).toBe(false)
  })

  it('finds compact abbreviations and reverse-numbered theorem headings', () => {
    expect(parseLibraryQuery('show thm.2.4')).toMatchObject({ kind: 'item', itemKind: 'theorem', label: '2.4' })
    const found = detectAnchors(book.id, { index: 3, exerciseMode: false, lines: [line('2.4 Theorem (Mean Value)'), line('Let f be continuous on the interval.', .14, .012)] }, .012)
    expect(found.anchors[0]).toMatchObject({ kind: 'theorem', label: '2.4' })
  })

  it('retrieves a uniquely named theorem without depending on a remote ranker', () => {
    const query = parseLibraryQuery('pull up the mean value theorem')!
    expect(query.kind).toBe('topic')
    const anchors = [item('theorem', '', 'Mean Value Theorem'), item('example', '1', 'A Mean Value Theorem example', 4)]
    const pages = anchors.map(anchor => page(anchor.pageIndex, anchor.heading))
    expect(certainTopic(query, buildCandidates(query, book, pages, anchors))?.anchor?.heading).toBe('Mean Value Theorem')
    const duplicate = { ...anchors[0], id: 'other', pageIndex: 6 }
    expect(certainTopic(query, buildCandidates(query, book, [...pages, page(6, duplicate.heading)], [...anchors, duplicate]))).toBeNull()
  })

  it('retrieves a named diagram as an item and respects bookmark-only chapter scopes', () => {
    const scoped = { ...book, outline: [{ title: 'Chapter 1 Cells', pageIndex: 1, depth: 0 }, { title: 'Chapter 2 Energy', pageIndex: 4, depth: 0 }] }
    const anchors = [item('figure', '2.1', 'Figure 2.1 Cellular respiration cycle', 5), item('figure', '1.1', 'Cellular respiration cycle', 2)]
    const pages = anchors.map(anchor => page(anchor.pageIndex, anchor.heading))
    const query = parseLibraryQuery('find the cellular respiration diagram in chapter 2')!
    const candidates = buildCandidates(query, scoped, pages, anchors)
    expect(certainTopic(query, candidates)?.pageIndex).toBe(5)
  })

  it('normalizes ligatures and wrapped words and shows the matched passage', () => {
    const text = `${'Unrelated preface. '.repeat(50)}\nThe diﬀerentiation rule applies to photosyn-\nthesis. This process is important.`
    const pages = [page(3, text)]
    expect(searchPages(pages, 'differentiation photosynthesis')[0].index).toBe(3)
    const query = parseLibraryQuery('differentiation in the book')!
    const candidates = buildCandidates(query, book, pages, [])
    expect(candidates[0].description).toContain('rule applies')
    expect(candidates[0].description.length).toBeLessThanOrEqual(300)
  })

  it('offers a real contents destination for a scanned book without pretending to read it', () => {
    const scanned = { ...book, textPages: 0, outline: [{ title: 'Photosynthesis', pageIndex: 4, depth: 0 }] }
    const candidates = buildCandidates(parseLibraryQuery('photosynthesis from the book')!, scanned, [page(4, '')], [])
    expect(candidates[0]).toMatchObject({ kind: 'page', pageIndex: 4 })
    expect(candidates[0].description).toContain('contents heading; inspect the page')
  })
})
