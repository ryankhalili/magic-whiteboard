import { describe, expect, it } from 'vitest'
import { FEATURE_WEIGHTS, isConfident, localRank, type RankItem } from '../shared/ranking'

const sum = (ps: { p: number }[]) => ps.reduce((a, r) => a + r.p, 0)

describe('local ranker', () => {
  it('uses the agreed feature weights', () => {
    expect(FEATURE_WEIGHTS.library).toEqual({ exactLabel: 3, kindMatch: 2, kindPrior: 1.5, textMatch: 1.5, sameChapter: .5, early: .2 })
    expect(FEATURE_WEIGHTS.placement).toEqual({ inView: 2, readingOrder: 1.5, workSpace: 1.5, nearFocus: 1, centered: .5, aligned: .7 })
    expect(FEATURE_WEIGHTS.book).toEqual({ titleMatch: 3, recent: 1 })
  })

  it('puts the exact example first and is confident when only one item matches the kind', () => {
    const items: RankItem[] = [
      { id: 'section', text: 'Section 3.12', features: { exactLabel: 1, kindPrior: .4, early: .5 } },
      { id: 'example', text: 'Example 3.12', features: { exactLabel: 1, kindMatch: 1, kindPrior: .8, early: .5 } },
      { id: 'page', text: 'page 240', features: { textMatch: .3, early: .4 } },
    ]
    const result = localRank({ task: 'library', query: 'example 3.12', items })
    expect(result.source).toBe('local')
    expect(result.ranked.map(r => r.id)).toEqual(['example', 'section', 'page'])
    expect(sum(result.ranked)).toBeCloseTo(1, 9)
    expect(result.confident).toBe(true)
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })

  it('is unsure when an example and a checkpoint share the label', () => {
    const items: RankItem[] = [
      { id: 'example', text: 'Example 3.2', features: { exactLabel: 1, kindMatch: 1, kindPrior: .8 } },
      { id: 'checkpoint', text: 'Checkpoint 3.2', features: { exactLabel: 1, kindMatch: 1, kindPrior: .7 } },
      { id: 'section', text: 'Section 3.2', features: { exactLabel: 1, kindPrior: .4 } },
    ]
    const result = localRank({ task: 'library', query: 'problem 3.2', items })
    expect(result.ranked.map(r => r.id)).toEqual(['example', 'checkpoint', 'section'])
    expect(result.confident).toBe(false)
  })

  it('keeps input order for ties and returns every item', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `S${i + 1}`, text: 'spot', features: { inView: 1 } }))
    const result = localRank({ task: 'placement', query: 'plot', items })
    expect(result.ranked.map(r => r.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'])
    for (const r of result.ranked) expect(r.p).toBeCloseTo(.2, 9)
    expect(result.confident).toBe(false)
  })

  it('ranks placement spots by reading order and work space', () => {
    const result = localRank({ task: 'placement', query: 'plot y = x^2', items: [
      { id: 'S1', text: 'far corner', features: { inView: 1, centered: .2 } },
      { id: 'S2', text: 'below the last example', features: { inView: 1, readingOrder: 1, workSpace: 1, aligned: 1 } },
      { id: 'S3', text: 'off screen', features: { readingOrder: 1 } },
    ] })
    expect(result.ranked[0].id).toBe('S2')
    expect(result.ranked.at(-1)?.id).toBe('S3')
  })

  it('clamps odd feature values and ignores unknown features', () => {
    const result = localRank({ task: 'book', query: 'calculus', items: [
      { id: 'a', text: 'A', features: { titleMatch: Number.NaN, recent: 50, junk: 1000 } },
      { id: 'b', text: 'B', features: { titleMatch: 1 } },
    ] })
    expect(result.ranked[0].id).toBe('b')
    expect(result.ranked.every(r => Number.isFinite(r.p))).toBe(true)
  })

  it('falls back to title words when no item has features', () => {
    const result = localRank({ task: 'book', query: 'open the calculus book', items: [
      { id: 'phys', text: 'University Physics Volume 1' },
      { id: 'calc', text: 'Calculus Volume 1' },
    ] })
    expect(result.ranked[0].id).toBe('calc')
    expect(result.confident).toBe(true)
  })

  it('handles empty and single item requests', () => {
    expect(localRank({ task: 'library', query: 'x', items: [] })).toMatchObject({ ranked: [], confident: false })
    const one = localRank({ task: 'library', query: 'x', items: [{ id: 'only', text: 'only' }] })
    expect(one.ranked).toEqual([{ id: 'only', p: 1 }])
    expect(one.confident).toBe(true)
  })

  it('ranks many items quickly', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: `i${i}`, text: `item ${i}`, features: { textMatch: (i % 97) / 97, early: 1 - i / 5000 } }))
    const result = localRank({ task: 'library', query: 'x', items })
    expect(result.ranked).toHaveLength(5000)
    expect(result.ranked[0].id).toBe('i96')
    expect(sum(result.ranked)).toBeCloseTo(1, 6)
  })
})

describe('confidence rule', () => {
  it.each([
    [[.7, .2, .1], true],
    [[.6, .35], true],
    [[.6, .36], false],
    [[.59, .1], false],
    [[.2, .8], true],
    [[.5], true],
    [[.49], false],
    [[], false],
  ])('%j -> %s', (ps, expected) => {
    expect(isConfident(ps.map(p => ({ p })))).toBe(expected)
  })
})
