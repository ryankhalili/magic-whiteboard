import { describe, expect, it } from 'vitest'
import { getPlacementBounds } from '../src/board/controller'
import { describeSpot, findSpots, guessContentSize, NATURAL_SIZES, obstaclesFromObjects, type Obstacle } from '../src/board/placementSpots'
import type { BoardContext, BoardObject, Bounds } from '../shared/board'
import type { Spot } from '../src/library/types'

const view: Bounds = { x: 0, y: 0, w: 1400, h: 800 }
const hits = (a: Bounds, b: Bounds, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad
const iou = (a: Bounds, b: Bounds) => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  return ix * iy / (a.w * a.h + b.w * b.h - ix * iy)
}
const inside = (a: Bounds, b: Bounds) => a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6

// deterministic pseudo random board
function scatter(count: number, seed = 7, area: Bounds = { x: -400, y: -400, w: 2400, h: 1800 }): Obstacle[] {
  let s = seed
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
  return Array.from({ length: count }, () => ({ x: area.x + rand() * area.w, y: area.y + rand() * area.h, w: 10 + rand() * 120, h: 6 + rand() * 90, label: 'handwriting' }))
}

function checkSpots(spots: Spot[], obstacles: Bounds[], size: { w: number; h: number }, workBelow = 0) {
  expect(spots.length).toBeGreaterThan(0)
  spots.forEach((spot, i) => {
    expect(spot.id).toBe(`S${i + 1}`)
    expect(spot.bounds.w).toBe(size.w)
    expect(spot.bounds.h).toBe(size.h)
    const reserved = { ...spot.bounds, h: size.h + workBelow }
    for (const o of obstacles) expect(hits(reserved, o, 24 - 1e-6), `${spot.id} hits an obstacle`).toBe(false)
    expect(Object.keys(spot.features).sort()).toEqual(['aligned', 'centered', 'inView', 'nearFocus', 'readingOrder', 'workSpace'])
    for (const value of Object.values(spot.features)) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1) }
    expect(spot.description.length).toBeGreaterThan(5)
    expect(spot.description).not.toMatch(/[\u2013\u2014]/)
  })
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(iou(spots[i].bounds, spots[j].bounds)).toBeLessThanOrEqual(.5)
}

describe('placement spots', () => {
  it('fills an empty view with in view spots, best near the top so work space stays below', () => {
    const size = NATURAL_SIZES.plot, spots = findSpots({ viewport: view, obstacles: [], size })
    checkSpots(spots, [], size)
    expect(spots.length).toBe(12)
    expect(inside(spots[0].bounds, view)).toBe(true)
    expect(spots[0].features.inView).toBe(1)
    expect(spots[0].bounds.y).toBeLessThan(view.h / 3)
    expect(spots[0].description).toMatch(/^open area, top/)
    expect(spots[0].description).toMatch(/px free below$/)
  })

  it('never overlaps content, avoided ui or the reserved work area', () => {
    const obstacles = scatter(60), avoid = [{ x: 80, y: 90, w: 380, h: 560 }], size = { w: 600, h: 180 }
    const spots = findSpots({ viewport: view, obstacles, size, workBelow: 260, avoid })
    checkSpots(spots, obstacles, size, 260)
    for (const s of spots) expect(hits({ ...s.bounds, h: 440 }, avoid[0])).toBe(false)
  })

  it('places a new problem to the right of the last one, top aligned, instead of above or on top of it', () => {
    const problem = { x: 100, y: 100, w: 600, h: 200, label: 'textbook problem' }, work = { x: 110, y: 330, w: 560, h: 330, label: 'handwriting' }
    const size = { w: 600, h: 200 }
    const spots = findSpots({ viewport: view, obstacles: [problem, work], size, workBelow: 260 })
    checkSpots(spots, [problem, work], size, 260)
    const best = spots[0].bounds
    expect(best.x).toBeGreaterThanOrEqual(problem.x + problem.w + 24)
    expect(best.y).toBe(problem.y)
    expect(spots[0].description).toMatch(/^right of the textbook problem, top aligned/)
    expect(spots[0].features.aligned).toBeGreaterThan(0)
  })

  it('puts the next object right under the focus object when there is room', () => {
    const eq = { x: 510, y: 60, w: 380, h: 145, label: 'equation' }, size = NATURAL_SIZES.plot
    const spots = findSpots({ viewport: view, obstacles: [eq], size, near: eq })
    checkSpots(spots, [eq], size)
    expect(spots[0].bounds.x).toBe(eq.x)
    expect(spots[0].bounds.y).toBeGreaterThanOrEqual(eq.y + eq.h + 24)
    expect(spots[0].bounds.y).toBeLessThanOrEqual(eq.y + eq.h + 40)
    expect(spots[0].features.nearFocus).toBeGreaterThan(.9)
    expect(spots[0].description).toMatch(/^below the equation, left aligned/)
  })

  it('extends below the lowest content when nothing fits in view', () => {
    const page = { x: -100, y: -50, w: 1700, h: 1200, label: 'PDF page' }, size = { w: 600, h: 200 }
    const spots = findSpots({ viewport: view, obstacles: [page], size, workBelow: 260 })
    checkSpots(spots, [page], size, 260)
    expect(spots[0].bounds.y).toBeGreaterThanOrEqual(page.y + page.h + 24)
    expect(spots[0].description).toBe('below the PDF page, below the view')
    expect(spots.every(s => s.bounds.y >= page.y + page.h + 24 || s.bounds.x >= page.x + page.w + 24)).toBe(true)
  })

  it('slides past content stacked below the view', () => {
    const stack = [{ x: 0, y: 0, w: 1400, h: 800 }, { x: 0, y: 832, w: 1400, h: 300 }, { x: 300, y: 1160, w: 200, h: 100 }]
    const spots = findSpots({ viewport: view, obstacles: stack, size: { w: 400, h: 200 }, workBelow: 100 })
    checkSpots(spots, stack, { w: 400, h: 200 }, 100)
  })

  it('keeps the reserved work space free, not just the content rect', () => {
    // a shelf with a 220 tall gap: a 150 tall item fits, but not with 260 of work space under it
    const shelf = [{ x: 0, y: 0, w: 1400, h: 100 }, { x: 0, y: 344, w: 1400, h: 460 }]
    const size = { w: 400, h: 150 }
    const loose = findSpots({ viewport: view, obstacles: shelf, size })
    expect(loose.some(s => s.bounds.y > 100 && s.bounds.y < 344)).toBe(true)
    const strict = findSpots({ viewport: view, obstacles: shelf, size, workBelow: 260 })
    checkSpots(strict, shelf, size, 260)
    expect(strict.every(s => s.bounds.y >= 804 + 24 || s.bounds.x >= 1400 + 24)).toBe(true)
    expect(strict[0].bounds.y).toBeGreaterThanOrEqual(804 + 24)
  })

  it('respects max, insets and zoomed out views', () => {
    const spots = findSpots({ viewport: view, obstacles: [], size: NATURAL_SIZES.math, max: 3, insets: { left: 200, top: 100, right: 0, bottom: 0 } })
    expect(spots.map(s => s.id)).toEqual(['S1', 'S2', 'S3'])
    for (const s of spots) { expect(s.bounds.x).toBeGreaterThanOrEqual(200); expect(s.bounds.y).toBeGreaterThanOrEqual(100) }
    const far = { x: -20000, y: -12000, w: 40000, h: 24000 }
    const wide = findSpots({ viewport: far, obstacles: scatter(100, 3, far).map(o => ({ ...o, w: o.w * 20, h: o.h * 20 })), size: NATURAL_SIZES.plot })
    expect(wide.length).toBe(12)
    for (const s of wide) expect(inside(s.bounds, far)).toBe(true)
  })

  it('returns nothing for broken input and ignores broken obstacles', () => {
    expect(findSpots({ viewport: { x: NaN, y: 0, w: 100, h: 100 }, obstacles: [], size: { w: 10, h: 10 } })).toEqual([])
    expect(findSpots({ viewport: view, obstacles: [], size: { w: 0, h: 10 } })).toEqual([])
    expect(findSpots({ viewport: view, obstacles: [], size: { w: Infinity, h: 10 } })).toEqual([])
    expect(findSpots({ viewport: { x: 0, y: 0, w: 0, h: 500 }, obstacles: [], size: { w: 10, h: 10 } })).toEqual([])
    const junk = [{ x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: -5, h: 10 }, null as unknown as Bounds]
    const spots = findSpots({ viewport: view, obstacles: junk, size: NATURAL_SIZES.text, near: { x: Infinity, y: 0, w: 1, h: 1 }, workBelow: NaN, max: NaN })
    expect(spots.length).toBe(12)
    expect(spots.every(s => Object.values(s.bounds).every(Number.isFinite))).toBe(true)
  })

  it('always finds a spot when the content is larger than the view', () => {
    const size = { w: 700, h: 906 }
    const spots = findSpots({ viewport: view, obstacles: scatter(40), size })
    checkSpots(spots, scatter(40), size)
  })

  it('runs in a few milliseconds for 200 obstacles and stays bounded for thousands', () => {
    const obstacles = scatter(200, 11), input = { viewport: view, obstacles, size: { w: 600, h: 200 }, workBelow: 260, near: obstacles[5] }
    for (let i = 0; i < 5; i++) findSpots(input)
    const times: number[] = []
    for (let i = 0; i < 21; i++) { const t = performance.now(); findSpots(input); times.push(performance.now() - t) }
    times.sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
    checkSpots(findSpots(input), obstacles, input.size, 260)
    const many = scatter(8000, 5, { x: -3000, y: -3000, w: 9000, h: 9000 })
    const t = performance.now(), spots = findSpots({ ...input, obstacles: many, near: null })
    expect(performance.now() - t).toBeLessThan(150)
    checkSpots(spots, many, input.size, 260)
  })
})

describe('describeSpot', () => {
  const graph = { x: 100, y: 100, w: 440, h: 320, label: 'graph' }
  it('names the neighbor, alignment and room below', () => {
    expect(describeSpot({ x: 572, y: 100, w: 380, h: 145 }, { viewport: view, obstacles: [graph] })).toBe('right of the graph, top aligned, 560 px free below')
    expect(describeSpot({ x: 100, y: 452, w: 380, h: 145 }, { viewport: view, obstacles: [graph, { x: 90, y: 700, w: 50, h: 20 }] })).toBe('below the graph, left aligned, 100 px free below')
    expect(describeSpot({ x: 1000, y: 600, w: 300, h: 100 }, { viewport: view, obstacles: [] })).toBe('open area, bottom right of the view, 100 px free below')
    expect(describeSpot({ x: 1300, y: 700, w: 300, h: 200 }, { viewport: view, obstacles: [] })).toBe('open area, partly off screen')
    expect(describeSpot({ x: 200, y: 900, w: 300, h: 100 }, { viewport: view, obstacles: [] })).toBe('open area, below the view')
    expect(describeSpot({ x: 10, y: 10, w: 300, h: 100 }, { viewport: view, obstacles: [{ x: 0, y: 0, w: 50, h: 50 }] })).toMatch(/^over the content/)
  })
})

describe('guessContentSize', () => {
  it('guesses the kind from the typed command', () => {
    const cases: [string, keyof typeof NATURAL_SIZES][] = [
      ['plot y = x^2', 'plot'], ['Graph the circle x^2+y^2=9', 'plot'], ['sketch the parabola through the origin', 'plot'],
      ['write the quadratic formula', 'math'], ['x^2 + 3x - 4 = 0', 'math'], ['the integral of sin x from 0 to pi', 'math'], ['square root of two', 'math'],
      ['draw a right triangle', 'geometry'], ['add a hexagon', 'geometry'], ['formula for the area of a circle', 'math'], ['draw a circle for the area formula', 'geometry'],
      ['add a note: bring calculators tomorrow', 'text'], ['title Chain rule', 'text'], ['', 'text'], ['hello there', 'text'],
    ]
    for (const [text, kind] of cases) expect(guessContentSize(text), text).toEqual({ kind, ...NATURAL_SIZES[kind] })
    expect(guessContentSize(undefined as unknown as string).kind).toBe('text')
  })

  it('matches the natural sizes the controller uses', () => {
    const context: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1000, h: 800 } }
    const ops = { plot: 'create_plot', math: 'create_math', text: 'create_text', geometry: 'create_geometry' } as const
    for (const kind of Object.keys(ops) as (keyof typeof ops)[]) {
      const b = getPlacementBounds({ type: ops[kind] }, context, kind)
      expect({ w: b.w, h: b.h }).toEqual(NATURAL_SIZES[kind])
    }
  })
})

describe('obstaclesFromObjects', () => {
  it('labels board objects and skips broken bounds', () => {
    const objects = [
      { id: 'a', kind: 'plot', bounds: { x: 1, y: 2, w: 3, h: 4 }, rotation: 0 },
      { id: 'b', kind: 'draw', bounds: { x: 0, y: 0, w: 5, h: 0 }, rotation: 0 },
      { id: 'c', kind: 'textbook_item', bounds: { x: 0, y: 0, w: 5, h: 5 }, rotation: 0 },
      { id: 'd', kind: 'mystery_thing', bounds: { x: 0, y: 0, w: 5, h: 5 }, rotation: 0 },
      { id: 'e', kind: 'math', bounds: { x: NaN, y: 0, w: 5, h: 5 }, rotation: 0 },
    ] as BoardObject[]
    expect(obstaclesFromObjects(objects)).toEqual([
      { x: 1, y: 2, w: 3, h: 4, label: 'graph' }, { x: 0, y: 0, w: 5, h: 0, label: 'handwriting' },
      { x: 0, y: 0, w: 5, h: 5, label: 'textbook problem' }, { x: 0, y: 0, w: 5, h: 5, label: 'mystery thing' },
    ])
    expect(obstaclesFromObjects(null)).toEqual([])
  })
})
