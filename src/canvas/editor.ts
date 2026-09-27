import type { Bounds, Point } from '../../shared/board'
import { uuid } from '../utils/uuid'
import { Box, Matrix2d, getStrokeRadius, getStrokeWidth, hitStroke, strokePoints, transformBounds } from './geometry'
import { normalizeSnapshot } from './migration'
import type { AssetRecord, Camera, DocumentRecord, ImageExportOptions, ImageExportResult, MagicShapeProps, ShapeKind, TLEditorSnapshot, TLShape, TLShapeId, TLShapePartial, TLCreateShapePartial } from './types'
export * from './types'
export { Box, Matrix2d, colorValue, getStrokeWidth, strokePoints, transformBounds } from './geometry'

export const DefaultColorStyle = 'color'
export const DefaultSizeStyle = 'size'
export const createShapeId = (suffix?: string): TLShapeId => `shape:${suffix ?? uuid()}`
export const createAssetId = (suffix?: string): string => `asset:${suffix ?? uuid()}`
export const AssetRecordType = { createId: createAssetId }

const defaultMagic: MagicShapeProps = {
  w: 420, h: 300, kind: 'plot', expression: 'sin(x)', latex: '', text: '', title: '', color: '#111111',
  xMin: -Math.PI * 2, xMax: Math.PI * 2, yMin: -1.35, yMax: 1.35, geometry: 'triangle', fontSize: 28,
}
const clone = <T,>(value: T): T => structuredClone(value)
const isShape = (record: DocumentRecord | undefined): record is TLShape => record?.typeName === 'shape'
type DocumentState = { records: Map<string, DocumentRecord>; pageId: string }
type HistoryMark = { state: DocumentState; undoLength: number; redo: DocumentState[] }
type RunOptions = { history?: 'ignore' | 'record'; ignoreShapeLock?: boolean }
type ImageExporter = (editor: Editor, ids: TLShapeId[], options: ImageExportOptions) => Promise<ImageExportResult>

/** Portable application document and shared history, projected onto the Excalidraw interaction canvas. */
export class Editor {
  private records = new Map<string, DocumentRecord>()
  private pageId = 'page:main'
  private camera: Camera = { x: 0, y: 0, z: 1 }
  private viewport = new Box(0, 0, 1200, 800)
  private selected: string[] = []
  private editing: string | null = null
  private tool = 'select'
  private styles: { color: string; size: 's' | 'm' | 'l' | 'xl' | number } = { color: 'black', size: 'm' }
  private revision = 0
  private listeners = new Set<{ fn: () => void; scope: 'document' | 'all' }>()
  private batchDepth = 0
  private documentDirty = false
  private sessionDirty = false
  private ignoreHistory = false
  private ignoreLocks = false
  private pendingBefore: DocumentState | null = null
  private undoStack: DocumentState[] = []
  private redoStack: DocumentState[] = []
  private marks = new Map<string, HistoryMark>()
  private markCounter = 0
  private imageExporter: ImageExporter | null = null
  private handledEvents = new WeakSet<object>()
  private interactionCompleter: (() => void) | null = null
  private completingInteraction = false

  readonly user = { updateUserPreferences: (_preferences: unknown) => {} }
  readonly store = {
    listen: (fn: () => void, options?: { scope?: 'document' | 'all' | 'session'; source?: string }) => this.subscribe(fn, options?.scope === 'document' ? 'document' : 'all'),
    get: (id: string) => this.records.get(id),
    allRecords: () => [...this.records.values()],
  }

  constructor(snapshot?: unknown) {
    this.records.set(this.pageId, { id: this.pageId, typeName: 'page', name: 'Page 1', index: 0, meta: {} })
    if (snapshot) this.loadSnapshot(snapshot)
  }
  subscribe = (fn: () => void, scope: 'document' | 'all' = 'all') => {
    const listener = { fn, scope }; this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getRevision = () => this.revision
  setInteractionCompleter(handler: (() => void) | null): void { this.interactionCompleter = handler }
  completeInteraction(): void {
    if (this.completingInteraction || !this.interactionCompleter) return
    this.completingInteraction = true
    try { this.interactionCompleter() } finally { this.completingInteraction = false }
  }
  private changed(document = false) {
    this.documentDirty ||= document; this.sessionDirty = true
    if (!this.batchDepth) this.flush()
  }
  private flush() {
    if (!this.sessionDirty && !this.documentDirty) return
    const document = this.documentDirty
    this.documentDirty = false; this.sessionDirty = false; this.revision++
    for (const listener of [...this.listeners]) if (document || listener.scope === 'all') listener.fn()
  }
  private capture(): DocumentState { return { records: new Map(this.records), pageId: this.pageId } }
  private sameDocument(a: DocumentState, b: DocumentState) {
    return a.pageId === b.pageId && a.records.size === b.records.size && [...a.records].every(([id, record]) => b.records.get(id) === record)
  }
  private beforeMutation() {
    if (!this.ignoreHistory && !this.pendingBefore) { this.pendingBefore = this.capture(); this.redoStack = [] }
  }
  private pushUndo(state: DocumentState) {
    this.undoStack.push(state)
    if (this.undoStack.length > 100) {
      this.undoStack.shift()
      for (const mark of this.marks.values()) mark.undoLength = Math.max(0, mark.undoLength - 1)
    }
  }
  private finishHistory() {
    if (this.pendingBefore && !this.sameDocument(this.pendingBefore, this.capture())) {
      this.pushUndo(this.pendingBefore)
    }
    this.pendingBefore = null
  }
  private restore(state: DocumentState) {
    this.records = new Map(state.records); this.pageId = state.pageId
    this.selected = this.selected.filter(id => !!this.getShape(id))
    if (this.editing && !this.getShape(this.editing)) this.editing = null
    this.changed(true)
  }
  markHistoryStoppingPoint(_name = 'Edit') {
    this.finishHistory()
    const id = `history:${++this.markCounter}`
    this.marks.set(id, { state: this.capture(), undoLength: this.undoStack.length, redo: [...this.redoStack] })
    if (this.marks.size > 150) this.marks.delete(this.marks.keys().next().value!)
    return id
  }
  squashToMark(id: string) {
    const mark = this.marks.get(id)
    if (!mark) return this
    this.finishHistory(); this.undoStack.length = Math.min(this.undoStack.length, mark.undoLength)
    if (!this.sameDocument(mark.state, this.capture())) this.pushUndo(mark.state)
    return this
  }
  bailToMark(id: string) {
    const mark = this.marks.get(id)
    if (!mark) return this
    this.pendingBefore = null; this.undoStack.length = Math.min(this.undoStack.length, mark.undoLength); this.redoStack = [...mark.redo]
    this.restore(mark.state); return this
  }
  undo() {
    this.finishHistory()
    const previous = this.undoStack.pop()
    if (previous) { this.redoStack.push(this.capture()); this.restore(previous) }
    return this
  }
  redo() {
    this.finishHistory()
    const next = this.redoStack.pop()
    if (next) { this.pushUndo(this.capture()); this.restore(next) }
    return this
  }
  run<T>(fn: () => T, options: RunOptions = {}): T {
    const state = this.capture(), selected = [...this.selected], editing = this.editing
    const pending = this.pendingBefore, previousIgnore = this.ignoreHistory, previousLocks = this.ignoreLocks
    const undo = [...this.undoStack], redo = [...this.redoStack]
    this.batchDepth++; this.ignoreHistory ||= options.history === 'ignore'; this.ignoreLocks ||= !!options.ignoreShapeLock
    try { return fn() }
    catch (error) {
      this.records = state.records; this.pageId = state.pageId; this.selected = selected; this.editing = editing
      this.pendingBefore = pending; this.undoStack = undo; this.redoStack = redo; this.documentDirty = true; this.sessionDirty = true
      throw error
    } finally { this.batchDepth--; this.ignoreHistory = previousIgnore; this.ignoreLocks = previousLocks; if (!this.batchDepth) this.flush() }
  }

  getCurrentPageId() { return this.pageId }
  private belongsToPage(shape: TLShape) {
    let parent = shape.parentId; const seen = new Set<string>([shape.id])
    while (parent?.startsWith('shape:')) {
      if (seen.has(parent)) return false
      seen.add(parent); const ancestor = this.getShape(parent)
      if (!ancestor) return false
      parent = ancestor.parentId
    }
    return parent === this.pageId
  }
  getCurrentPageShapes(): TLShape[] { return [...this.records.values()].filter(isShape).filter(shape => this.belongsToPage(shape)) }
  getCurrentPageShapesSorted(): TLShape[] {
    const shapes = this.getCurrentPageShapes()
    const compare = (a: TLShape, b: TLShape) => typeof a.index === 'number' && typeof b.index === 'number' ? a.index - b.index
      : typeof a.index === 'number' ? 1 : typeof b.index === 'number' ? -1 : a.index < b.index ? -1 : a.index > b.index ? 1 : 0
    const children = new Map<string, TLShape[]>()
    for (const shape of shapes) { const list = children.get(shape.parentId) ?? []; list.push(shape); children.set(shape.parentId, list) }
    const ordered: TLShape[] = []
    const add = (parentId: string) => { for (const shape of (children.get(parentId) ?? []).sort(compare)) { ordered.push(shape); add(shape.id) } }
    add(this.pageId); return ordered
  }
  getCurrentPageShapeIds() { return new Set(this.getCurrentPageShapes().map(s => s.id)) }
  getShape<S extends TLShape = TLShape>(id: TLShapeId | TLShape): S | undefined {
    if (typeof id !== 'string') return id as S
    const record = this.records.get(id); return isShape(record) ? record as S : undefined
  }
  getAsset(id: string | null): AssetRecord | undefined { const value = id ? this.records.get(id) : undefined; return value?.typeName === 'asset' ? value as AssetRecord : undefined }
  private nextIndex() { return Math.max(0, ...this.getCurrentPageShapes().map(s => typeof s.index === 'number' ? s.index : 0)) + 1 }
  private validateShape(shape: TLShape) {
    if (![shape.x, shape.y, shape.rotation, shape.opacity].every(Number.isFinite)) throw new Error('Object coordinates must be finite.')
    if (Math.abs(shape.x) > 1e7 || Math.abs(shape.y) > 1e7) throw new Error('Object position is outside the supported board.')
    const props = shape.props as { w?: number; h?: number }
    for (const n of [props.w, props.h]) if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 1e6)) throw new Error('Object dimensions must be finite and nonnegative.')
    if (shape.type === 'draw') {
      const points = strokePoints(shape.props)
      if (points.length > 100_000 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('This ink stroke contains invalid points.')
    }
    if (shape.parentId === shape.id) throw new Error('An object cannot contain itself.')
    let parent = shape.parentId; const seen = new Set([shape.id])
    while (parent?.startsWith('shape:')) {
      if (seen.has(parent)) throw new Error('An object cannot contain its own ancestor.')
      seen.add(parent); parent = this.getShape(parent)?.parentId ?? this.pageId
    }
  }
  createShape<S extends TLShape = TLShape>(partial: TLCreateShapePartial<S>) { return this.createShapes([partial] as TLCreateShapePartial[]) }
  createShapes(partials: TLCreateShapePartial[]) {
    return this.run(() => {
      for (const partial of partials) {
        const id = partial.id ?? createShapeId()
        if (this.records.has(id)) throw new Error('An object with this ID already exists.')
        const defaults = partial.type === 'magic' ? defaultMagic : partial.type === 'image' ? { w: 320, h: 240, assetId: null, altText: '' }
          : partial.type === 'draw' ? { points: [], color: this.styles.color, size: this.styles.size } : {}
        const shape = { typeName: 'shape', x: 0, y: 0, rotation: 0, parentId: this.pageId, index: this.nextIndex(), isLocked: false, opacity: 1, meta: {},
          ...clone(partial), id, props: { ...defaults, ...clone(partial.props ?? {}) } } as TLShape
        this.validateShape(shape); this.beforeMutation(); this.records.set(id, shape); this.changed(true)
      }
      return this
    })
  }
  updateShape<S extends TLShape = TLShape>(partial: TLShapePartial<S>) { return this.updateShapes([partial] as TLShapePartial[]) }
  updateShapes(partials: TLShapePartial[]) {
    return this.run(() => {
      for (const partial of partials) {
        const previous = this.getShape(partial.id)
        if (!previous || previous.type !== partial.type) continue
        if (!this.ignoreLocks && this.isShapeOrAncestorLocked(previous) && (partial.isLocked !== false || this.isShapeOrAncestorLocked(previous.parentId))) continue
        const next = { ...previous, ...clone(partial), props: { ...previous.props, ...clone(partial.props ?? {}) } } as TLShape
        this.validateShape(next)
        if (JSON.stringify(previous) === JSON.stringify(next)) continue
        this.beforeMutation(); this.records.set(next.id, next); this.changed(true)
      }
      return this
    })
  }
  deleteShapes(ids: TLShapeId[]) {
    return this.run(() => {
      const shapes = this.getCurrentPageShapes()
      const containsLockedChild = (id: string) => shapes.some(shape => {
        if (!shape.isLocked) return false
        let parent = shape.parentId
        while (parent.startsWith('shape:')) { if (parent === id) return true; parent = this.getShape(parent)?.parentId ?? this.pageId }
        return false
      })
      const remove = new Set(ids.filter(id => this.getShape(id) && (this.ignoreLocks || (!this.isShapeOrAncestorLocked(id) && !containsLockedChild(id)))))
      for (const shape of this.getCurrentPageShapes()) {
        let parent = shape.parentId
        while (parent.startsWith('shape:')) {
          if (remove.has(parent)) { remove.add(shape.id); break }
          parent = this.getShape(parent)?.parentId ?? this.pageId
        }
      }
      if (!remove.size) return this
      this.beforeMutation(); for (const id of remove) this.records.delete(id)
      this.selected = this.selected.filter(id => !remove.has(id)); if (this.editing && remove.has(this.editing)) this.editing = null
      this.changed(true); return this
    })
  }
  createAssets(assets: AssetRecord[]) {
    return this.run(() => { for (const asset of assets) { this.beforeMutation(); this.records.set(asset.id, clone(asset)); this.changed(true) } return this })
  }
  sendToBack(ids: TLShapeId[]) {
    const selected = new Set(ids), shapes = this.getCurrentPageShapesSorted()
    const reordered = [...shapes.filter(s => selected.has(s.id)), ...shapes.filter(s => !selected.has(s.id))]
    return this.updateShapes(reordered.map((shape, index) => ({ id: shape.id, type: shape.type, index } as TLShapePartial)))
  }
  isShapeOrAncestorLocked(value?: TLShape | TLShapeId) {
    let shape = value ? this.getShape(value) : undefined; const seen = new Set<string>()
    while (shape && !seen.has(shape.id)) { if (shape.isLocked) return true; seen.add(shape.id); shape = this.getShape(shape.parentId) }
    return false
  }
  select(...ids: TLShapeId[]) { this.selected = [...new Set(ids)].filter(id => !!this.getShape(id)); this.changed(); return this }
  selectNone() { return this.select() }
  getSelectedShapeIds() { return [...this.selected] }
  getSelectedShapes() { return this.selected.map(id => this.getShape(id)).filter((s): s is TLShape => !!s) }
  setEditingShape(id: TLShapeId | null) { this.editing = id && this.getShape(id) ? id : null; this.changed(); return this }
  getEditingShapeId() { return this.editing }
  setCurrentTool(tool: string, _options?: unknown) { this.tool = tool; this.changed(); return this }
  getCurrentToolId() { return this.tool }
  setStyleForNextShapes(style: string | { id: string }, value: string | number) {
    const key = typeof style === 'string' ? style : style.id
    if (key === 'color') this.styles.color = String(value)
    if (key === 'size') this.styles.size = value as typeof this.styles.size
    this.changed(); return this
  }
  getStyleForNextShapes() { return { ...this.styles } }
  setStyleForSelectedShapes(style: string | { id: string }, value: string | number) {
    const key = typeof style === 'string' ? style : style.id
    return this.updateShapes(this.getSelectedShapes().filter(s => s.type === 'draw').map(s => ({ id: s.id, type: 'draw' as const, props: { [key]: value, ...(key === 'size' ? { strokeWidth: typeof value === 'number' ? value : getStrokeWidth({ size: value as 's' }) } : {}) } })))
  }
  updateInstanceState(_state: unknown) { return this }
  markEventAsHandled(event: object) { this.handledEvents.add(event); const native = (event as { nativeEvent?: object }).nativeEvent; if (native) this.handledEvents.add(native) }
  isEventHandled(event: object) { return this.handledEvents.has(event) }

  getShapeParentTransform(shape: TLShape) {
    const ancestors: TLShape[] = []; let parent = this.getShape(shape.parentId); const seen = new Set([shape.id])
    while (parent) { if (seen.has(parent.id)) throw new Error('Cyclic object hierarchy.'); seen.add(parent.id); ancestors.unshift(parent); parent = this.getShape(parent.parentId) }
    const matrix = new Matrix2d()
    for (const ancestor of ancestors) matrix.multiply(Matrix2d.From(ancestor.x, ancestor.y, ancestor.rotation))
    return matrix
  }
  getShapePageTransform(shapeOrId: TLShape | TLShapeId) {
    const shape = this.getShape(shapeOrId)
    return shape ? this.getShapeParentTransform(shape).multiply(Matrix2d.From(shape.x, shape.y, shape.rotation)) : new Matrix2d()
  }
  getPointInParentSpace(shape: TLShape, point: Point) { return this.getShapeParentTransform(shape).invert().applyToPoint(point) }
  getShapeGeometry(shapeOrId: TLShape | TLShapeId): { bounds: Box } {
    const shape = this.getShape(shapeOrId)
    if (!shape) return { bounds: new Box() }
    if (shape.type === 'draw') {
      const points = strokePoints(shape.props), box = Box.From(points), pad = getStrokeRadius(shape.props)
      return { bounds: new Box(box.x - pad, box.y - pad, Math.max(.1, box.w) + pad * 2, Math.max(.1, box.h) + pad * 2) }
    }
    if (shape.type === 'group') {
      const children = this.getCurrentPageShapes().filter(s => s.parentId === shape.id)
      return { bounds: Box.Common(children.map(child => transformBounds(this.getShapeGeometry(child).bounds, Matrix2d.From(child.x, child.y, child.rotation)))) }
    }
    const props = shape.props as { w?: number; h?: number }
    return { bounds: new Box(0, 0, props.w ?? 100, props.h ?? 100) }
  }
  getShapePageBounds(shapeOrId: TLShape | TLShapeId) {
    const shape = this.getShape(shapeOrId)
    return shape ? transformBounds(this.getShapeGeometry(shape).bounds, this.getShapePageTransform(shape)) : undefined
  }
  getShapeAtPoint(point: Point, options: { hitInside?: boolean; margin?: number; filter?: (shape: TLShape) => boolean } = {}) {
    const margin = options.margin ?? 0
    for (const shape of this.getCurrentPageShapesSorted().reverse()) {
      if (shape.type === 'group' || (options.filter && !options.filter(shape))) continue
      const local = this.getShapePageTransform(shape).invert().applyToPoint(point)
      if (!this.getShapeGeometry(shape).bounds.containsPoint(local, margin)) continue
      if (shape.type === 'draw') {
        const segments = shape.props.segments?.length ? shape.props.segments.map(segment => segment.points) : [strokePoints(shape.props)]
        if (!segments.some(points => hitStroke(local, points, margin + getStrokeRadius(shape.props)))) continue
      }
      return shape
    }
    return undefined
  }
  getCamera() { return { ...this.camera } }
  setCamera(camera: Camera, _options?: unknown) {
    if (![camera.x, camera.y, camera.z].every(Number.isFinite)) return this
    this.camera = { x: camera.x, y: camera.y, z: Math.max(.05, Math.min(8, camera.z)) }; this.changed(); return this
  }
  getZoomLevel() { return this.camera.z }
  setViewportScreenBounds(bounds: Bounds) {
    if ([bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) && bounds.w > 0 && bounds.h > 0) {
      const next = new Box(bounds.x, bounds.y, bounds.w, bounds.h)
      if (JSON.stringify(next) !== JSON.stringify(this.viewport)) { this.viewport = next; this.changed() }
    }
    return this
  }
  getViewportScreenBounds() { return this.viewport.clone() }
  getViewportPageBounds() { return new Box(-this.camera.x, -this.camera.y, this.viewport.w / this.camera.z, this.viewport.h / this.camera.z) }
  screenToPage(point: Point) { return { x: (point.x - this.viewport.x) / this.camera.z - this.camera.x, y: (point.y - this.viewport.y) / this.camera.z - this.camera.y } }
  pageToScreen(point: Point) { return { x: this.viewport.x + (point.x + this.camera.x) * this.camera.z, y: this.viewport.y + (point.y + this.camera.y) * this.camera.z } }
  private zoomBy(factor: number) {
    const center = this.getViewportPageBounds().center, z = Math.max(.05, Math.min(8, this.camera.z * factor))
    return this.setCamera({ x: this.viewport.w / z / 2 - center.x, y: this.viewport.h / z / 2 - center.y, z })
  }
  zoomIn() { return this.zoomBy(1.2) }
  zoomOut() { return this.zoomBy(1 / 1.2) }
  zoomToBounds(bounds: Bounds, options?: { inset?: number; animation?: { duration: number } }) {
    const inset = options?.inset ?? 48
    if (bounds.w <= 0 || bounds.h <= 0) return this
    const z = Math.max(.05, Math.min(8, (this.viewport.w - inset * 2) / bounds.w, (this.viewport.h - inset * 2) / bounds.h))
    return this.setCamera({ x: this.viewport.w / z / 2 - bounds.x - bounds.w / 2, y: this.viewport.h / z / 2 - bounds.y - bounds.h / 2, z })
  }
  zoomToFit() {
    const boxes = this.getCurrentPageShapes().map(s => this.getShapePageBounds(s)!)
    return boxes.length ? this.zoomToBounds(Box.Common(boxes), { inset: 96 }) : this.setCamera({ x: 0, y: 0, z: 1 })
  }
  getSnapshot(): TLEditorSnapshot {
    return clone({ document: { schema: { schemaVersion: 1, engine: 'magic-whiteboard' }, store: Object.fromEntries(this.records) },
      session: { currentPageId: this.pageId, camera: this.camera, selectedShapeIds: this.selected } })
  }
  loadSnapshot(input: unknown) {
    const snapshot = normalizeSnapshot(input)
    const records = new Map(Object.entries(snapshot.document.store))
    const firstPage = [...records.values()].find(r => r.typeName === 'page')?.id
    const requested = snapshot.session?.currentPageId
    this.records = records; this.pageId = requested && records.get(requested)?.typeName === 'page' ? requested : firstPage ?? 'page:main'
    this.camera = snapshot.session?.camera ? { ...snapshot.session.camera } : { x: 0, y: 0, z: 1 }
    this.selected = (snapshot.session?.selectedShapeIds ?? []).filter(id => !!this.getShape(id)); this.editing = null
    this.pendingBefore = null; this.undoStack = []; this.redoStack = []; this.marks.clear(); this.changed(true); return this
  }
  setImageExporter(exporter: ImageExporter) { this.imageExporter = exporter; return this }
  toImage(ids: TLShapeId[], options: ImageExportOptions = {}) {
    if (!this.imageExporter) return Promise.reject(new Error('Image export is not ready yet.'))
    return this.imageExporter(this, ids, options)
  }
  dispose() { this.interactionCompleter = null; this.listeners.clear(); this.marks.clear(); this.undoStack = []; this.redoStack = []; this.pendingBefore = null }
}
