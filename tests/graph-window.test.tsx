import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { ObjectInspector } from '../src/board/ObjectInspector'
import { PlotGraphic } from '../src/board/PlotGraphic'
import type { MagicShape } from '../src/board/MagicShape'
import { renderShapesToSvg } from '../src/files/imageExporter'
import type { BoardContext } from '../shared/board'

function board() {
  const editor = new Editor()
  const controller = createBoardController(editor, (): BoardContext => ({
    focus: null, pointer: null, selectedIds: editor.getSelectedShapeIds(),
    lastCreatedIds: controller.lastCreatedIds, objects: [], viewport: editor.getViewportPageBounds(),
  }))
  controller.applyOperations([{ type: 'create_plot', expression: 'x^2', xMin: -20, xMax: 20, yMin: -50, yMax: 440, axisMode: 'equal' }])
  return { editor, controller }
}

describe('graph window across controls, persistence and export', () => {
  it('shows actual visible equal-unit Y limits in the inspector', () => {
    const { editor, controller } = board(), object = controller.getObjects()[0]
    const shape = editor.getShape<MagicShape>(object.id as MagicShape['id'])!
    const noop = () => {}
    const html = renderToStaticMarkup(<ObjectInspector editor={editor} object={object} shape={shape} editing={false} busy={false}
      execute={operations => controller.applyOperations(operations)} onCollapse={noop} onDeselect={noop} onEdit={noop}
      onNaturalSize={noop} onCleanInk={noop} onPlotInk={noop}/> )
    for (const [label, value] of [['Y minimum', object.displayedRange!.yMin], ['Y maximum', object.displayedRange!.yMax]] as const) {
      const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))![0]
      expect(Number(input.match(/value="([^"]+)"/)![1])).toBeCloseTo(value, 3)
    }
    expect(html).toContain('Fit curve')
  })
  it('fits with one undo step and keeps the same curve and axes in the board and export after reload', async () => {
    const { editor, controller } = board(), before = editor.getSnapshot()
    expect(controller.applyOperations([{ type: 'update_object', fitY: true }]).ok).toBe(true)
    const fitted = editor.getSnapshot()
    editor.undo()
    expect(editor.getSnapshot().document.store).toEqual(before.document.store)
    editor.redo()
    const restored = new Editor(editor.getSnapshot())
    expect(restored.getSnapshot().document.store).toEqual(fitted.document.store)
    const shape = restored.getCurrentPageShapes()[0] as MagicShape
    const live = renderToStaticMarkup(<PlotGraphic shape={shape}/> )
    const { svg } = await renderShapesToSvg(restored, [shape.id])
    expect(svg).toContain(live)
    expect(live).toContain('>0</text>')
    expect(live).toContain('>400</text>')
    expect(live).not.toContain('NaN')
  })
})
