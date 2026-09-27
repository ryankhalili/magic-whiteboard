import { createShapeId, type Editor, type TLShape, type TLShapeId, type TLShapePartial, type TLCreateShapePartial } from '../canvas/editor'
import type { BoardContext, BoardObject, BoardOperation, BoardResult, Bounds } from '../../shared/board'
import { DEFAULT_MAGIC_PROPS, type MagicShape, type MagicShapeProps } from './MagicShape'
import { autoYRange, validateDomain, validateExpression } from './expression'
import { applyContentEdit } from './contentEdit'
import { getAxisMode, getPlotLayout } from './plotLayout'
import { containsBounds, shapePageBounds } from './spatial'
import katex from 'katex'

const geometryTypes = new Set(['triangle', 'right_triangle', 'rectangle', 'ellipse', 'arrow'])
const kinds: Record<string, MagicShapeProps['kind']> = { create_plot: 'plot', create_math: 'math', create_text: 'text', create_geometry: 'geometry' }
const operationTypes = new Set([...Object.keys(kinds), 'update_object', 'edit_content', 'transform_object', 'delete_objects', 'undo', 'redo'])
const stringProps = ['expression', 'latex', 'text', 'title', 'color', 'geometry'] as const
const numericProps = ['xMin', 'xMax', 'yMin', 'yMax', 'fontSize'] as const

function validateBounds(bounds: Bounds): Bounds {
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || Math.abs(bounds.x) > 1e7 || Math.abs(bounds.y) > 1e7 || bounds.w < 16 || bounds.h < 16 || bounds.w > 10000 || bounds.h > 10000) throw new Error('Object bounds need a finite position and a size from 16 to 10,000 pixels.')
  return bounds
}

function literalRegion(context: BoardContext): Bounds | null {
  if (context.focusMode !== 'literal') return null
  if (context.focus?.kind !== 'region') throw new Error('Circle an area first when using literal focus.')
  const bounds = context.focus.bounds
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w < 16 || bounds.h < 16) throw new Error('The literal focus area is too small. Circle a larger area.')
  return bounds
}

function requireInside(region: Bounds | null, bounds: Bounds, subject = 'That change') {
  if (region && !containsBounds(region, bounds)) throw new Error(`${subject} extends outside the literal focus area. Circle a larger area or switch to reference focus.`)
}

function requireLiteralSize(bounds: Bounds, kind: MagicShapeProps['kind']) {
  const minimum = kind === 'plot' ? { w: 160, h: 140 } : kind === 'geometry' ? { w: 80, h: 80 } : { w: 80, h: 48 }
  if (bounds.w < minimum.w || bounds.h < minimum.h) throw new Error(`The literal focus area or requested object is too small for this ${kind}. Use at least ${minimum.w} × ${minimum.h}.`)
}

export function resolveTargetIds(operation: BoardOperation, context: BoardContext, availableIds: Iterable<string>): string[] {
  const available = new Set(availableIds)
  let ids: string[]
  if (operation.ids?.length) ids = operation.ids
  else if (operation.target && !['selected', 'selection', 'last', 'focus'].includes(operation.target)) ids = [operation.target]
  else if (operation.target === 'last') ids = context.lastCreatedIds
  else if (operation.target === 'selected' || operation.target === 'selection') ids = context.selectedIds
  else if (operation.target === 'focus') ids = context.focus?.targetIds ?? []
  else ids = context.selectedIds.length ? context.selectedIds : context.focus?.targetIds.length ? context.focus.targetIds : context.lastCreatedIds
  ids = [...new Set(ids)]
  if (!ids.length) throw new Error('Select an object or point at one before asking me to change it.')
  if (ids.some(id => !available.has(id))) throw new Error('The selected object no longer exists. Select it again.')
  return ids
}

export function getPlacementBounds(operation: BoardOperation, context: BoardContext, kind: MagicShapeProps['kind'], index = 0): Bounds {
  const region = literalRegion(context)
  if (operation.bounds) {
    const bounds = validateBounds(operation.bounds)
    requireInside(region, bounds)
    if (region) requireLiteralSize(bounds, kind)
    return bounds
  }
  const size = kind === 'plot' ? { w: 440, h: 320 } : kind === 'math' ? { w: 380, h: 145 } : kind === 'geometry' ? { w: 270, h: 230 } : { w: 340, h: 150 }
  if (region && operation.placement !== 'pointer' && operation.placement !== 'auto') {
    requireLiteralSize(region, kind)
    return validateBounds({ ...region })
  }
  const point = operation.placement === 'pointer' && context.pointer ? context.pointer
    : operation.placement !== 'auto' && context.focus ? { x: context.focus.bounds.x + context.focus.bounds.w / 2, y: context.focus.bounds.y + context.focus.bounds.h / 2 }
      : { x: context.viewport.x + context.viewport.w / 2, y: context.viewport.y + context.viewport.h / 2 }
  const bounds = validateBounds({ x: point.x - size.w / 2 + index * 24, y: point.y - size.h / 2 + index * 24, ...size })
  requireInside(region, bounds)
  return bounds
}

function propsFromOperation(operation: BoardOperation, original: MagicShapeProps): MagicShapeProps {
  const p = { ...original }
  for (const key of stringProps) {
    const value = operation[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > (key === 'latex' || key === 'text' ? 6000 : 300)) throw new Error(`The ${key} value is invalid or too long.`)
      Object.assign(p, { [key]: value })
    }
  }
  for (const key of numericProps) {
    const value = operation[key]
    if (value !== undefined) { if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number.`); p[key] = value }
  }
  if (p.fontSize < 8 || p.fontSize > 160) throw new Error('Font size must be between 8 and 160.')
  if (!/^#[0-9a-f]{3,8}$/i.test(p.color) && !/^[a-z]{1,24}$/i.test(p.color)) throw new Error('Use a hex color or a named color.')
  if (!geometryTypes.has(p.geometry)) throw new Error('That geometry is not supported yet.')
  if (p.kind === 'plot') {
    p.expression = validateExpression(p.expression).expression
    validateDomain(p.xMin, p.xMax)
    const changedDomain = operation.expression !== undefined || operation.xMin !== undefined || operation.xMax !== undefined
    if (changedDomain && operation.yMin === undefined && operation.yMax === undefined) [p.yMin, p.yMax] = autoYRange(p.expression, p.xMin, p.xMax)
    validateDomain(p.xMin, p.xMax, p.yMin, p.yMax)
  }
  return p
}

type Plan = { creates: TLCreateShapePartial[]; updates: TLShapePartial[]; deletes: TLShapeId[]; touched: TLShapeId[]; nextLast: string[] }

export class BoardController {
  private lastIds: string[] = []
  constructor(private editor: Editor, private getContext: () => BoardContext) {}
  get lastCreatedIds() { return this.lastIds.filter(id => !!this.editor.getShape(id as TLShapeId)) }
  getObjects(): BoardObject[] {
    return this.editor.getCurrentPageShapesSorted().map(shape => {
      const b = this.editor.getShapePageBounds(shape), object: BoardObject = {
        id: shape.id, kind: shape.type === 'magic' ? shape.props.kind : shape.type,
        bounds: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : { x: shape.x, y: shape.y, w: 1, h: 1 },
        rotation: shape.rotation * 180 / Math.PI, locked: shape.isLocked,
      }
      if (shape.type === 'magic') {
        object.color = shape.props.color; object.title = shape.props.title; object.fontSize = shape.props.fontSize
        if (shape.props.kind === 'plot') {
          for (const key of ['expression', 'xMin', 'xMax', 'yMin', 'yMax'] as const) Object.assign(object, { [key]: shape.props[key] })
          object.axisMode = getAxisMode(shape.meta)
          object.displayedRange = getPlotLayout(shape.props, object.axisMode).range
        } else if (shape.props.kind === 'math') object.latex = shape.props.latex
        else if (shape.props.kind === 'text') object.text = shape.props.text
        else { object.geometry = shape.props.geometry; object.text = shape.props.text }
      }
      return object
    })
  }
  summarize() { return this.getObjects() }

  private prepare(operations: BoardOperation[], baseContext: BoardContext): Plan {
    const virtual = new Map<string, TLShape>(this.editor.getCurrentPageShapes().map(shape => [shape.id, shape]))
    const creates = new Map<TLShapeId, TLCreateShapePartial>(), updates = new Map<TLShapeId, TLShapePartial>(), deletes = new Set<TLShapeId>(), touched = new Set<TLShapeId>()
    const context = { ...baseContext, selectedIds: [...baseContext.selectedIds], lastCreatedIds: this.lastCreatedIds.length ? this.lastCreatedIds : baseContext.lastCreatedIds }
    const region = literalRegion(context)
    let createdCount = 0
    for (const operation of operations) {
      if (!operation || !operationTypes.has(operation.type)) throw new Error('That whiteboard action is not supported.')
      if (operation.axisMode !== undefined && !['equal', 'auto'].includes(operation.axisMode)) throw new Error('Axis mode must be equal or auto.')
      for (const key of ['rotation', 'rotateBy', 'scale', 'dx', 'dy'] as const) if (operation[key] !== undefined && !Number.isFinite(operation[key])) throw new Error(`${key} must be a finite number.`)
      if (kinds[operation.type]) {
        const kind = kinds[operation.type], b = getPlacementBounds(operation, context, kind, createdCount++)
        const props = propsFromOperation(operation, { ...DEFAULT_MAGIC_PROPS, kind, w: b.w, h: b.h })
        const id = createShapeId(), rotation = (operation.rotation ?? 0) * Math.PI / 180
        const shape: TLCreateShapePartial<MagicShape> = { id, type: 'magic',
          x: b.x + b.w / 2 - Math.cos(rotation) * b.w / 2 + Math.sin(rotation) * b.h / 2,
          y: b.y + b.h / 2 - Math.sin(rotation) * b.w / 2 - Math.cos(rotation) * b.h / 2, rotation, props,
          meta: { ...(kind === 'plot' ? { axisMode: operation.axisMode ?? 'equal' } : {}), ...(region ? { literalBounds: { ...region } } : {}) } }
        requireInside(region, shapePageBounds(this.editor, shape as MagicShape))
        creates.set(id, shape)
        virtual.set(id, { ...shape, props, isLocked: false, parentId: this.editor.getCurrentPageId() } as MagicShape)
        touched.add(id); context.selectedIds = [id]; context.lastCreatedIds = [id]
        continue
      }
      const ids = resolveTargetIds(operation, context, virtual.keys()) as TLShapeId[]
      let groupMove: { x: number; y: number } | null = null
      const destination = operation.placement === 'pointer' || operation.followPointer ? context.pointer
        : operation.placement === 'focus' && !operation.fitFocus && context.focus ? { x: context.focus.bounds.x + context.focus.bounds.w / 2, y: context.focus.bounds.y + context.focus.bounds.h / 2 } : null
      if (ids.length > 1 && destination) {
        const corners = ids.flatMap(id => {
          const shape = virtual.get(id)!, props = shape.props as { w?: number; h?: number }
          const box = shape.type !== 'draw' && typeof props.w === 'number' && typeof props.h === 'number'
            ? { x: 0, y: 0, w: props.w, h: props.h } : this.editor.getShapeGeometry(shape).bounds
          const parent = shape.parentId?.startsWith('shape:') && this.editor.getShape(id) ? this.editor.getShapeParentTransform(shape) : null
          return [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => {
            const point = { x: shape.x + Math.cos(shape.rotation) * x - Math.sin(shape.rotation) * y, y: shape.y + Math.sin(shape.rotation) * x + Math.cos(shape.rotation) * y }
            return parent ? parent.applyToPoint(point) : point
          })
        })
        const cx = (Math.min(...corners.map(p => p.x)) + Math.max(...corners.map(p => p.x))) / 2
        const cy = (Math.min(...corners.map(p => p.y)) + Math.max(...corners.map(p => p.y))) / 2
        groupMove = { x: destination.x - cx, y: destination.y - cy }
      }
      for (const id of ids) {
        const shape = virtual.get(id)!
        if (shape.isLocked || (this.editor.getShape(id) && this.editor.isShapeOrAncestorLocked(shape))) throw new Error('That object is locked. Unlock it before changing it.')
        requireInside(region, shapePageBounds(this.editor, shape), 'The selected object')
        if (operation.type === 'delete_objects') {
          virtual.delete(id); updates.delete(id); if (!creates.delete(id)) deletes.add(id); touched.delete(id)
          continue
        }
        if (operation.type !== 'update_object' && operation.type !== 'edit_content' && operation.type !== 'transform_object') throw new Error('Undo or redo must be a separate action.')
        if (shape.type !== 'magic' && (operation.type === 'update_object' || operation.type === 'edit_content')) throw new Error('Content editing is supported for equations, graphs, text, and geometry. Use the normal drawing tools for this object.')
        const next = { ...shape, props: { ...shape.props }, meta: { ...shape.meta } } as TLShape
        if (region) next.meta.literalBounds = { ...region }
        else delete next.meta.literalBounds
        if (next.type === 'magic') {
          if (operation.axisMode !== undefined) {
            if (next.props.kind !== 'plot') throw new Error('Axis mode applies to graphs only.')
            next.meta.axisMode = operation.axisMode
          }
          if (operation.type === 'edit_content') {
            const expected = next.props.kind === 'math' ? 'latex' : next.props.kind === 'plot' ? 'expression' : 'text'
            if (operation.field !== expected) throw new Error(`This object uses its ${expected} field.`)
            const content = applyContentEdit(next.props[expected], operation)
            if (expected === 'latex') {
              try { katex.renderToString(content, { throwOnError: true, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 }) }
              catch { throw new Error('That edit would make invalid LaTeX. Try selecting the complete math expression.') }
            }
            next.props = propsFromOperation({ ...operation, [expected]: content }, next.props)
          } else next.props = propsFromOperation(operation, next.props)
        }
        // A transform is anchored on the shape's center, so rotation does not make it jump.
        const boxProps = next.props as { w?: number; h?: number }
        const localGeometry = shape.type === 'draw' || typeof boxProps.w !== 'number' || typeof boxProps.h !== 'number' ? this.editor.getShapeGeometry(shape).bounds : null
        const localX = localGeometry?.x ?? 0, localY = localGeometry?.y ?? 0
        const oldWidth = localGeometry?.w ?? boxProps.w!
        const oldHeight = localGeometry?.h ?? boxProps.h!
        let width = oldWidth, height = oldHeight
        let cx = next.x + Math.cos(next.rotation) * (localX + oldWidth / 2) - Math.sin(next.rotation) * (localY + oldHeight / 2)
        let cy = next.y + Math.sin(next.rotation) * (localX + oldWidth / 2) + Math.cos(next.rotation) * (localY + oldHeight / 2)
        // Existing nested objects keep their parent coordinate system when voice points at page space.
        const nested = shape.parentId?.startsWith('shape:') && this.editor.getShape(id)
        const parentTransform = nested ? this.editor.getShapeParentTransform(shape) : null
        if (parentTransform) { const page = parentTransform.applyToPoint({ x: cx, y: cy }); cx = page.x; cy = page.y }
        if (operation.scale !== undefined) {
          if (operation.scale < .05 || operation.scale > 20) throw new Error('Scale must be between 0.05 and 20.')
          width *= operation.scale; height *= operation.scale
          if (next.type === 'magic' && (next.props.kind === 'math' || next.props.kind === 'text')) next.props.fontSize = Math.min(160, Math.max(8, next.props.fontSize * operation.scale))
        }
        const bounds = operation.bounds ?? (operation.fitFocus && context.focus?.kind === 'region' ? context.focus.bounds : undefined)
        if (operation.fitFocus && !bounds) throw new Error('Circle a region first so I know the size you want.')
        if (bounds) { validateBounds(bounds); width = bounds.w; height = bounds.h; cx = bounds.x + width / 2; cy = bounds.y + height / 2 }
        if (operation.placement === 'pointer' || operation.followPointer) {
          if (!context.pointer) throw new Error('Point somewhere on the board first.')
          if (groupMove) { cx += groupMove.x; cy += groupMove.y }
          else { cx = context.pointer.x; cy = context.pointer.y }
        } else if (operation.placement === 'focus' && !operation.fitFocus && context.focus) {
          if (groupMove) { cx += groupMove.x; cy += groupMove.y }
          else { cx = context.focus.bounds.x + context.focus.bounds.w / 2; cy = context.focus.bounds.y + context.focus.bounds.h / 2 }
        }
        cx += operation.dx ?? 0; cy += operation.dy ?? 0
        if (parentTransform) { const local = parentTransform.clone().invert().applyToPoint({ x: cx, y: cy }); cx = local.x; cy = local.y }
        if (operation.rotation !== undefined) next.rotation = operation.rotation * Math.PI / 180
        if (operation.rotateBy !== undefined) next.rotation += operation.rotateBy * Math.PI / 180
        next.rotation = ((next.rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        if (width !== oldWidth || height !== oldHeight) {
          if (shape.type === 'draw' || typeof boxProps.w !== 'number' || typeof boxProps.h !== 'number') throw new Error('Resize this drawing with its selection handles. Voice resizing currently supports boxed objects.')
          validateBounds({ x: cx, y: cy, w: width, h: height }); boxProps.w = width; boxProps.h = height
        }
        next.x = cx - Math.cos(next.rotation) * (localX + width / 2) + Math.sin(next.rotation) * (localY + height / 2)
        next.y = cy - Math.sin(next.rotation) * (localX + width / 2) - Math.cos(next.rotation) * (localY + height / 2)
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || Math.abs(next.x) > 1e7 || Math.abs(next.y) > 1e7) throw new Error('That move would put the object too far from the board.')
        if (region && next.type === 'magic') requireLiteralSize({ x: next.x, y: next.y, w: next.props.w, h: next.props.h }, next.props.kind)
        requireInside(region, shapePageBounds(this.editor, next))
        virtual.set(id, next)
        if (creates.has(id)) creates.set(id, { ...creates.get(id), x: next.x, y: next.y, rotation: next.rotation, props: next.props, meta: next.meta } as TLCreateShapePartial)
        else updates.set(id, { id, type: next.type, x: next.x, y: next.y, rotation: next.rotation, props: next.props, meta: next.meta } as TLShapePartial)
        touched.add(id)
      }
      context.selectedIds = ids.filter(id => virtual.has(id))
      context.lastCreatedIds = context.selectedIds.length ? context.selectedIds : context.lastCreatedIds.filter(id => virtual.has(id))
    }
    return { creates: [...creates.values()], updates: [...updates.values()], deletes: [...deletes], touched: [...touched], nextLast: context.lastCreatedIds }
  }

  applyOperations(operations: BoardOperation[]): BoardResult {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 20) return { ok: false, message: 'Send between 1 and 20 whiteboard actions.', ids: [] }
    if (operations.length === 1 && (operations[0].type === 'undo' || operations[0].type === 'redo')) {
      this.editor[operations[0].type](); return { ok: true, message: operations[0].type === 'undo' ? 'Undone.' : 'Redone.', ids: [], objects: this.getObjects() }
    }
    let plan: Plan
    try { plan = this.prepare(operations, this.getContext()) }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'That action could not be applied.', ids: [] } }
    const mark = this.editor.markHistoryStoppingPoint('magic-command')
    try {
      this.editor.run(() => {
        if (plan.creates.length) this.editor.createShapes(plan.creates)
        if (plan.updates.length) this.editor.updateShapes(plan.updates)
        if (plan.deletes.length) this.editor.deleteShapes(plan.deletes)
        if (plan.touched.length) this.editor.select(...plan.touched)
      })
      this.editor.markHistoryStoppingPoint('after-magic-command')
      this.lastIds = plan.nextLast
      return { ok: true, message: 'Whiteboard updated.', ids: plan.touched, objects: this.getObjects() }
    } catch (error) {
      this.editor.bailToMark(mark)
      return { ok: false, message: error instanceof Error ? error.message : 'The whiteboard could not apply that change.', ids: [] }
    }
  }
}

export function createBoardController(editor: Editor, getContext: () => BoardContext) { return new BoardController(editor, getContext) }
