import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../src/library/store', () => ({ getPages: vi.fn(async () => []), getAnchors: vi.fn(async () => []) }))
vi.mock('../src/library/render', () => ({ renderPage: vi.fn(async () => ({ src: 'data:image/jpeg;base64,AA==', w: 10, h: 13, mimeType: 'image/jpeg' })) }))

import { ImportDialog, defaultImportTarget, formatBytes, importProgressText, progressFraction } from '../src/library/ImportDialog'
import { LibraryPanel, bookDescription, followStep, openedText, previewTarget, PREVIEW_SIZE } from '../src/library/LibraryPanel'
import { ReferencePanel, anchorCandidate, anchorTitle, anchoredScroll, candidateTitle, clampPanel, defaultPanelRect, layoutPages, normalizeCrop, pageAt, pageFromQuery, pageLabelText, panelHits, renderEdge, safeAspect, visibleRange, DEFAULT_ASPECT, PANEL_MIN } from '../src/library/ReferencePanel'
import type { Anchor, BookRecord, RankedCandidate } from '../src/library/types'

const labels = Array.from({ length: 769 }, (_, i) => i < 7 ? ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'][i] : String(i - 7))
labels[0] = null as unknown as string
const book: BookRecord = { id: 'sha256:abc', title: 'Calculus Volume 1', fileName: 'calculus-volume-1.pdf', size: 52_104_540, pageCount: 769, addedAt: 1, openedAt: Date.now(), labels, outline: [], cover: 'data:image/jpeg;base64,AA==', indexed: true, textPages: 760 }
const anchor: Anchor = { id: 'sha256:abc#199:example:3.2', bookId: book.id, pageIndex: 199, kind: 'example', label: '3.2', heading: 'EXAMPLE 3.2 Finding a Derivative', box: { x: .1, y: .3, w: .8, h: .25 }, snippet: 'Find the derivative' }
const noop = () => {}

describe('preview follower', () => {
  it('moves 15 percent of the way each frame and settles exactly on the target', () => {
    const step = followStep({ x: 0, y: 0 }, { x: 100, y: -200 })
    expect(step.x).toBeCloseTo(15); expect(step.y).toBeCloseTo(-30)
    let point = { x: 0, y: 0 }, frames = 0
    while ((point.x !== 100 || point.y !== -200) && frames < 200) { point = followStep(point, { x: 100, y: -200 }); frames++ }
    expect(point).toEqual({ x: 100, y: -200 })
    expect(frames).toBeGreaterThan(10); expect(frames).toBeLessThan(60)
  })
  it('treats a bad factor as the default and never overshoots', () => {
    expect(followStep({ x: 0, y: 0 }, { x: 10, y: 0 }, Number.NaN).x).toBeCloseTo(1.5)
    expect(followStep({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: 10, y: 0 })
  })
  it('puts the card beside the list, level with the cursor, so it never hides the rows', () => {
    const view = { w: 1440, h: 900 }, list = { left: 1003, right: 1421 }
    const a = previewTarget({ x: 1100, y: 200 }, view, list), b = previewTarget({ x: 1300, y: 260 }, view, list)
    expect(a.x + PREVIEW_SIZE.w).toBeLessThanOrEqual(list.left - 8)
    expect(b.x + PREVIEW_SIZE.w).toBeLessThanOrEqual(list.left - 8)
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.y - a.y).toBe(60)
    const leftList = { left: 10, right: 430 }
    expect(previewTarget({ x: 200, y: 200 }, view, leftList).x).toBeGreaterThanOrEqual(leftList.right + 8)
    const wide = previewTarget({ x: 200, y: 200 }, { w: 400, h: 800 }, { left: 10, right: 390 })
    expect(wide.x).toBeGreaterThanOrEqual(8); expect(wide.x + PREVIEW_SIZE.w).toBeLessThanOrEqual(392)
  })
  it('keeps the 280 by 180 card beside the cursor and inside the window', () => {
    const view = { w: 1400, h: 900 }
    expect(previewTarget({ x: 200, y: 400 }, view)).toEqual({ x: 224, y: 310 })
    const nearRight = previewTarget({ x: 1300, y: 400 }, view)
    expect(nearRight.x + PREVIEW_SIZE.w).toBeLessThanOrEqual(1300)
    expect(previewTarget({ x: 600, y: 10 }, view).y).toBe(8)
    expect(previewTarget({ x: 600, y: 895 }, view).y).toBe(900 - 180 - 8)
    const tiny = previewTarget({ x: 100, y: 100 }, { w: 200, h: 150 })
    expect(tiny.x).toBeGreaterThanOrEqual(8); expect(tiny.y).toBeGreaterThanOrEqual(8)
  })
})

describe('reference panel geometry', () => {
  const area = { left: 0, top: 64, width: 1440, height: 836 }
  it('starts beside the tool rail at 380 by 560', () => {
    expect(defaultPanelRect(area)).toEqual({ x: 80, y: 144, w: 380, h: 560 })
  })
  it('keeps the panel inside the window below the header', () => {
    expect(clampPanel({ x: -500, y: 0, w: 380, h: 560 }, area)).toEqual({ x: 8, y: 72, w: 380, h: 560 })
    expect(clampPanel({ x: 5000, y: 5000, w: 380, h: 560 }, area)).toEqual({ x: 1440 - 8 - 380, y: 64 + 836 - 8 - 560, w: 380, h: 560 })
    expect(clampPanel({ x: 100, y: 100, w: 10, h: 10 }, area)).toMatchObject(PANEL_MIN)
    expect(clampPanel({ x: 100, y: 100, w: 9000, h: 9000 }, area)).toEqual({ x: 8, y: 72, w: 1424, h: 820 })
  })
  it('shrinks on a small screen and survives garbage from storage', () => {
    const phone = { left: 0, top: 58, width: 375, height: 754 }
    const small = clampPanel({ x: 80, y: 138, w: 380, h: 560 }, phone)
    expect(small.w).toBe(359); expect(small.x).toBe(8); expect(small.x + small.w).toBeLessThanOrEqual(375 - 8)
    const junk = clampPanel({ x: Number.NaN, y: Infinity, w: 'wide' as unknown as number }, area)
    expect(Object.values(junk).every(Number.isFinite)).toBe(true)
    expect(junk.w).toBe(380)
  })
  it('normalizes a crop dragged in any direction and clamps it to the page', () => {
    expect(normalizeCrop({ x: .8, y: .9 }, { x: .2, y: .4 })).toEqual({ x: .2, y: .4, w: expect.closeTo(.6), h: expect.closeTo(.5) })
    expect(normalizeCrop({ x: -.3, y: .5 }, { x: 1.4, y: 1.2 })).toEqual({ x: 0, y: .5, w: 1, h: .5 })
    expect(normalizeCrop({ x: .5, y: .5 }, { x: .505, y: .7 })).toBeNull()
    expect(normalizeCrop({ x: .5, y: .5 }, { x: .5, y: .5 }, 0)).toBeNull()
    expect(normalizeCrop({ x: Number.NaN, y: 0 }, { x: 1, y: 1 })).toBeNull()
  })
  it('lays out 769 pages and only asks for the ones in view', () => {
    const aspects = Array.from({ length: 769 }, (_, i) => i === 3 ? 0.75 : safeAspect(612, 792))
    const layout = layoutPages(aspects, 340, 38)
    expect(layout.tops).toHaveLength(769)
    expect(layout.sheets[0]).toBe(Math.round(340 * 792 / 612))
    expect(layout.sheets[3]).toBe(255)
    expect(layout.total).toBeGreaterThan(769 * 400)
    expect(visibleRange(layout.tops, layout.heights, 0, 480, 0)).toEqual([0, 0])
    expect(visibleRange(layout.tops, layout.heights, 0, 600, 0)).toEqual([0, 1])
    expect(visibleRange(layout.tops, layout.heights, 0, 600, 2)).toEqual([0, 3])
    const middle = layout.tops[400] + 10
    const [first, last] = visibleRange(layout.tops, layout.heights, middle, 480, 1)
    expect(first).toBe(399); expect(last).toBeLessThanOrEqual(403)
    expect(visibleRange(layout.tops, layout.heights, layout.total + 1000, 480, 1)).toEqual([767, 768])
    expect(visibleRange([], [], 0, 480)).toEqual([0, -1])
  })
  it('uses a letter page shape for missing sizes and renders in coarse steps', () => {
    expect(safeAspect(0, 792)).toBe(DEFAULT_ASPECT)
    expect(safeAspect(612, Number.NaN)).toBe(DEFAULT_ASPECT)
    expect(renderEdge(354, DEFAULT_ASPECT, 2)).toBe(renderEdge(340, DEFAULT_ASPECT, 2))
    expect(renderEdge(354, 1, 2)).toBe(800)
    expect(renderEdge(354, 1, 1)).toBe(480)
    expect(renderEdge(5000, 1, 3)).toBe(1280)
    expect(renderEdge(354, .5, 1)).toBe(480)
  })
})

describe('labels and candidates', () => {
  it('shows printed labels, and file page numbers when there is none', () => {
    expect(pageLabelText(labels, 30)).toBe('p. 23')
    expect(pageLabelText(labels, 0)).toBe('file page 1')
    expect(pageLabelText(labels, 3)).toBe('p. iv')
  })
  it('finds printed pages typed in the search box', () => {
    expect(pageFromQuery(labels, 'page 23')).toBe(30)
    expect(pageFromQuery(labels, 'p. 23')).toBe(30)
    expect(pageFromQuery(labels, 'pg 22')).toBe(29)
    expect(pageFromQuery(labels, 'Page IV')).toBe(3)
    expect(pageFromQuery(labels, 'page 9000')).toBeNull()
    expect(pageFromQuery(labels, 'problem 3.2')).toBeNull()
  })
  it('turns a clicked outline into an insertable candidate', () => {
    const c = anchorCandidate(book, anchor)
    expect(c).toMatchObject({ id: anchor.id, bookId: book.id, pageIndex: 199, label: '192', kind: 'item', anchor, p: 1 })
    expect(c.description).toBe('Example 3.2 on page 192: EXAMPLE 3.2 Finding a Derivative')
    expect(candidateTitle(c, labels)).toBe('Example 3.2, p. 192')
    const page: RankedCandidate = { id: `${book.id}#29:page`, bookId: book.id, pageIndex: 29, label: '22', kind: 'page', description: 'Page 22', features: {}, p: .4 }
    expect(candidateTitle(page, labels)).toBe('Whole page, p. 22')
    expect(anchorTitle({ ...anchor, kind: 'definition', label: '', heading: 'Definition of the derivative' })).toBe('Definition of the derivative')
  })
})

describe('import dialog helpers', () => {
  it('suggests the board for one page and the library for books', () => {
    expect(defaultImportTarget(1)).toBe('board')
    expect(defaultImportTarget(2)).toBe('library')
    expect(defaultImportTarget(769)).toBe('library')
  })
  it('describes sizes and progress plainly', () => {
    expect(formatBytes(52_104_540)).toBe('50 MB')
    expect(formatBytes(4_404_019)).toBe('4.2 MB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(-1)).toBe('')
    expect(importProgressText({ phase: 'reading', done: 119, total: 769 })).toBe('Reading page 120 of 769')
    expect(importProgressText({ phase: 'reading', done: 769, total: 769 })).toBe('Reading page 769 of 769')
    expect(importProgressText({ phase: 'saving', done: 0, total: 1 })).toBe('Saving to your library')
    expect(progressFraction({ phase: 'reading', done: 5, total: 0 })).toBe(0)
    expect(progressFraction({ phase: 'reading', done: 900, total: 769 })).toBe(1)
  })
  it('renders the choices, file details, hint and progress', () => {
    const file = new File([new Uint8Array(10)], 'calculus-volume-1.pdf', { type: 'application/pdf' })
    const html = renderToString(<ImportDialog file={file} info={{ pageCount: 769, title: 'Calculus Volume 1', size: 52_104_540 }} defaultTarget="library" progress={{ phase: 'reading', done: 119, total: 769 }} busy boardLimit="This PDF has 769 pages. Save it to the library instead." onChoose={noop} onCancel={noop}/>)
    expect(html).toContain('Put on the board')
    expect(html).toContain('Save to library')
    expect(html).toContain('calculus-volume-1.pdf')
    expect(html).toContain('769 pages · 50 MB')
    expect(html).toContain('Reading page 120 of 769')
    expect(html).toContain('Save it to the library instead.')
    expect(html).toContain('You can also say &quot;store it&quot; or &quot;put it on the board&quot;.')
    expect(html).toMatch(/import-choice selected[^"]*"[^>]*disabled/)
    const idle = renderToString(<ImportDialog file={file} info={null} defaultTarget="board" progress={null} busy={false} onChoose={noop} onCancel={noop}/>)
    expect(idle).toContain('Checking the PDF')
    expect(idle).toContain('Suggested')
  })
})

describe('library panel', () => {
  it('describes books by when they were opened', () => {
    const now = new Date(2026, 8, 27, 12).getTime()
    expect(openedText(now - 60_000, now)).toBe('Opened today')
    expect(openedText(now - 86_400_000, now)).toBe('Opened yesterday')
    expect(openedText(now - 3 * 86_400_000, now)).toBe('Opened 3 days ago')
    expect(bookDescription({ ...book, openedAt: now }, now)).toBe('Opened today · 50 MB')
    expect(bookDescription({ ...book, indexed: false }, now)).toMatch(/not finished/)
  })
  it('lists books with page counts and shows an empty state', () => {
    const html = renderToString(<LibraryPanel books={[book, { ...book, id: 'sha256:def', title: 'Algebra', pageCount: 1, cover: null }]} openBookId={book.id} onOpen={noop} onImport={noop} onRemove={noop} onClose={noop}/>)
    expect(html).toContain('Calculus Volume 1')
    expect(html).toContain('<b>769</b><small>pages</small>')
    expect(html).toContain('<b>1</b><small>page</small>')
    expect(html).toContain('Open now')
    expect(html).toContain('library-preview')
    const empty = renderToString(<LibraryPanel books={[]} openBookId={null} onOpen={noop} onImport={noop} onRemove={noop} onClose={noop}/>)
    expect(empty).toContain('No books yet')
    expect(empty).toContain('Import PDF')
  })
})

describe('reference panel', () => {
  it('renders a few pages of a 769 page book, not all of them', () => {
    const html = renderToString(<ReferencePanel book={book} highlight={null} onInsertPage={noop} onInsertCrop={noop} onInsertCandidate={noop} onSearch={noop} onClose={noop} busy={false}/>)
    expect(html).toContain('<aside class="reference-panel')
    expect(html).toContain('Calculus Volume 1')
    expect(html).toContain('769 pages')
    const sections = html.match(/class="ref-page[ "]/g) ?? []
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.length).toBeLessThan(8)
    expect(html).toContain('file page 1')
    expect(html).toContain('Insert page')
  })
  it('lists up to three unsure matches with numbered badges', () => {
    const top = anchorCandidate(book, anchor)
    const highlight: RankedCandidate[] = [
      { ...top, p: .41 },
      { ...top, id: 'sha256:abc#201:checkpoint:3.2', pageIndex: 201, anchor: { ...anchor, id: 'x', pageIndex: 201, kind: 'checkpoint' }, p: .33 },
      { id: `${book.id}#0:page`, bookId: book.id, pageIndex: 0, label: null, kind: 'page', description: 'Cover', features: {}, p: .2 },
      { id: 'other-book', bookId: 'sha256:other', pageIndex: 3, label: null, kind: 'page', description: 'Elsewhere', features: {}, p: .1 },
    ]
    const html = renderToString(<ReferencePanel book={book} highlight={highlight} onInsertPage={noop} onInsertCrop={noop} onInsertCandidate={noop} onSearch={noop} onClose={noop} busy={false} message="Pick one of the 3 highlighted matches."/>)
    expect(html).toContain('Tap the one you meant')
    expect(html).toContain('Example 3.2, p. 192')
    expect(html).toContain('Checkpoint 3.2, p. 194')
    expect(html).toContain('Whole page, file page 1')
    expect(html).not.toContain('Elsewhere')
    expect(html).toContain('Pick one of the 3 highlighted matches.')
    expect(html).toContain('Insert match 3: Whole page, file page 1')
  })
})

describe('reference panel beside the typing bar', () => {
  const area = { left: 0, top: 64, width: 1024, height: 704 }
  // an iPad in landscape: the typing bar and its caption, centered at the bottom
  const dock = { left: 187, top: 640, right: 837, bottom: 720 }
  it('moves up, then gets shorter, so the typing bar stays uncovered', () => {
    const rect = clampPanel({ x: 80, y: 144, w: 380, h: 560 }, area, PANEL_MIN, dock)
    expect(rect.y + rect.h).toBeLessThanOrEqual(dock.top - 8)
    expect(rect).toEqual({ x: 80, y: 72, w: 380, h: 560 })
    const tall = clampPanel({ x: 80, y: 144, w: 380, h: 900 }, area, PANEL_MIN, dock)
    expect(tall).toEqual({ x: 80, y: 72, w: 380, h: 560 })
  })
  it('keeps its size away from the typing bar', () => {
    expect(clampPanel({ x: 8, y: 144, w: 170, h: 560 }, area, { w: 120, h: 320 }, dock)).toEqual({ x: 8, y: 144, w: 170, h: 560 })
    expect(clampPanel({ x: 80, y: 80, w: 380, h: 400 }, area, PANEL_MIN, dock)).toEqual({ x: 80, y: 80, w: 380, h: 400 })
    expect(clampPanel({ x: 80, y: 144, w: 380, h: 560 }, area, PANEL_MIN, null)).toEqual({ x: 80, y: 144, w: 380, h: 560 })
  })
  it('never squeezes below a usable height on a tiny window', () => {
    const tiny = { left: 0, top: 64, width: 700, height: 260 }
    const rect = clampPanel({ x: 80, y: 100, w: 380, h: 560 }, tiny, PANEL_MIN, { left: 0, top: 200, right: 700, bottom: 300 })
    expect(rect.h).toBeGreaterThanOrEqual(120)
  })
})

describe('resizing the reference panel', () => {
  const aspects = Array.from({ length: 769 }, () => safeAspect(612, 792))
  it('keeps the page at the top of the view where it was', () => {
    const wide = layoutPages(aspects, 340, 38), narrow = layoutPages(aspects, 240, 38), wider = layoutPages(aspects, 520, 38)
    const top = wide.tops[199] + 120
    for (const next of [narrow, wider]) {
      const scroll = anchoredScroll(wide, next, top)
      expect(pageAt(next, scroll)).toBe(199)
      expect((scroll - next.tops[199]) / next.heights[199]).toBeCloseTo(120 / wide.heights[199], 3)
    }
    // the plain scroll position would show a different page after the resize
    expect(pageAt(narrow, top)).not.toBe(199)
    expect(anchoredScroll(wide, narrow, 0)).toBe(0)
    const gap = wide.tops[5] - 4
    expect(anchoredScroll(wide, narrow, gap)).toBe(narrow.tops[5] - 4)
  })
  it('finds the page in the middle of the view', () => {
    const layout = layoutPages(aspects, 340, 38)
    expect(pageAt(layout, 0)).toBe(0)
    expect(pageAt(layout, layout.tops[30] + 5)).toBe(30)
  })
})

describe('highlighted matches', () => {
  it('are the badges shown for the open book, in order, at most 3', () => {
    const top = anchorCandidate(book, anchor)
    const list: RankedCandidate[] = [
      { ...top, id: 'elsewhere', bookId: 'sha256:other' },
      top,
      { ...top, id: 'b', pageIndex: 201 },
      { ...top, id: 'out', pageIndex: 9999 },
      { ...top, id: 'c', pageIndex: 29 },
      { ...top, id: 'd', pageIndex: 30 },
    ]
    expect(panelHits(list, book).map(c => c.id)).toEqual([top.id, 'b', 'c'])
    expect(panelHits(null, book)).toEqual([])
  })
  it('render with a lookup number and a way to hide them', () => {
    const highlight = [anchorCandidate(book, anchor)]
    const html = renderToString(<ReferencePanel book={book} highlight={highlight} lookup={3} onDismiss={noop} onPageChange={noop} onInsertPage={noop} onInsertCrop={noop} onInsertCandidate={noop} onSearch={noop} onClose={noop} busy={false}/>)
    expect(html).toContain('Hide matches')
    expect(html).toContain('Example 3.2, p. 192')
  })
})

describe('import dialog over the board', () => {
  it('renders the same when given a container', () => {
    const file = new File([new Uint8Array(10)], 'notes.pdf', { type: 'application/pdf' })
    const html = renderToString(<ImportDialog file={file} info={{ pageCount: 1, title: 'Notes', size: 10 }} defaultTarget="board" progress={null} busy={false} onChoose={noop} onCancel={noop} container={null}/>)
    expect(html).toContain('import-layer')
    expect(html).toContain('You can also say')
  })
})
