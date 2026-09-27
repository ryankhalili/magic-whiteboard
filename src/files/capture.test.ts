import { describe, expect, it } from 'vitest'
import { Box, type Editor } from 'tldraw'
import { getCaptureBounds } from './capture'

const boxes: Record<string, Box> = { stroke1: new Box(90, 90, 70, 80), stroke2: new Box(150, 150, 60, 70) }
const editor = {
  getShapePageBounds: (id: string) => boxes[id],
  getViewportPageBounds: () => new Box(0, 0, 1000, 700),
} as unknown as Editor
const coordinates = (box: Box) => [box.x, box.y, box.w, box.h]

describe('vision crop framing', () => {
  it('includes complete strokes and gesture bounds when a circle only overlaps their edges', () => {
    const bounds = getCaptureBounds(editor, { kind: 'region', bounds: { x: 120, y: 110, w: 60, h: 70 }, targetIds: ['stroke1', 'stroke2'] })
    expect(coordinates(bounds)).toEqual([70, 70, 160, 170])
  })

  it('uses a focused object instead of the whole viewport for point selections', () => {
    const bounds = getCaptureBounds(editor, { kind: 'point', bounds: { x: 100, y: 100, w: 1, h: 1 }, targetIds: ['stroke1'] })
    expect(coordinates(bounds)).toEqual([70, 70, 110, 120])
  })

  it('pads an arbitrary region but preserves viewport fallback for an empty point', () => {
    expect(coordinates(getCaptureBounds(editor, { kind: 'region', bounds: { x: 100, y: 100, w: 100, h: 80 }, targetIds: [] }))).toEqual([84, 84, 132, 112])
    expect(coordinates(getCaptureBounds(editor, { kind: 'point', bounds: { x: 100, y: 100, w: 1, h: 1 }, targetIds: ['missing'] }))).toEqual([0, 0, 1000, 700])
  })
})
