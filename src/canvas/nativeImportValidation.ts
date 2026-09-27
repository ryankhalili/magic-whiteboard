import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { Editor } from './editor'
import { normalizeSnapshot } from './migration'

type RecordData = Record<string, unknown>
const record = (value: unknown): value is RecordData => !!value && typeof value === 'object' && !Array.isArray(value)
const raster = /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i
const sourceTypes = new Set(['magic', 'draw', 'image', 'text', 'geo'])

export class NativeSceneImportError extends Error {
  constructor(detail: string) {
    super(`${detail} Nothing was added. Paste a screenshot or copy an object created in Doodle Desk instead.`)
    this.name = 'NativeSceneImportError'
  }
}

/** Reject an entire foreign paste before its first document or asset mutation. */
export function validateNativeSceneImport(editor: Editor, elements: readonly ExcalidrawElement[], files: BinaryFiles = {}): void {
  const incoming = elements.filter(element => !element.isDeleted && !editor.getShape(element.id))
  if (!incoming.length) return
  const store: Record<string, unknown> = Object.create(null)
  store['page:import-check'] = { id: 'page:import-check', typeName: 'page', name: 'Import validation', index: 0, meta: {} }
  try {
    for (const element of incoming) {
      if (typeof element.id !== 'string' || !element.id || store[element.id]) throw new Error('This paste has an invalid object identity.')
      if (![element.x, element.y, element.width, element.height, element.angle, element.opacity].every(Number.isFinite)
        || element.width < 0 || element.height < 0) throw new Error('This paste has invalid object dimensions.')
      const metadata = element.customData?.magicWhiteboard
      const source = record(metadata) && metadata.schemaVersion === 1 && record(metadata.shape) ? metadata.shape : undefined
      if (metadata && !source) throw new Error('This paste has damaged Doodle Desk source data.')
      if (source) {
        if (!sourceTypes.has(String(source.type)) || !record(source.props)) throw new Error('This paste has unsupported Doodle Desk source data.')
        // Our content uses images, with native freedraw for a continuous ink path.
        // A disconnected ink proxy is an image carrying its original draw source;
        // its transient PNG/SVG file is deliberately not a document image asset.
        const representationAllowed = element.type === 'image'
          || (source.type === 'draw' && element.type === 'freedraw')
        if (!representationAllowed || (record(source.meta) && source.meta.excalidrawElement)) {
          throw new Error(`Native Excalidraw ${element.type} objects are not supported by portable notebook export.`)
        }
      } else if (element.type !== 'freedraw' && element.type !== 'image') {
        throw new Error(`Native Excalidraw ${element.type} objects are not supported by portable notebook export.`)
      }

      const base = { id: element.id, typeName: 'shape', parentId: 'page:import-check', x: element.x, y: element.y, rotation: element.angle, index: 0, opacity: element.opacity / 100, isLocked: element.locked, meta: {} }
      if (source && source.type !== 'image') {
        store[element.id] = { ...source, ...base, props: { ...source.props as RecordData, ...(source.type === 'draw' ? {} : { w: element.width, h: element.height }) } }
      } else if (element.type === 'image') {
        const assetId = element.fileId
        if (!assetId) throw new Error('This pasted image is missing its embedded pixels.')
        const file = files[assetId], asset = editor.getAsset(assetId)
        const src = file?.dataURL ?? asset?.props.src
        if (typeof src !== 'string' || !raster.test(src)) throw new Error('Only embedded PNG, JPEG, WebP, or GIF images can be pasted into a portable notebook.')
        if (store[assetId] && (store[assetId] as RecordData).typeName !== 'asset') throw new Error('This paste has conflicting object and image identities.')
        store[assetId] = { id: assetId, typeName: 'asset', type: 'image', meta: {}, props: { src, name: 'Pasted image', w: asset?.props.w ?? element.width, h: asset?.props.h ?? element.height } }
        store[element.id] = { ...source, ...base, type: 'image', props: { ...(source?.props as RecordData | undefined), assetId, w: element.width, h: element.height } }
      } else if (element.type === 'freedraw') {
        if (!Array.isArray(element.points) || !Array.isArray(element.pressures)) throw new Error('This pasted ink has missing point data.')
        store[element.id] = { ...base, type: 'draw', props: {
          points: element.points.map((point, index) => ({ x: point[0], y: point[1], z: element.pressures[index] ?? .5 })),
          color: element.strokeColor, size: element.strokeWidth,
        } }
      }
    }
    // Use the same data validator as notebook import, before accepting the paste.
    // It also checks source-backed equations, geometry, and decoded ink limits.
    normalizeSnapshot({ document: { schema: { schemaVersion: 1, engine: 'magic-whiteboard' }, store } })
  } catch (error) {
    if (error instanceof NativeSceneImportError) throw error
    throw new NativeSceneImportError(error instanceof Error ? error.message : 'This paste contains unsupported content.')
  }
}
