import { describe, expect, it } from 'vitest'
import { Editor } from '../src/canvas/editor'
import { createBoardController, getPlacementBounds } from '../src/board/controller'
import { BOARD_INSTRUCTIONS, boardTools } from '../server/board-tools'
import type { BoardContext, BoardOperation } from '../shared/board'

function setup(focusMode: BoardContext['focusMode'] = 'reference') {
  const editor = new Editor()
  const context: BoardContext = {
    focusMode, focus: { kind: 'region', bounds: { x: 470, y: 250, w: 60, h: 300 }, targetIds: [] },
    pointer: { x: 500, y: 400 }, selectedIds: [], lastCreatedIds: [], objects: [],
    viewport: { x: 0, y: 0, w: 1000, h: 800 },
  }
  const controller = createBoardController(editor, () => ({ ...context, selectedIds: editor.getSelectedShapeIds() }))
  const create = (operations: BoardOperation[]) => {
    const result = controller.applyOperations(operations)
    expect(result.ok, result.message).toBe(true)
    return result.ids.map(id => editor.getShapePageBounds(id)!)
  }
  return { editor, context, controller, create }
}

describe('batch creation placement', () => {
  it('preserves the first anchor and uses each preceding width for mixed-size objects', () => {
    const { create, editor, context } = setup()
    const bounds = create([{ type: 'create_plot', expression: 'x=1' }, { type: 'create_geometry' }, { type: 'create_math', latex: 'x+1' }, { type: 'create_text', text: 'A note' }])
    expect(bounds[0]).toMatchObject(getPlacementBounds({ type: 'create_plot' }, context, 'plot'))
    expect(bounds.map(box => box.w)).toEqual([440, 270, 380, 340])
    bounds.slice(1).forEach((box, i) => {
      expect(box.x).toBeCloseTo(bounds[i].x + bounds[i].w + 24)
      expect(box.y + box.h / 2).toBe(400)
    })
    editor.undo()
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })
  it('uses rotated extents so neighboring shapes do not overlap after rotation', () => {
    const { create } = setup()
    const [first, second, third] = create([
      { type: 'create_plot', rotation: 45 },
      { type: 'create_geometry', rotation: 90 },
      { type: 'create_math', latex: 'x' },
    ])
    expect(second.x).toBeCloseTo(first.x + first.w + 24)
    expect(third.x).toBeCloseTo(second.x + second.w + 24)
  })
  it('avoids prior explicit creates but never changes an explicitly requested rectangle', () => {
    const { create } = setup()
    const explicit = { x: 200, y: 300, w: 600, h: 200 }
    const [first, second, third] = create([
      { type: 'create_text', bounds: explicit },
      { type: 'create_plot' },
      { type: 'create_geometry', bounds: explicit },
    ])
    expect(first).toMatchObject(explicit)
    expect(second.x).toBe(824)
    expect(third).toMatchObject(explicit)
  })
  it('uses an earlier create’s current virtual bounds after a transform in the same batch', () => {
    const { create } = setup()
    const bounds = create([
      { type: 'create_geometry' },
      { type: 'transform_object', target: 'last', bounds: { x: 100, y: 300, w: 800, h: 200 } },
      { type: 'create_text', text: 'Beside the wider shape' },
    ])
    expect(bounds[1].x).toBe(924)
  })
  it('does not repack existing board objects or unrelated explicit rows', () => {
    const { editor, create } = setup()
    editor.createShape({ id: 'shape:existing', type: 'magic', x: 0, y: 0, props: { w: 2000, h: 2000 } })
    const [first, second] = create([
      { type: 'create_geometry', bounds: { x: 400, y: 2000, w: 500, h: 300 } },
      { type: 'create_text', text: 'At the original cue' },
    ])
    expect(first.y).toBe(2000)
    expect(second.x).toBe(330)
    expect(editor.getShape('shape:existing')!.x).toBe(0)
  })
  it('keeps literal placement and its explicit containment checks unchanged', () => {
    const { context, create, controller } = setup('literal')
    context.focus!.bounds = { x: 0, y: 0, w: 500, h: 320 }
    const [first, second] = create([{ type: 'create_plot' }, { type: 'create_geometry' }])
    expect(first).toMatchObject(context.focus!.bounds)
    expect(second).toMatchObject(context.focus!.bounds)
    const outside = controller.applyOperations([{ type: 'create_text', bounds: { x: 480, y: 100, w: 200, h: 100 } }])
    expect(outside.ok).toBe(false)
    expect(outside.message).toMatch(/outside/)
  })
  it('asks the model to give requested arrangements real coordinates and frame full circles', () => {
    expect(BOARD_INSTRUCTIONS).toContain("For a requested spatial arrangement such as 'side by side', supply explicit, nonoverlapping bounds")
    expect(BOARD_INSTRUCTIONS).toContain('existing board objects are not repacked')
    expect(BOARD_INSTRUCTIONS).toContain('xMin:-6, xMax:6, yMin:-4, yMax:4 fits the full circle')
    const properties = (boardTools[0].parameters as any).properties.operations.items.properties
    expect(properties.bounds.description).toContain('spatial arrangement such as side by side')
  })
})
