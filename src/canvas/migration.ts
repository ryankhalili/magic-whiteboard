import type { AssetRecord, DocumentRecord, MagicShapeProps, StrokePoint, TLShape, TLEditorSnapshot } from './types'
import { resolveGeometry } from '../../shared/geometry'
import { validateColor, validateCrop, validateOpacity, validateStrokeWidth } from '../../shared/appearance'
import type { ImageCrop, Point } from '../../shared/board'
import { cropFromNative, type NativeImageCrop } from './imageCrop'

const MAX_COORDINATE = 10_000_000
const MAX_DIMENSION = 1_000_000
const MAX_RECORDS = 20_000
const MAX_POINTS = 1_000_000
const SUPPORTED_SHAPES = new Set(['magic', 'draw', 'image', 'group', 'geo', 'text'])

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown, fallback: number, limit = MAX_COORDINATE) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error('This project has an invalid object position.')
  return value
}
function dimension(value: unknown, fallback: number) {
  const number = finite(value, fallback, MAX_DIMENSION)
  if (number <= 0) throw new Error('This project has an invalid object size.')
  return number
}
function text(value: unknown, fallback = '', limit = 100_000) {
  return typeof value === 'string' ? value.slice(0, limit) : fallback
}
function metadata(value: unknown): Record<string, unknown> {
  // JSON cloning also removes prototypes/accessors from ordinary snapshot input.
  return object(value) ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
}
function points(value: unknown, budget: { remaining: number }): StrokePoint[] {
  if (!Array.isArray(value)) throw new Error('This notebook uses an unsupported ink format. Export it from the previous app before opening it here.')
  budget.remaining -= value.length
  if (budget.remaining < 0) throw new Error('This project contains too much ink to open safely.')
  return value.map(point => {
    if (!object(point)) throw new Error('This notebook contains damaged ink points.')
    return { x: finite(point.x, 0), y: finite(point.y, 0), z: Math.max(0, Math.min(1, finite(point.z ?? point.pressure, 0.5, 1))) }
  })
}

/** IEEE-754 binary16 value, implemented here for notebook data interoperability. */
function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >>> 10) & 31, fraction = bits & 1023
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24)
}

/**
 * Decode the documented legacy data layout: little-endian float32 first point,
 * then float16 coordinate deltas; dim=2 omits constant pressure. This original
 * implementation uses only platform base64/DataView APIs, not SDK code.
 */
export function decodeLegacyInkPath(path: string, dimension: unknown = 3): StrokePoint[] {
  const dim = dimension === 2 ? 2 : dimension === 3 || dimension === undefined ? 3 : 0
  if (!dim || path.length > 8_000_000 || !/^[a-z\d+/]*={0,2}$/i.test(path)) throw new Error('This notebook contains invalid encoded ink.')
  if (!path) return []
  let binary: string
  try { binary = atob(path) } catch { throw new Error('This notebook contains invalid encoded ink.') }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const firstSize = dim * 4, step = dim * 2
  if (bytes.length < firstSize || (bytes.length - firstSize) % step) throw new Error('This notebook contains truncated encoded ink.')
  const data = new DataView(bytes.buffer)
  const values = Array.from({ length: dim }, (_, index) => data.getFloat32(index * 4, true))
  const result: StrokePoint[] = []
  const append = () => result.push({ x: finite(values[0], 0), y: finite(values[1], 0), z: Math.max(0, Math.min(1, finite(dim === 3 ? values[2] : 0.5, 0.5))) })
  append()
  for (let offset = firstSize; offset < bytes.length; offset += step) {
    for (let axis = 0; axis < dim; axis++) values[axis] += halfFloat(data.getUint16(offset + axis * 2, true))
    append()
  }
  return result
}
function magicProps(props: Record<string, unknown>): MagicShapeProps {
  if (!['plot', 'math', 'text', 'geometry'].includes(String(props.kind))) throw new Error('This project contains an unsupported magic object.')
  const geometry = props.geometry === undefined ? 'triangle' : props.geometry as MagicShapeProps['geometry']
  if (!['triangle', 'right_triangle', 'rectangle', 'ellipse', 'arrow', 'polygon', 'polyline'].includes(geometry)) throw new Error('This project contains unsupported geometry. The saved notebook has not changed.')
  const result: MagicShapeProps = {
    w: dimension(props.w, 400), h: dimension(props.h, 240), kind: props.kind as MagicShapeProps['kind'],
    expression: text(props.expression), latex: text(props.latex), text: text(props.text), title: text(props.title, '', 400),
    color: text(props.color, '#202124', 100), xMin: finite(props.xMin, -10), xMax: finite(props.xMax, 10),
    yMin: finite(props.yMin, -10, 1e12), yMax: finite(props.yMax, 10, 1e12), geometry, fontSize: dimension(props.fontSize, 28),
  }
  if (result.kind === 'geometry') {
    const custom = resolveGeometry({ geometry, vertices: props.vertices as Point[] | undefined, angles: props.angles as number[] | undefined, sides: props.sides as number | undefined })
    result.geometry = custom.geometry; result.vertices = custom.vertices; result.angles = custom.angles
    result.sides = custom.geometry === 'polygon' ? custom.vertices?.length : undefined
  }
  if (props.fill !== undefined) result.fill = validateColor(props.fill as string)
  if (props.fillOpacity !== undefined) result.fillOpacity = validateOpacity(props.fillOpacity as number)
  if (props.strokeWidth !== undefined) result.strokeWidth = validateStrokeWidth(props.strokeWidth as number)
  for (const key of ['showGrid', 'showAxes'] as const) if (props[key] !== undefined) {
    if (typeof props[key] !== 'boolean') throw new Error('This project has an invalid plot display option.')
    result[key] = props[key]
  }
  return result
}

/** Validate data from owned snapshots and earlier notebook files without loading any SDK code. */
export function normalizeSnapshot(input: unknown): TLEditorSnapshot {
  if (!object(input) || !object(input.document) || !object(input.document.store)) throw new Error('The project is missing its board data.')
  const entries = Object.entries(input.document.store)
  if (entries.length > MAX_RECORDS) throw new Error('This project is too large to open.')
  const store: Record<string, DocumentRecord> = Object.create(null)
  const budget = { remaining: MAX_POINTS }
  let assetLength = 0
  for (const [order, [key, raw]] of entries.entries()) {
    if (!object(raw)) throw new Error('This project contains an invalid object.')
    const id = text(raw.id, key, 300)
    if (!id || id === '__proto__' || store[id]) throw new Error('This project contains an invalid or repeated object identifier.')
    const props = object(raw.props) ? raw.props : {}
    if (raw.typeName === 'asset') {
      if (raw.type !== 'image' || typeof props.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(props.src)) {
        throw new Error('This project contains an unsupported external asset. Use embedded screenshot images.')
      }
      assetLength += props.src.length
      if (assetLength > 56_000_000) throw new Error('This project contains too many embedded image bytes.')
      store[id] = { id, typeName: 'asset', type: 'image', meta: metadata(raw.meta), props: {
        src: props.src, name: text(props.name, 'Screenshot', 300), w: dimension(props.w, 1), h: dimension(props.h, 1),
        mimeType: text(props.mimeType, props.src.slice(5, props.src.indexOf(';')), 100), isAnimated: false,
      } } satisfies AssetRecord
    } else if (raw.typeName === 'page') {
      store[id] = { id, typeName: 'page', name: text(raw.name, 'Page 1', 300), index: typeof raw.index === 'number' || typeof raw.index === 'string' ? raw.index : 0, meta: metadata(raw.meta) }
    } else if (raw.typeName === 'shape') {
      if (!SUPPORTED_SHAPES.has(String(raw.type))) throw new Error(`This project contains unsupported online content or shape type "${text(raw.type, 'unknown', 40)}". Your existing notebook has not changed.`)
      const base = {
        id, typeName: 'shape' as const, type: raw.type, x: finite(raw.x, 0), y: finite(raw.y, 0), rotation: finite(raw.rotation, 0),
        parentId: text(raw.parentId, 'page:main', 300), index: typeof raw.index === 'string' || typeof raw.index === 'number' ? raw.index : order,
        isLocked: raw.isLocked === true, opacity: Math.max(0, Math.min(1, finite(raw.opacity, 1, 1))), meta: metadata(raw.meta),
      }
      // pages of a multi page worksheet were once saved as backgrounds, so a pasted image replaced them
      const pdf = base.meta.pdf
      if (raw.type === 'image' && base.meta.marginaliaBackground === true && object(pdf) && typeof pdf.pages === 'number' && pdf.pages > 1) base.meta.marginaliaBackground = false
      let normalized: unknown
      if (raw.type === 'magic') normalized = magicProps(props)
      else if (raw.type === 'image') {
        const owned = object(input.document.schema) && input.document.schema.engine === 'magic-whiteboard'
        if ((props.crop != null && !owned) || props.flipX === true || props.flipY === true) throw new Error('This notebook contains a cropped or flipped legacy image that is not supported yet. Export that image from the previous app before importing. Existing saved data has not changed.')
        normalized = { ...metadata(props), assetId: typeof props.assetId === 'string' ? props.assetId : null, w: dimension(props.w, 320), h: dimension(props.h, 240), altText: text(props.altText, '', 500) }
        if (props.crop != null) Object.assign(normalized as object, { crop: validateCrop(props.crop as ImageCrop) })
        else if (props.excalidrawCrop != null) Object.assign(normalized as object, { crop: cropFromNative(props.excalidrawCrop as NativeImageCrop) })
      }
      else if (raw.type === 'draw') {
        const scaleX = finite(props.scaleX, 1), scaleY = finite(props.scaleY, 1)
        const segments = Array.isArray(props.segments) ? props.segments.map(segment => {
          if (!object(segment)) throw new Error('This notebook contains damaged ink segments.')
          const decoded = typeof segment.path === 'string' ? decodeLegacyInkPath(segment.path, segment.dim) : segment.points
          return { type: text(segment.type, 'free'), points: points(decoded, budget).map(point => ({ ...point, x: finite(point.x * scaleX, 0), y: finite(point.y * scaleY, 0) })) }
        }) : undefined
        // Segments are canonical when supplied. Owned snapshots also carry a flattened
        // convenience array; count each physical ink sample only once during reload.
        const ink = segments?.length ? segments.flatMap(segment => segment.points) : Array.isArray(props.points) ? points(props.points, budget) : segments ? [] : undefined
        if (!ink) throw new Error('This notebook uses an unsupported ink format. Its saved copy has not changed.')
        normalized = { ...metadata(props), points: ink, segments, scaleX: 1, scaleY: 1, color: text(props.color, '#202124', 100), size: typeof props.size === 'number' ? dimension(props.size, 3.5) : ['s', 'm', 'l', 'xl'].includes(String(props.size)) ? props.size : 'm' }
      } else if (raw.type === 'group') normalized = {}
      else {
        if (raw.type === 'geo' && props.geo !== undefined && !['rectangle', 'ellipse', 'triangle'].includes(String(props.geo))) throw new Error(`Legacy geometry "${text(props.geo, 'unknown', 40)}" is not supported yet. Existing saved data has not changed.`)
        normalized = { ...metadata(props), w: dimension(props.w, 240), h: dimension(props.h, 80), color: text(props.color, '#202124', 100) }
      }
      store[id] = { ...base, props: normalized } as TLShape
    } else if (['document', 'pointer', 'camera', 'instance', 'instance_page_state', 'user', 'instance_presence'].includes(String(raw.typeName))) {
      // These are non-content legacy records. Preserve them in the data file without executing them.
      store[id] = { ...metadata(raw), id, typeName: String(raw.typeName) }
    } else throw new Error(`This notebook contains an unsupported record type "${text(raw.typeName, 'unknown', 40)}". Its saved copy has not changed.`)
  }
  let pages = Object.values(store).filter(record => record.typeName === 'page')
  if (!pages.length) {
    store['page:main'] = { id: 'page:main', typeName: 'page', name: 'Page 1', index: 0, meta: {} }
    pages = [store['page:main']]
  }
  const shapes = Object.values(store).filter(record => record.typeName === 'shape') as TLShape[]
  for (const shape of shapes) {
    // Old exports can omit default page records; map that one known default to the available page.
    if (!store[shape.parentId] && shape.parentId === 'page:main') shape.parentId = pages[0].id
    const parent = store[shape.parentId]
    if (!parent || (parent.typeName !== 'page' && !(parent.typeName === 'shape' && parent.type === 'group'))) throw new Error('This project has a missing object group or page.')
    const seen = new Set([shape.id]); let ancestor = parent
    while (ancestor.typeName === 'shape') {
      if (seen.has(ancestor.id)) throw new Error('This project has a circular object group.')
      seen.add(ancestor.id)
      ancestor = store[(ancestor as TLShape).parentId]
      if (!ancestor) throw new Error('This project has a missing object group.')
    }
    if (shape.type === 'image' && (!shape.props.assetId || store[shape.props.assetId]?.typeName !== 'asset')) throw new Error('This project has a missing screenshot asset.')
  }
  const session = object(input.session) ? input.session : {}
  const legacyPageStates = Array.isArray(session.pageStates) ? session.pageStates : []
  const currentPageId = typeof session.currentPageId === 'string' && store[session.currentPageId]?.typeName === 'page' ? session.currentPageId : pages[0].id
  const legacyPageState = legacyPageStates.find(value => object(value) && value.pageId === currentPageId)
  const camera = object(session.camera) ? session.camera : object(legacyPageState) && object(legacyPageState.camera) ? legacyPageState.camera : {}
  const selected = Array.isArray(session.selectedShapeIds) ? session.selectedShapeIds : object(legacyPageState) && Array.isArray(legacyPageState.selectedShapeIds) ? legacyPageState.selectedShapeIds : []
  return {
    document: { schema: { schemaVersion: 1, engine: 'magic-whiteboard' }, store },
    session: { currentPageId, camera: { x: finite(camera.x, 0), y: finite(camera.y, 0), z: Math.max(0.02, Math.min(8, finite(camera.z, 1))) }, selectedShapeIds: selected.filter((id): id is string => typeof id === 'string' && store[id]?.typeName === 'shape') },
  }
}
