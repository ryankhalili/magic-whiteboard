import type { BoardContext, BoardOperation, BoardResult } from '../../shared/board'
import { Editor, type TLShapeId } from '../canvas/editor'
import { createBoardController } from '../board/controller'
import type { MagicShape } from '../board/MagicShape'
import { uuid } from '../utils/uuid'

export const needsMathPreview = (ops: BoardOperation[]) => ops.some(op => op.type === 'create_plot' && !!op.visualization)
const edits = new Set(['update_object', 'edit_content', 'transform_object'])
const aliases = new Set(['selected', 'selection', 'last', 'focus'])

/** An isolated draft: no board mutation, persistence or history until confirmation. */
export class MathProposal {
  readonly id = `math-preview:${uuid()}`
  revision = 1
  readonly editor: Editor
  readonly context: BoardContext
  private readonly controller: ReturnType<typeof createBoardController>
  readonly ids: string[]

  constructor(board: Editor, context: BoardContext, operations: BoardOperation[]) {
    if (!operations.length || operations.length > 6 || operations.some(op => op.type !== 'create_plot' || !op.visualization || op.followPointer)) {
      throw new Error('Preview up to six complex plots together, separately from other edits. Ordinary equations and 2D graphs can be inserted directly.')
    }
    this.context = structuredClone(context)
    this.editor = new Editor(board.getSnapshot())
    this.controller = createBoardController(this.editor, () => this.context)
    const result = this.controller.applyOperations(operations)
    if (!result.ok) throw new Error(result.message)
    this.ids = result.ids
  }

  get shapes() { return this.ids.map(id => this.editor.getShape<MagicShape>(id as TLShapeId)!).filter(Boolean) }
  get objects() { return this.controller.getObjects().filter(o => this.ids.includes(o.id)) }
  get summary() { return { id: this.id, revision: this.revision, objectIds: this.ids } }

  targets(operations: BoardOperation[]) {
    return operations.some(op => edits.has(op.type) && (
      op.ids?.some(id => this.ids.includes(id)) || op.target && this.ids.includes(op.target)
      || !op.ids?.length && (!op.target || aliases.has(op.target))
    ))
  }

  revise(operations: BoardOperation[]): BoardResult {
    const pinned = operations.map(op => {
      if (!edits.has(op.type) || op.followPointer) throw new Error('Adjust the preview separately from other board actions.')
      const ids = op.ids?.length ? op.ids : op.target && !aliases.has(op.target) ? [op.target] : this.ids
      if (!ids.length || ids.some(id => !this.ids.includes(id))) throw new Error('A preview edit can only change its draft objects. The board was kept unchanged.')
      return { ...op, target: undefined, ids }
    })
    const originalContext = this.context
    const controller = createBoardController(this.editor, () => ({ ...originalContext, selectedIds: this.ids, lastCreatedIds: this.ids,
      focus: originalContext.focus && { ...originalContext.focus, targetIds: this.ids }, objects: this.controller.getObjects(),
    }))
    const result = controller.applyOperations(pinned)
    if (result.ok) this.revision++
    return result.ok ? this.result('Preview updated. Say “add it” or use Add to board when ready.') : result
  }

  result(message = 'Math preview ready. Nothing has been inserted. Adjust it by voice, then say “add it” or use Add to board.'): BoardResult {
    return { ok: true, message, ids: [], objects: this.objects }
  }

  /** Recreate only the approved new plots. Never replace a notebook snapshot. */
  operations(id: string | undefined, revision: number | undefined): BoardOperation[] {
    if (id !== this.id || revision !== this.revision) throw new Error('The preview changed. Review its current version before adding it.')
    return this.shapes.map(shape => {
      const p = shape.props
      // Creation bounds describe the unrotated box around its center, while
      // stored x/y describe the rotated local origin.
      const c = Math.cos(shape.rotation), s = Math.sin(shape.rotation)
      const x = shape.x + c * p.w / 2 - s * p.h / 2 - p.w / 2
      const y = shape.y + s * p.w / 2 + c * p.h / 2 - p.h / 2
      return { type: 'create_plot', expression: p.expression, visualization: p.visualization,
        bounds: { x, y, w: p.w, h: p.h }, rotation: shape.rotation * 180 / Math.PI,
        xMin: p.xMin, xMax: p.xMax, yMin: p.yMin, yMax: p.yMax, axisMode: 'auto',
        color: p.color, title: p.title, fontSize: p.fontSize, strokeWidth: p.strokeWidth, opacity: shape.opacity,
        showAxes: p.showAxes, showGrid: p.showGrid, showNumbers: p.showNumbers }
    })
  }
}
