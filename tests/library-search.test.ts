import { describe, expect, it } from 'vitest'
import { localRank } from '../shared/ranking'
import { buildCandidates, parseLibraryQuery, pickBook, searchPages, titleMatch } from '../src/library/search'
import type { Anchor, AnchorKind, BookRecord, PageRecord } from '../src/library/types'

describe('parseLibraryQuery', () => {
  const q = (text: string) => parseLibraryQuery(text)

  it('reads printed page requests', () => {
    expect(q('page 22')).toEqual({ kind: 'page', label: '22', raw: 'page 22' })
    expect(q('p. 22')).toMatchObject({ kind: 'page', label: '22' })
    expect(q('pg 22')).toMatchObject({ kind: 'page', label: '22' })
    expect(q('Page 022')).toMatchObject({ kind: 'page', label: '22' })
    expect(q('page xii')).toMatchObject({ kind: 'page', label: 'xii' })
    expect(q('put page 22 on the board')).toMatchObject({ kind: 'page', label: '22' })
    expect(q('bring up page 145 please')).toMatchObject({ kind: 'page', label: '145' })
  })

  it('reads item requests and their kind', () => {
    expect(q('problem 3.2')).toEqual({ kind: 'item', label: '3.2', raw: 'problem 3.2' })
    expect(q('example 3.2')).toMatchObject({ kind: 'item', label: '3.2', itemKind: 'example' })
    expect(q('exercise 48')).toMatchObject({ kind: 'item', label: '48', itemKind: 'exercise' })
    expect(q('question 5')).toMatchObject({ kind: 'item', label: '5', itemKind: 'question' })
    expect(q('checkpoint 3.26')).toMatchObject({ kind: 'item', label: '3.26', itemKind: 'checkpoint' })
    expect(q('section 3.2')).toMatchObject({ kind: 'item', label: '3.2', itemKind: 'section' })
    expect(q('theorem 2.1')).toMatchObject({ kind: 'item', label: '2.1', itemKind: 'theorem' })
    expect(q('3.2')).toMatchObject({ kind: 'item', label: '3.2' })
    expect(q('#12')).toMatchObject({ kind: 'item', label: '12' })
    expect(q('3.2')?.kind === 'item' && q('3.2')).not.toHaveProperty('itemKind')
  })

  it('ignores verbs and fillers', () => {
    for (const text of ['put problem 3.2 on the board', 'insert problem 3.2', 'bring problem 3.2 here', 'show me problem 3.2', 'give me problem 3.2',
      'work problem 3.2', 'workbook problem 3.2', 'Can you pull up problem 3.2?', 'problem 3.2.']) {
      expect(q(text)).toMatchObject({ kind: 'item', label: '3.2' })
    }
  })

  it('picks up a book hint', () => {
    expect(q('problem 3.2 from the calculus book')).toMatchObject({ kind: 'item', label: '3.2', book: 'calculus' })
    expect(q('page 22 in Calculus')).toMatchObject({ kind: 'page', label: '22', book: 'calculus' })
    expect(q('open page 10 of the physics textbook')).toMatchObject({ kind: 'page', label: '10', book: 'physics' })
    expect(q('example 1.4 in calculus volume 1')).toMatchObject({ book: 'calculus volume 1' })
    expect(q('problem 3.2 from the book')).not.toHaveProperty('book')
    expect(q('page 4 in the book')).not.toHaveProperty('book')
  })

  it('returns a topic for other library requests and null for board requests', () => {
    expect(q('the chain rule example from the book')).toMatchObject({ kind: 'topic', terms: 'chain rule example' })
    expect(q('find limits at infinity in the textbook')).toMatchObject({ kind: 'topic' })
    for (const text of ['plot y = x^2', 'write the quadratic formula', 'write pi', 'draw a circle', 'graph sin x', 'x = 3.2 + 1', '', 'step 2', 'solve for x']) {
      expect(q(text)).toBeNull()
    }
  })
})

const BOOK: BookRecord = {
  id: 'sha256:book', title: 'Calculus Volume 1', fileName: 'calc.pdf', size: 1, pageCount: 12, addedAt: 1, openedAt: 1,
  labels: Array.from({ length: 12 }, (_, i) => i < 2 ? null : String(i + 180)), outline: [], cover: null, indexed: true, textPages: 12,
}

function anchor(pageIndex: number, kind: AnchorKind, label: string, heading: string, snippet = heading): Anchor {
  return { id: `${BOOK.id}#${pageIndex}:${kind}:${label}`, bookId: BOOK.id, pageIndex, kind, label, heading, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, snippet }
}

const ANCHORS: Anchor[] = [
  anchor(2, 'section', '2.4', '2.4 Continuity'),
  anchor(3, 'exercise', '48', '48. Find the limit.'),
  anchor(4, 'section', '3.1', '3.1 Defining the Derivative'),
  anchor(5, 'example', '3.2', 'EXAMPLE 3.2 The Slope of a Tangent Line Revisited', 'EXAMPLE 3.2 The Slope of a Tangent Line Revisited Use Equation 3.4 to find the slope.'),
  anchor(5, 'figure', '3.2', 'Figure 3.2 The tangent line'),
  anchor(6, 'checkpoint', '3.2', '3.2 For f(x) use a table to estimate the slope.'),
  anchor(7, 'section', '3.2', '3.2 The Derivative as a Function'),
  anchor(8, 'exercise', '48', '48. Find the derivative.'),
  anchor(9, 'example', '3.12', 'EXAMPLE 3.12 Using the Chain Rule', 'EXAMPLE 3.12 Using the Chain Rule Differentiate a composite function with the chain rule.'),
  anchor(9, 'exercise', '60', '60. Use the chain rule.'),
]

const PAGES: PageRecord[] = Array.from({ length: 12 }, (_, index) => ({
  bookId: BOOK.id, index, label: BOOK.labels[index], width: 612, height: 792, lines: [],
  text: [`${index + 180} 3 • Derivatives`, index === 9 ? 'The chain rule. Using the chain rule for composite functions, the chain rule again.' : index === 10 ? 'Chain of stores and a rule of thumb.' : 'Limits and slopes of lines.', 'Access for free at openstax.org'].join('\n'),
}))

describe('buildCandidates', () => {
  it('lists every item with the label, all kinds, with features', () => {
    const query = parseLibraryQuery('problem 3.2')!
    const candidates = buildCandidates(query, BOOK, PAGES, ANCHORS)
    expect(candidates.map(candidate => candidate.anchor?.kind).sort()).toEqual(['checkpoint', 'example', 'figure', 'section'])
    const example = candidates.find(candidate => candidate.anchor?.kind === 'example')!
    expect(example.features).toMatchObject({ exactLabel: 1, kindMatch: 1, kindPrior: 0.8, sameChapter: 1 })
    expect(example.features.early).toBeGreaterThan(0)
    expect(example.description).toBe('Example 3.2 on page 185: The Slope of a Tangent Line Revisited. Use Equation 3.4 to find the slope.')
    expect(example.id).toBe(ANCHORS[3].id)
    expect(example.kind).toBe('item')
    expect(example.label).toBe('185')
    expect(candidates.find(candidate => candidate.anchor?.kind === 'section')!.features.kindMatch).toBe(0)
    expect(candidates.every(candidate => candidate.description.length <= 300)).toBe(true)
  })

  it('ranks the three likely matches first and stays unsure when kinds share a label', () => {
    const candidates = buildCandidates(parseLibraryQuery('problem 3.2')!, BOOK, PAGES, ANCHORS)
    const result = localRank({ task: 'library', query: 'problem 3.2', items: candidates.map(c => ({ id: c.id, text: c.description, features: c.features })) })
    const kinds = result.ranked.slice(0, 3).map(entry => candidates.find(c => c.id === entry.id)!.anchor!.kind)
    expect(kinds).toEqual(['example', 'checkpoint', 'section'])
    expect(result.confident).toBe(false)
  })

  it('matches only the named kind and says which section an exercise is in', () => {
    const example = buildCandidates(parseLibraryQuery('example 3.2')!, BOOK, PAGES, ANCHORS)
    expect(example.filter(c => c.features.kindMatch === 1).map(c => c.anchor?.kind)).toEqual(['example'])
    const exercises = buildCandidates(parseLibraryQuery('exercise 48')!, BOOK, PAGES, ANCHORS)
    expect(exercises.map(c => c.description.slice(0, 44))).toEqual(expect.arrayContaining([
      'Exercise 48 in section 2.4 on page 183: Find', 'Exercise 48 in section 3.2 on page 188: Find',
    ]))
    expect(exercises.every(c => c.features.sameChapter === 0)).toBe(true)
  })

  it('falls back to pages that name the item when nothing was detected', () => {
    const pages = PAGES.map(page => page.index === 11 ? { ...page, text: 'Problem 7.3 Show that the series converges.' } : page)
    const candidates = buildCandidates(parseLibraryQuery('problem 7.3')!, BOOK, pages, ANCHORS)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'page', pageIndex: 11, id: `${BOOK.id}#11:page` })
    expect(candidates[0].features.exactLabel).toBe(0)
    expect(buildCandidates(parseLibraryQuery('problem 9.9')!, BOOK, PAGES, ANCHORS)).toEqual([])
  })

  it('searches page text for topics and prefers the asked for kind', () => {
    expect(searchPages(PAGES, 'chain rule')[0].index).toBe(9)
    expect(searchPages(PAGES, 'zebra')).toEqual([])
    const candidates = buildCandidates(parseLibraryQuery('the chain rule example from the book')!, BOOK, PAGES, ANCHORS)
    expect(candidates[0].anchor?.label).toBe('3.12')
    expect(candidates.some(c => c.kind === 'page' && c.pageIndex === 9)).toBe(true)
    const page = candidates.find(c => c.kind === 'page' && c.pageIndex === 9)!
    expect(page.description.startsWith('Page 189: The chain rule.')).toBe(true)
    expect(buildCandidates(parseLibraryQuery('page 3')!, BOOK, PAGES, ANCHORS)).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => anchor(i % 12, 'exercise', '5', `5. Item ${i}`))
    expect(buildCandidates(parseLibraryQuery('exercise 5')!, BOOK, PAGES, many)).toHaveLength(40)
    expect(buildCandidates(parseLibraryQuery('exercise 5')!, BOOK, PAGES, many, 3)).toHaveLength(3)
  })
})

describe('pickBook', () => {
  const book = (id: string, title: string, openedAt: number): BookRecord => ({ ...BOOK, id, title, fileName: `${id}.pdf`, openedAt })
  const calc = book('c', 'Calculus Volume 1', 3), phys = book('p', 'University Physics', 2), chem = book('h', 'Chemistry 2e', 1)

  it('prefers the open book unless the teacher names another', () => {
    expect(pickBook([calc, phys], undefined, 'p').book?.id).toBe('p')
    expect(pickBook([calc, phys], 'calculus', 'p').book?.id).toBe('c')
    expect(pickBook([calc, phys], 'physics', 'p').book?.id).toBe('p')
    expect(pickBook([calc, phys], 'biology', 'p').book?.id).toBe('p')
  })

  it('matches title words, falls back to the only book, else lists the choices', () => {
    expect(pickBook([calc, phys, chem], 'calc').book?.id).toBe('c')
    expect(pickBook([calc], 'anything').book?.id).toBe('c')
    expect(pickBook([calc]).book?.id).toBe('c')
    const unsure = pickBook([chem, calc, phys])
    expect(unsure.book).toBeNull()
    expect(unsure.ambiguous.map(entry => entry.id)).toEqual(['c', 'p', 'h'])
    expect(pickBook([], 'x')).toEqual({ book: null, ambiguous: [] })
    expect(titleMatch('calculus volume 1', 'Calculus Volume 1')).toBe(1)
    expect(titleMatch('physics', 'Calculus Volume 1')).toBe(0)
  })
})
