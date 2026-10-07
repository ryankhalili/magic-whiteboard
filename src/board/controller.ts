import { createAssetId, createShapeId, type AssetRecord, type Editor, type TLImageShape, type TLShape, type TLShapeId, type TLShapePartial, type TLCreateShapePartial } from '../canvas/editor'
import type { BoardContext, BoardImage, BoardObject, BoardOperation, BoardResult, Bounds, PlacementOption } from '../../shared/board'
import { DEFAULT_MAGIC_PROPS, type MagicShape, type MagicShapeProps } from './MagicShape'
import { autoYRange, validateDomain, validateExpression } from './expression'
import { validateScientific } from '../math/scientific'
import { applyContentEdit, applyLatexContentEdit } from './contentEdit'
import { getAxisMode, getPlotLayout } from './plotLayout'
import { containsBounds, shapePageBounds } from './spatial'
import { resolveGeometry } from '../../shared/geometry'
import { validateColor, validateCrop, validateOpacity, validateStrokeWidth } from '../../shared/appearance'
import { validateLatex } from './latex'
import { pdfPageInfo } from '../files/pdfPages'
import { parseLibraryQuery } from '../library/search'
import type { LibraryQuery } from '../library/types'

const kinds: Record<string, MagicShapeProps['kind']> = { create_plot: 'plot', create_math: 'math', create_text: 'text', create_geometry: 'geometry' }
// insert_library and library_action are resolved by the app before they reach the board
const operationTypes = new Set([...Object.keys(kinds), 'create_image', 'update_object', 'edit_content', 'transform_object', 'delete_objects', 'undo', 'redo'])
const stringProps = ['expression', 'latex', 'text', 'title', 'color', 'geometry', 'fill'] as const
const numericProps = ['xMin', 'xMax', 'yMin', 'yMax', 'fontSize', 'fillOpacity', 'strokeWidth'] as const

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

export function getPlacementBounds(operation: BoardOperation, context: BoardContext, kind: MagicShapeProps['kind'], index = 0, priorCreatedBounds: readonly Bounds[] = []): Bounds {
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
  // a ranked free area, only offered when nothing is circled; A when the model did not choose one
  const optionId = operation.placementOption ?? 'A'
  const option = !region && !context.focus && operation.placement !== 'pointer'
    ? context.placementOptions?.find(o => o.id === optionId && isFiniteBox(o.bounds)) : undefined
  const point = option ? { x: option.bounds.x + option.bounds.w / 2, y: option.bounds.y + option.bounds.h / 2 }
    : operation.placement === 'pointer' && context.pointer ? context.pointer
      : operation.placement !== 'auto' && context.focus ? { x: context.focus.bounds.x + context.focus.bounds.w / 2, y: context.focus.bounds.y + context.focus.bounds.h / 2 }
        : { x: context.viewport.x + context.viewport.w / 2, y: context.viewport.y + context.viewport.h / 2 }
  // Literal pointer/auto placement retains its existing containment behavior.
  // Reference batches use actual prior object extents, including rotations and
  // earlier transforms in this transaction, rather than a diagonal index offset.
  const bounds = { x: point.x - size.w / 2 + (region ? index * 24 : 0), y: point.y - size.h / 2 + (region ? index * 24 : 0), ...size }
  if (!region && priorCreatedBounds.length) {
    const angle = (operation.rotation ?? 0) * Math.PI / 180
    const rotatedWidth = Math.abs(Math.cos(angle)) * size.w + Math.abs(Math.sin(angle)) * size.h
    const rotatedHeight = Math.abs(Math.sin(angle)) * size.w + Math.abs(Math.cos(angle)) * size.h
    const top = point.y - rotatedHeight / 2
    let left = point.x - rotatedWidth / 2
    const initialLeft = left
    for (const prior of [...priorCreatedBounds].sort((a, b) => a.x - b.x)) {
      const sameRow = top < prior.y + prior.h && top + rotatedHeight > prior.y
      if (sameRow && left < prior.x + prior.w + 24 && left + rotatedWidth + 24 > prior.x) left = prior.x + prior.w + 24
    }
    bounds.x += left - initialLeft
  }
  validateBounds(bounds)
  requireInside(region, bounds)
  return bounds
}

const isFiniteBox = (b: Bounds | undefined | null): b is Bounds => !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0

// fnv style 53 bit hash, so the same page or problem always maps to the same asset
function hashKey(text: string) {
  let a = 0xdeadbeef, b = 0x41c6ce57
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677) }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, '0')
}
/** Deterministic asset id for a rendered library image, so inserting it again reuses the bytes. */
export const libraryAssetId = (key: string) => createAssetId(`lib-${hashKey(key)}`)
/** Asset key of a detected item; a newer index draws it differently, so its image is never reused from an older one. */
export const libraryItemKey = (anchorId: string, indexVersion?: number) => (indexVersion ?? 1) > 1 ? `${anchorId}:item:v${indexVersion}` : `${anchorId}:item`

const IMAGE_SRC = /^data:image\/(png|jpeg);base64,[A-Za-z\d+/=]+$/
function validateImage(image: BoardImage | undefined): BoardImage {
  if (!image || typeof image.src !== 'string' || !IMAGE_SRC.test(image.src)) throw new Error('Only PNG or JPEG images can be added this way.')
  if (![image.w, image.h].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1e6)) throw new Error('This image has an invalid size.')
  return { src: image.src, w: image.w, h: image.h, mimeType: image.src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', name: String(image.name ?? 'Image').slice(0, 300) || 'Image' }
}
function plainMeta(meta: unknown): Record<string, unknown> {
  if (meta === undefined) return {}
  let copy: unknown
  try { const text = JSON.stringify(meta); copy = text && text.length <= 8000 ? JSON.parse(text) : null } catch { copy = null }
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('The image details are invalid.')
  return copy as Record<string, unknown>
}

export type LibraryImageKind = 'page' | 'item' | 'crop'
/** Board size of an inserted page or problem, and the work space to keep free below it. */
export function libraryImageSize(image: { w: number; h: number }, kind: LibraryImageKind): { w: number; h: number; workBelow: number } {
  const aspect = image.w > 0 && image.h > 0 && Number.isFinite(image.h / image.w) ? Math.min(40, Math.max(1 / 40, image.h / image.w)) : 1.3
  let w = kind === 'page' ? 700 : Math.min(640, Math.max(80, (image.w || 0) / 2))
  let h = w * aspect
  // very thin or very tall images still get a size the board accepts
  if (h < 16) { h = 16; w = Math.min(10000, 16 / aspect) }
  if (h > 10000) { h = 10000; w = Math.max(16, 10000 / aspect) }
  return { w, h, workBelow: kind === 'page' ? 0 : Math.max(260, 1.2 * h) }
}

/**
 * Where an image goes when the teacher has pointed or circled: reference mode puts it at the top left of the
 * area at its natural size; literal mode fits it inside the region. null when nothing is focused.
 */
export function focusImageBounds(size: { w: number; h: number }, context: BoardContext): Bounds | null {
  const region = literalRegion(context)
  if (region) {
    const scale = Math.min(1, region.w / size.w, region.h / size.h)
    const w = size.w * scale, h = size.h * scale
    if (w < 16 || h < 16) throw new Error('The circled area is too small for this. Circle a larger area.')
    return { x: region.x, y: region.y, w, h }
  }
  const focus = context.focus
  if (!focus || !isFiniteBox({ ...focus.bounds, w: Math.max(1, focus.bounds.w), h: Math.max(1, focus.bounds.h) })) return null
  return { x: focus.bounds.x, y: focus.bounds.y, w: size.w, h: size.h }
}

/** The free spot for a model's placementOption: the option itself when the image fits there, else the spot nearest it. */
export function spotForOption(option: PlacementOption, spots: readonly { bounds: Bounds }[], size: { w: number; h: number }): Bounds {
  let best: Bounds | null = null, distance = Infinity
  for (const spot of spots) {
    const d = Math.hypot(spot.bounds.x - option.bounds.x, spot.bounds.y - option.bounds.y)
    if (d < distance) { distance = d; best = spot.bounds }
  }
  return best ? { x: best.x, y: best.y, w: size.w, h: size.h } : { x: option.bounds.x, y: option.bounds.y, w: size.w, h: size.h }
}

/** The library request an insert_library operation refers to, or null when it names nothing. */
export function libraryQueryFromOperation(operation: BoardOperation): LibraryQuery | null {
  const book = typeof operation.book === 'string' && operation.book.trim() ? operation.book.trim().slice(0, 200) : undefined
  const withBook = (query: LibraryQuery): LibraryQuery => book && !query.book ? { ...query, book } : query
  const page = typeof operation.page === 'string' ? operation.page.trim() : ''
  if (page) {
    const label = page.replace(/^(?:pages?|pgs?\.?|p\.?)\s*/i, '').trim()
    if (!/^(\d{1,4}|[ivxlcdm]{1,8})$/i.test(label)) return null
    return withBook({ kind: 'page', label: /^\d/.test(label) ? String(Number(label)) : label.toLowerCase(), raw: `page ${label}` })
  }
  const item = typeof operation.item === 'string' ? operation.item.trim() : ''
  const extra = typeof operation.query === 'string' ? operation.query.trim().slice(0, 300) : ''
  if (item) {
    const parsed = parseLibraryQuery(item)
    if (parsed && parsed.kind === 'item') {
      // a section or chapter the model put in query instead ("exercise 48" plus "in section 5.1")
      const both = extra && !parsed.section && !parsed.chapter ? parseLibraryQuery(`${item} ${extra}`) : null
      return withBook(both?.kind === 'item' && both.label === parsed.label && (both.section || both.chapter) ? both : parsed)
    }
    const lone = /^(?:#|no\.?|number)?\s*(\d{1,3}(?:\.\d{1,3}){0,2})$/i.exec(item)
    if (lone) return withBook({ kind: 'item', label: lone[1], raw: item })
    return withBook(parsed ?? { kind: 'topic', terms: item, raw: item })
  }
  const query = typeof operation.query === 'string' ? operation.query.trim() : ''
  if (query) return withBook(parseLibraryQuery(query) ?? { kind: 'topic', terms: query, raw: query })
  return null
}

const KIND_TITLES: Record<string, string> = {
  example: 'Example', exercise: 'Exercise', problem: 'Problem', checkpoint: 'Checkpoint', section: 'Section', theorem: 'Theorem',
  definition: 'Definition', question: 'Question', figure: 'Figure', table: 'Table',
}
/** What an inserted library image is, from meta.library, for the model and the object list. */
function libraryObject(meta: Record<string, unknown>, height: number): { kind: string; title: string; workBelow?: number } | null {
  const value = meta.library
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const info = value as Record<string, unknown>
  const book = typeof info.title === 'string' ? info.title : 'Textbook'
  const index = typeof info.pageIndex === 'number' && Number.isInteger(info.pageIndex) ? info.pageIndex : null
  const page = typeof info.pageLabel === 'string' && info.pageLabel ? `page ${info.pageLabel}` : index !== null ? `file page ${index + 1}` : 'a page'
  if (info.kind === 'page') return { kind: 'textbook_page', title: `${book}, ${page}`.slice(0, 200) }
  // the work space kept free under a problem; older inserts get the size a new insert would get
  const stored = info.workBelow, workBelow = Math.min(10000, typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored
    : Number.isFinite(height) && height > 0 ? Math.max(260, 1.2 * height) : 260)
  if (info.kind === 'crop') return { kind: 'textbook_item', title: `Part of ${page}, ${book}`.slice(0, 200), workBelow }
  const name = typeof info.itemKind === 'string' ? KIND_TITLES[info.itemKind] ?? 'Item' : 'Item'
  const label = typeof info.itemLabel === 'string' && info.itemLabel ? ` ${info.itemLabel}` : ''
  return { kind: 'textbook_item', title: `${name}${label} (${page})`.slice(0, 200), workBelow }
}

function propsFromOperation(operation: BoardOperation, original: MagicShapeProps): MagicShapeProps {
  const p = { ...original }
  if (operation.visualization !== undefined) {
    if (p.kind !== 'plot') throw new Error('Scientific visualization settings apply to plots only.')
    p.visualization = { ...(original.visualization?.type === operation.visualization.type ? original.visualization : {}), ...operation.visualization }
    if (!original.visualization) {
      if (operation.strokeWidth === undefined) p.strokeWidth = operation.visualization.type === 'phase' ? 1.8 : .6
      if (operation.fontSize === undefined) p.fontSize = 16
    }
  }
  if (operation.fitY && p.kind !== 'plot') throw new Error('Fit curve applies to graphs only.')
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
  if (p.kind === 'math' && operation.latex !== undefined) p.latex = validateLatex(p.latex, true)
  validateColor(p.color)
  if (p.fill !== undefined) validateColor(p.fill)
  if (p.fillOpacity !== undefined) validateOpacity(p.fillOpacity)
  if (p.strokeWidth !== undefined) validateStrokeWidth(p.strokeWidth)
  for (const key of ['showGrid', 'showAxes', 'showNumbers'] as const) if (operation[key] !== undefined) {
    if (typeof operation[key] !== 'boolean') throw new Error(`${key} must be true or false.`)
    p[key] = operation[key]
  }
  if (p.kind === 'geometry') {
    const changedGeometry = operation.geometry !== undefined && operation.geometry !== original.geometry
    const replacing = operation.vertices !== undefined || operation.angles !== undefined || operation.sides !== undefined || changedGeometry
    const geometry = resolveGeometry({
      geometry: operation.geometry ?? (operation.angles || operation.sides || operation.vertices ? 'polygon' : p.geometry),
      vertices: operation.vertices ?? (replacing ? undefined : original.vertices),
      angles: operation.angles ?? (replacing ? undefined : original.angles),
      sides: operation.sides ?? (replacing ? undefined : original.sides),
    })
    p.geometry = geometry.geometry; p.vertices = geometry.vertices; p.angles = geometry.angles
    p.sides = geometry.geometry === 'polygon' ? geometry.vertices?.length : undefined
  }
  if (p.kind === 'plot') {
    if (p.visualization) {
      const checked = validateScientific(p.expression, p.visualization)
      p.expression = checked.expression; p.visualization = checked.spec
      if (operation.fitY) throw new Error('Set the domain bounds directly for a scientific visualization.')
      validateDomain(p.xMin, p.xMax, p.yMin, p.yMax)
      return p
    }
    p.expression = validateExpression(p.expression).expression
    if (operation.fitY && validateExpression(p.expression).kind === 'implicit') throw new Error('Choose explicit X and Y limits for an implicit equation; Fit curve supports y = f(x).')
    validateDomain(p.xMin, p.xMax)
    const changedDomain = operation.expression !== undefined || operation.xMin !== undefined || operation.xMax !== undefined
    if ((changedDomain || operation.fitY) && operation.yMin === undefined && operation.yMax === undefined) [p.yMin, p.yMax] = autoYRange(p.expression, p.xMin, p.xMax)
    validateDomain(p.xMin, p.xMax, p.yMin, p.yMax)
  }
  return p
}

type Plan = { creates: TLCreateShapePartial[]; updates: TLShapePartial[]; deletes: TLShapeId[]; pageDeletes: TLShapeId[]; touched: TLShapeId[]; nextLast: string[]; layers: { ids: TLShapeId[]; front: boolean }[]; assets: AssetRecord[]; locked: TLShapeId[] }

/** An inserted textbook page: locked like paper, but a mistaken insert can still be removed. */
export function isLibraryPage(shape: TLShape | undefined): boolean {
  const info = shape?.type === 'image' ? shape.meta?.library : undefined
  return !!info && typeof info === 'object' && (info as { kind?: unknown }).kind === 'page'
}

export class BoardController {
  private lastIds: string[] = []
  constructor(private editor: Editor, private getContext: () => BoardContext) {}
  get lastCreatedIds() { return this.lastIds.filter(id => !!this.editor.getShape(id as TLShapeId)) }
  getObjects(): BoardObject[] {
    return this.editor.getCurrentPageShapesSorted().map(shape => {
      const b = this.editor.getShapePageBounds(shape), object: BoardObject = {
        id: shape.id, kind: shape.type === 'magic' ? shape.props.kind : shape.type,
        bounds: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : { x: shape.x, y: shape.y, w: 1, h: 1 },
        rotation: shape.rotation * 180 / Math.PI, locked: shape.isLocked, opacity: shape.opacity ?? 1,
      }
      if (shape.type === 'magic') {
        object.color = shape.props.color; object.title = shape.props.title; object.fontSize = shape.props.fontSize
        for (const key of ['fill', 'fillOpacity', 'strokeWidth', 'showGrid', 'showAxes', 'showNumbers', 'vertices', 'angles', 'sides'] as const) Object.assign(object, { [key]: shape.props[key] })
        if (shape.props.kind === 'plot') {
          object.visualization = shape.props.visualization
          for (const key of ['expression', 'xMin', 'xMax', 'yMin', 'yMax'] as const) Object.assign(object, { [key]: shape.props[key] })
          object.axisMode = getAxisMode(shape.meta)
          object.displayedRange = getPlotLayout(shape.props, shape.props.visualization ? 'auto' : object.axisMode).range
        } else if (shape.props.kind === 'math') object.latex = shape.props.latex
        else if (shape.props.kind === 'text') object.text = shape.props.text
        else { object.geometry = shape.props.geometry; object.text = shape.props.text }
      } else if (shape.type === 'image') {
        object.crop = shape.props.crop
        const pdf = pdfPageInfo(shape), book = pdf ? null : libraryObject(shape.meta, object.bounds.h)
        if (pdf) {
          object.kind = 'pdf_page'
          object.title = `Worksheet page ${pdf.page} of ${pdf.pages}: ${pdf.name}`.slice(0, 200)
          if (pdf.text) object.text = pdf.text
        } else if (book) {
          object.kind = book.kind; object.title = book.title
          if (book.workBelow) object.workBelow = book.workBelow
        }
      } else if (shape.type === 'draw') { object.color = shape.props.color; object.strokeWidth = shape.props.strokeWidth }
      return object
    })
  }
  summarize() { return this.getObjects() }

  private prepare(operations: BoardOperation[], baseContext: BoardContext): Plan {
    const virtual = new Map<string, TLShape>(this.editor.getCurrentPageShapes().map(shape => [shape.id, shape]))
    const creates = new Map<TLShapeId, TLCreateShapePartial>(), updates = new Map<TLShapeId, TLShapePartial>(), deletes = new Set<TLShapeId>(), pageDeletes = new Set<TLShapeId>(), touched = new Set<TLShapeId>()
    const context = { ...baseContext, selectedIds: [...baseContext.selectedIds], lastCreatedIds: this.lastCreatedIds.length ? this.lastCreatedIds : baseContext.lastCreatedIds }
    const layers: Plan['layers'] = []
    const assets = new Map<string, AssetRecord>(), locked: TLShapeId[] = []
    const region = literalRegion(context)
    let createdCount = 0
    for (const operation of operations) {
      if (!operation || !operationTypes.has(operation.type)) throw new Error('That whiteboard action is not supported.')
      if (operation.type === 'create_image') {
        const image = validateImage(operation.image)
        if (!operation.bounds) throw new Error('An image needs a place on the board.')
        const b = validateBounds({ x: operation.bounds.x, y: operation.bounds.y, w: operation.bounds.w, h: operation.bounds.h })
        requireInside(region, b)
        const meta = plainMeta(operation.meta)
        const assetId = typeof meta.assetKey === 'string' && meta.assetKey ? libraryAssetId(meta.assetKey) : createAssetId()
        if (!this.editor.getAsset(assetId) && !assets.has(assetId)) assets.set(assetId, {
          id: assetId, typeName: 'asset', type: 'image', meta: {},
          props: { name: image.name, src: image.src, w: image.w, h: image.h, mimeType: image.mimeType, isAnimated: false },
        })
        const id = createShapeId(), isLocked = operation.locked === true
        const shape: TLCreateShapePartial<TLImageShape> = { id, type: 'image', x: b.x, y: b.y, rotation: 0, isLocked, opacity: 1,
          props: { assetId, w: b.w, h: b.h, altText: image.name }, meta: { ...meta, marginaliaBackground: false } }
        creates.set(id, shape)
        virtual.set(id, { ...shape, index: 0, parentId: this.editor.getCurrentPageId() } as TLImageShape)
        createdCount++
        // a locked page is written on, not selected
        if (isLocked) { locked.push(id); context.selectedIds = [] }
        else { touched.add(id); context.selectedIds = [id] }
        context.lastCreatedIds = [id]
        continue
      }
      if (operation.axisMode !== undefined && !['equal', 'auto'].includes(operation.axisMode)) throw new Error('Axis mode must be equal or auto.')
      if (operation.fitY !== undefined && typeof operation.fitY !== 'boolean') throw new Error('Fit Y must be true or false.')
      if (operation.opacity !== undefined) validateOpacity(operation.opacity)
      if (operation.layer !== undefined && !['front', 'back'].includes(operation.layer)) throw new Error('Choose front or back for the object layer.')
      if (operation.crop !== undefined) validateCrop(operation.crop)
      for (const key of ['rotation', 'rotateBy', 'scale', 'dx', 'dy'] as const) if (operation[key] !== undefined && !Number.isFinite(operation[key])) throw new Error(`${key} must be a finite number.`)
      if (kinds[operation.type]) {
        if (operation.crop !== undefined) throw new Error('Cropping applies to images only.')
        const priorCreatedBounds = [...creates.keys()].map(id => shapePageBounds(this.editor, virtual.get(id)!))
        const kind = kinds[operation.type], b = getPlacementBounds(operation, context, kind, createdCount++, priorCreatedBounds)
        const props = propsFromOperation(operation, { ...DEFAULT_MAGIC_PROPS, kind, w: b.w, h: b.h })
        const id = createShapeId(), rotation = (operation.rotation ?? 0) * Math.PI / 180
        const shape: TLCreateShapePartial<MagicShape> = { id, type: 'magic', opacity: operation.opacity ?? 1,
          x: b.x + b.w / 2 - Math.cos(rotation) * b.w / 2 + Math.sin(rotation) * b.h / 2,
          y: b.y + b.h / 2 - Math.sin(rotation) * b.w / 2 - Math.cos(rotation) * b.h / 2, rotation, props,
          meta: { ...(kind === 'plot' ? { axisMode: operation.fitY ? 'auto' : operation.axisMode ?? 'auto' } : {}), ...(region ? { literalBounds: { ...region } } : {}) } }
        requireInside(region, shapePageBounds(this.editor, shape as MagicShape))
        creates.set(id, shape)
        virtual.set(id, { ...shape, props, isLocked: false, parentId: this.editor.getCurrentPageId() } as MagicShape)
        touched.add(id); context.selectedIds = [id]; context.lastCreatedIds = [id]
        if (operation.layer) layers.push({ ids: [id], front: operation.layer === 'front' })
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
        // shapes made earlier in this plan are still being placed, so a locked new page can be scaled or moved
        const removablePage = operation.type === 'delete_objects' && isLibraryPage(shape) && !(this.editor.getShape(id) && this.editor.isShapeOrAncestorLocked(shape.parentId))
        if (!creates.has(id) && !removablePage && (shape.isLocked || (this.editor.getShape(id) && this.editor.isShapeOrAncestorLocked(shape)))) throw new Error('That object is locked. Unlock it before changing it.')
        requireInside(region, shapePageBounds(this.editor, shape), 'The selected object')
        if (operation.type === 'delete_objects') {
          virtual.delete(id); updates.delete(id); touched.delete(id)
          if (!creates.delete(id)) (shape.isLocked ? pageDeletes : deletes).add(id)
          continue
        }
        if (operation.type !== 'update_object' && operation.type !== 'edit_content' && operation.type !== 'transform_object') throw new Error('Undo or redo must be a separate action.')
        if (shape.type !== 'magic' && operation.type === 'edit_content') throw new Error('Character editing is supported for equations, graphs and text.')
        if (shape.type !== 'magic' && operation.fitY) throw new Error('Fit curve applies to graphs only.')
        if (shape.type !== 'magic' && operation.visualization !== undefined) throw new Error('Scientific visualization settings apply to plots only.')
        if (operation.crop !== undefined && shape.type !== 'image') throw new Error('Cropping applies to images only.')
        const next = { ...shape, props: { ...shape.props }, meta: { ...shape.meta } } as TLShape
        if (operation.opacity !== undefined) next.opacity = operation.opacity
        if (next.type === 'image' && operation.crop !== undefined) {
          const before = next.props.crop ?? { x: 0, y: 0, w: 1, h: 1 }, after = validateCrop(operation.crop)
          const fullWidth = next.props.w / before.w, fullHeight = next.props.h / before.h
          const scale = Array.isArray(next.props.excalidrawScale) ? next.props.excalidrawScale : [1, 1]
          const offsetX = (scale[0] < 0 ? before.x + before.w - after.x - after.w : after.x - before.x) * fullWidth
          const offsetY = (scale[1] < 0 ? before.y + before.h - after.y - after.h : after.y - before.y) * fullHeight
          next.x += Math.cos(next.rotation) * offsetX - Math.sin(next.rotation) * offsetY
          next.y += Math.sin(next.rotation) * offsetX + Math.cos(next.rotation) * offsetY
          next.props.w = fullWidth * after.w; next.props.h = fullHeight * after.h
          next.props.crop = after
        }
        if (next.type === 'draw') {
          if (operation.color !== undefined) next.props.color = validateColor(operation.color)
          if (operation.strokeWidth !== undefined) next.props.strokeWidth = validateStrokeWidth(operation.strokeWidth)
        }
        if (next.type !== 'magic' && ['expression', 'latex', 'text', 'geometry', 'vertices', 'angles', 'sides', 'fill'].some(key => operation[key as keyof BoardOperation] !== undefined)) throw new Error('This content belongs on an equation, graph, text or geometry object.')
        if (region) next.meta.literalBounds = { ...region }
        else delete next.meta.literalBounds
        if (next.type === 'magic') {
          if (next.props.kind === 'plot' && operation.axisMode === undefined && ['xMin', 'xMax', 'yMin', 'yMax'].some(key => operation[key as keyof BoardOperation] !== undefined)) next.meta.axisMode = 'auto'
          if (next.props.kind === 'plot' && (operation.yMin !== undefined || operation.yMax !== undefined) && operation.axisMode !== 'equal') {
            // A one-sided limit edit must preserve the OTHER visible limit, not
            // the hidden stored range of an old equal-unit plot.
            const range = getPlotLayout(next.props, getAxisMode(shape.meta)).range
            next.props.yMin = range.yMin; next.props.yMax = range.yMax
            next.meta.axisMode = 'auto'
          }
          if (operation.axisMode !== undefined) {
            if (next.props.kind !== 'plot') throw new Error('Axis mode applies to graphs only.')
            next.meta.axisMode = operation.axisMode
          }
          if (operation.fitY) next.meta.axisMode = 'auto'
          if (operation.type === 'edit_content') {
            const expected = next.props.kind === 'math' ? 'latex' : next.props.kind === 'plot' ? 'expression' : 'text'
            if (operation.field !== expected) throw new Error(`This object uses its ${expected} field.`)
            const content = expected === 'latex' ? applyLatexContentEdit(next.props.latex, operation) : applyContentEdit(next.props[expected], operation)
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
        if (creates.has(id)) creates.set(id, { ...creates.get(id), x: next.x, y: next.y, rotation: next.rotation, props: next.props, meta: next.meta, opacity: next.opacity } as TLCreateShapePartial)
        else updates.set(id, { id, type: next.type, x: next.x, y: next.y, rotation: next.rotation, props: next.props, meta: next.meta, opacity: next.opacity } as TLShapePartial)
        if (!locked.includes(id)) touched.add(id)
      }
      context.selectedIds = ids.filter(id => virtual.has(id))
      // a locked page stays paper at the back, whatever layer the batch asks for
      if (operation.layer && operation.type !== 'delete_objects') layers.push({ ids: context.selectedIds.filter(id => !locked.includes(id)), front: operation.layer === 'front' })
      context.lastCreatedIds = context.selectedIds.length ? context.selectedIds : context.lastCreatedIds.filter(id => virtual.has(id))
    }
    return { creates: [...creates.values()], updates: [...updates.values()], deletes: [...deletes], pageDeletes: [...pageDeletes], touched: [...touched], nextLast: context.lastCreatedIds, layers,
      assets: [...assets.values()].filter(asset => [...creates.values()].some(shape => shape.type === 'image' && shape.props?.assetId === asset.id)),
      locked: locked.filter(id => creates.has(id)) }
  }

  applyOperations(operations: BoardOperation[]): BoardResult {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 20) return { ok: false, message: 'Send between 1 and 20 whiteboard actions.', ids: [] }
    if (operations.length === 1 && (operations[0].type === 'undo' || operations[0].type === 'redo')) {
      this.editor[operations[0].type](); return { ok: true, message: operations[0].type === 'undo' ? 'Undone.' : 'Redone.', ids: [] }
    }
    let plan: Plan
    try { plan = this.prepare(operations, this.getContext()) }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'That action could not be applied.', ids: [] } }
    const mark = this.editor.markHistoryStoppingPoint('magic-command')
    try {
      this.editor.run(() => {
        if (plan.assets.length) this.editor.createAssets(plan.assets)
        if (plan.creates.length) this.editor.createShapes(plan.creates)
        if (plan.updates.length) this.editor.updateShapes(plan.updates)
        if (plan.deletes.length) this.editor.deleteShapes(plan.deletes)
        if (plan.pageDeletes.length) this.editor.run(() => this.editor.deleteShapes(plan.pageDeletes), { ignoreShapeLock: true })
        // a locked book page is paper: under everything the teacher can touch, so it never hides or shields anything
        if (plan.locked.length) this.editor.run(() => this.editor.sendToBack(plan.locked, { aboveLocked: true }), { ignoreShapeLock: true })
        // back means behind other content, never behind pages or backgrounds
        for (const layer of plan.layers) if (layer.front) this.editor.bringToFront(layer.ids); else this.editor.sendToBack(layer.ids, { aboveLocked: true })
        if (plan.touched.length) this.editor.select(...plan.touched)
        else if (plan.locked.length) this.editor.selectNone()
      })
      this.editor.markHistoryStoppingPoint('after-magic-command')
      this.lastIds = plan.nextLast
      return { ok: true, message: 'Whiteboard updated.', ids: [...plan.touched, ...plan.locked] }
    } catch (error) {
      this.editor.bailToMark(mark)
      return { ok: false, message: error instanceof Error ? error.message : 'The whiteboard could not apply that change.', ids: [] }
    }
  }
}

export function createBoardController(editor: Editor, getContext: () => BoardContext) { return new BoardController(editor, getContext) }
