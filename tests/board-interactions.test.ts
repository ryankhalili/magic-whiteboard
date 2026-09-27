import { describe, expect, it } from 'vitest'
import type { Editor, TLShape } from 'tldraw'
import { finishPointerFollow, focusFromGesture, movePointerFollow, startPointerFollow } from '../src/board/interactions'

describe('magic pointer interactions', () => {
  it('places at the final tap without needing a preceding hover and respects parent space', () => {
    const shape = { id: 'shape:plot', type: 'magic', x: 10, y: 20, isLocked: false } as TLShape
    const changes: unknown[] = [], history: string[] = []
    const editor = {
      getShape: () => shape,
      getShapeParentTransform: () => ({ applyToPoint: (p: { x: number; y: number }) => ({ x: p.x + 100, y: p.y + 200 }) }),
      getPointInParentSpace: (_shape: TLShape, p: { x: number; y: number }) => ({ x: p.x - 100, y: p.y - 200 }),
      updateShapes: (items: unknown[]) => { changes.push(...items) },
      squashToMark: (mark: string) => { history.push(`squash:${mark}`) },
      markHistoryStoppingPoint: (mark: string) => { history.push(mark) },
    } as unknown as Editor
    const follower = startPointerFollow(editor, [shape.id], { x: 150, y: 250 }, 'start-instruction')
    movePointerFollow(editor, follower, { x: 600, y: 700 })
    finishPointerFollow(editor, follower)
    expect(changes).toEqual([{ id: shape.id, type: 'magic', x: 460, y: 470 }])
    expect(history).toEqual(['squash:start-instruction', 'Place with pointer'])
  })

  it('ignores deleted objects during live movement', () => {
    let exists = true
    const shape = { id: 'shape:plot', type: 'magic', x: 10, y: 20, isLocked: false } as TLShape
    const changes: unknown[] = []
    const editor = {
      getShape: () => exists ? shape : undefined,
      getShapeParentTransform: () => ({ applyToPoint: (p: { x: number; y: number }) => p }),
      updateShapes: (items: unknown[]) => changes.push(...items),
    } as unknown as Editor
    const follower = startPointerFollow(editor, [shape.id], { x: 10, y: 20 }, 'start')
    exists = false
    movePointerFollow(editor, follower, { x: 100, y: 100 })
    expect(changes).toEqual([])
  })

  it('constrains pointer-follow as a group using rotated page bounds', () => {
    const shapes = [
      { id: 'shape:a', type: 'magic', x: 100, y: 20, rotation: Math.PI / 2, isLocked: false },
      { id: 'shape:b', type: 'magic', x: 160, y: 80, rotation: 0, isLocked: false },
    ] as TLShape[]
    let changes: Array<{ x: number; y: number }> = []
    const editor = {
      getShape: (id: string) => shapes.find(s => s.id === id),
      getShapeParentTransform: () => ({ applyToPoint: (p: { x: number; y: number }) => p }),
      // A is a 100×60 rectangle rotated clockwise at its origin.
      getShapePageBounds: (s: TLShape) => s.id === 'shape:a' ? { x: 40, y: 20, w: 60, h: 100 } : { x: 160, y: 80, w: 50, h: 50 },
      getPointInParentSpace: (_s: TLShape, p: { x: number; y: number }) => p,
      updateShapes: (items: typeof changes) => { changes = items },
    } as unknown as Editor
    const follower = startPointerFollow(editor, shapes.map(s => s.id), { x: 100, y: 100 }, 'start', { x: 0, y: 0, w: 300, h: 200 })
    expect(movePointerFollow(editor, follower, { x: 1000, y: 1000 })).toBe(true)
    // B ends at the bottom-right boundary. A keeps its original displacement.
    expect(changes.map(p => [p.x, p.y])).toEqual([[190, 90], [250, 150]])
    expect(changes[1].x - changes[0].x).toBe(60)
    expect(changes[1].y - changes[0].y).toBe(60)
    follower.constraint = { x: 0, y: 0, w: 100, h: 100 }
    changes = []
    expect(movePointerFollow(editor, follower, { x: 0, y: 0 })).toBe(false)
    expect(changes).toEqual([])
  })

  it('targets the object currently under the pen before a gesture ends', () => {
    const editor = { getZoomLevel: () => 1, getShapeAtPoint: () => ({ id: 'shape:new-target' }) } as unknown as Editor
    const focus = focusFromGesture(editor, { active: true, start: { x: 10, y: 20 }, current: { x: 10, y: 20 }, bounds: { x: 10, y: 20, w: 0, h: 0 } })
    expect(focus.targetIds).toEqual(['shape:new-target'])
    expect(focus.kind).toBe('point')
  })

  it('uses screen-size thresholds and excludes a locked homework background from lasso targets', () => {
    const shapes = [{ id: 'shape:graph', isLocked: false }, { id: 'shape:background', isLocked: true }]
    const editor = {
      getZoomLevel: () => .5, getCurrentPageShapes: () => shapes,
      getShapePageBounds: () => ({ x: 30, y: 30, w: 20, h: 20, center: { x: 40, y: 40 } }),
    } as unknown as Editor
    const focus = focusFromGesture(editor, { active: true, start: { x: 0, y: 0 }, current: { x: 80, y: 80 }, bounds: { x: 0, y: 0, w: 80, h: 80 } })
    expect(focus).toMatchObject({ kind: 'region', targetIds: ['shape:graph'] })
  })
  it('selects a symbol object when a lasso overlaps its edge without containing its center', () => {
    const editor = {
      getZoomLevel: () => 1, getCurrentPageShapes: () => [{ id: 'shape:equation', isLocked: false }],
      getShapePageBounds: () => ({ x: 50, y: 20, w: 300, h: 60, center: { x: 200, y: 50 } }),
    } as unknown as Editor
    const focus = focusFromGesture(editor, { active: true, start: { x: 20, y: 0 }, current: { x: 85, y: 100 }, bounds: { x: 20, y: 0, w: 65, h: 100 } })
    expect(focus.targetIds).toEqual(['shape:equation'])
  })
  it('keeps tapping tolerance constant in screen pixels when zoomed out', () => {
    let margin = 0
    const editor = { getZoomLevel: () => .5, getShapeAtPoint: (_point: unknown, options: { margin: number }) => { margin = options.margin; return undefined } } as unknown as Editor
    focusFromGesture(editor, { active: true, start: { x: 0, y: 0 }, current: { x: 0, y: 0 }, bounds: { x: 0, y: 0, w: 0, h: 0 } })
    expect(margin).toBe(24)
  })
})
