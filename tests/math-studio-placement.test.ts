import { describe, expect, it } from 'vitest'
import type { BoardContext, BoardObject, BoardOperation, Bounds } from '../shared/board'
import { placeStudioOperation } from '../src/math/studioPlacement'
import { Editor } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'

const viewport = { x: 0, y: 0, w: 1400, h: 1000 }
const plot: BoardOperation = { type: 'create_plot', expression: 'x^2' }
const overlap = (a: Bounds, b: Bounds) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const inside = (a: Bounds, b: Bounds) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
const object = (id: string, bounds: Bounds, rest: Partial<BoardObject> = {}): BoardObject => ({ id, bounds, kind: 'plot', rotation: 0, ...rest })
const context = (objects: BoardObject[] = [], rest: Partial<BoardContext> = {}): BoardContext => ({
  focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport, objects, ...rest,
})

describe('manual Math Studio placement', () => {
  it('keeps repeated graph and equation inserts separate through the real controller', () => {
    const editor = new Editor()
    let boardContext = context()
    const controller = createBoardController(editor, () => boardContext)
    const boxes: Bounds[] = []
    for (let i = 0; i < 8; i++) {
      boardContext = context(controller.getObjects(), { selectedIds: editor.getSelectedShapeIds(), lastCreatedIds: controller.lastCreatedIds })
      const op = placeStudioOperation(i % 2 ? { type: 'create_math', latex: '\\int_0^1 x^2 dx' } : plot, boardContext, { zoom: 1 })
      expect(controller.applyOperations([op]).ok).toBe(true)
      for (const prior of boxes) expect(overlap(op.bounds!, prior)).toBe(false)
      boxes.push(op.bounds!)
    }
    expect(controller.getObjects()).toHaveLength(8)
    editor.dispose()
  })

  it('ignores stale model placement options and keeps selected content clear', () => {
    const existing = object('a', { x: 100, y: 80, w: 440, h: 320 })
    const op = placeStudioOperation(plot, context([existing], {
      selectedIds: ['a'], placementOptions: [{ id: 'A', bounds: existing.bounds }],
    }), { zoom: 1 })
    expect(overlap(op.bounds!, existing.bounds)).toBe(false)
  })

  it('keeps the deliberate region and its literal sizing', () => {
    const region = { x: 180, y: 200, w: 540, h: 390 }
    const op = placeStudioOperation(plot, context([], {
      focus: { kind: 'region', bounds: region, targetIds: [] }, focusMode: 'literal',
    }), { zoom: 1 })
    expect(op.bounds).toEqual(region)
  })

  it('keeps reference-region plots naturally proportioned instead of stretching to the circle', () => {
    const region = { x: 500, y: 200, w: 80, h: 100 }
    const op = placeStudioOperation(plot, context([], {
      focus: { kind: 'region', bounds: region, targetIds: [] }, focusMode: 'reference',
    }), { zoom: 1 })
    expect(op.bounds).toEqual({ x: 320, y: 90, w: 440, h: 320 })
  })

  it('treats a point as a cue, so tapping an existing object does not stack another on it', () => {
    const existing = object('a', { x: 100, y: 80, w: 440, h: 320 })
    const op = placeStudioOperation(plot, context([existing], {
      focus: { kind: 'point', bounds: { x: 300, y: 200, w: 1, h: 1 }, targetIds: ['a'] },
    }), { zoom: 1 })
    expect(overlap(op.bounds!, existing.bounds)).toBe(false)
  })

  it('finds space on the active homework page even when its locked PDF image fills it', () => {
    const sheet = { x: 4000, y: 8000, w: 794, h: 1123 }
    const annotation = object('work', { x: 4040, y: 8040, w: 640, h: 280 })
    const objects = [object('paper', sheet, { kind: 'pdf_page', locked: true }), annotation]
    const op = placeStudioOperation(plot, context(objects), { zoom: 1, sheet })
    expect(inside(op.bounds!, sheet)).toBe(true)
    expect(overlap(op.bounds!, annotation.bounds)).toBe(false)
  })

  it('treats an A4 background as paper but keeps other locked images as obstacles', () => {
    const sheet = { x: 0, y: 0, w: 794, h: 1123 }
    const figure = object('figure', { x: 24, y: 24, w: 700, h: 400 }, { kind: 'image', locked: true })
    const op = placeStudioOperation(plot, context([object('paper', sheet, { kind: 'image', locked: true }), figure]), {
      zoom: 1, sheet, isBackground: id => id === 'paper',
    })
    expect(inside(op.bounds!, sheet)).toBe(true)
    expect(overlap(op.bounds!, figure.bounds)).toBe(false)
  })

  it('reports a full page instead of placing off the sheet or over annotations', () => {
    const sheet = { x: 0, y: 0, w: 794, h: 1123 }
    expect(() => placeStudioOperation(plot, context([object('work', sheet)]), { zoom: 1, sheet })).toThrow(/no free space/i)
  })

  it('rejects explicit placement outside the active document page', () => {
    const sheet = { x: 0, y: 0, w: 794, h: 1123 }
    expect(() => placeStudioOperation({ ...plot, bounds: { x: 900, y: 0, w: 440, h: 320 } }, context(), { zoom: 1, sheet })).toThrow(/beyond the current page/i)
  })

  it('can reveal page space covered by a panel without colliding with written work', () => {
    const sheet = { x: 0, y: 0, w: 794, h: 1123 }
    const annotation = object('work', { x: 24, y: 24, w: 700, h: 250 })
    const op = placeStudioOperation(plot, context([annotation]), { zoom: 1, sheet, avoid: [sheet] })
    expect(inside(op.bounds!, sheet)).toBe(true)
    expect(overlap(op.bounds!, annotation.bounds)).toBe(false)
  })
})
