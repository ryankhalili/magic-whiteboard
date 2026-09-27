import { AssetRecordType, createShapeId, type Editor, type TLShapeId } from '../canvas/editor'
import type { Bounds } from '../../shared/board'
import { IMAGE_SIZES, type GeneratedImage } from '../../shared/image-generation'
import { normalizeSnapshot } from '../canvas/migration'
import type { AssetRecord, TLImageShape } from '../canvas/types'
import { validImageBounds } from './placement'

export function validateGeneratedImage(image: unknown): asserts image is GeneratedImage {
  const value = image as GeneratedImage | undefined
  const prefix = 'data:image/png;base64,'
  const invalid = () => { throw new Error('The generated image could not be read. The existing board is unchanged.') }
  if (!value || typeof value.dataUrl !== 'string' || value.dataUrl.length > 18_000_000 || !value.dataUrl.startsWith(prefix)
    || !IMAGE_SIZES.some(size => size === `${value.width}x${value.height}`)) return invalid()
  const encoded = value.dataUrl.slice(prefix.length)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return invalid()
  let decoded: string
  try { decoded = atob(encoded) } catch { return invalid() }
  if (decoded.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => decoded.charCodeAt(index) === byte)) return invalid()
  const uint32 = (offset: number) => ((decoded.charCodeAt(offset) * 0x1000000) + (decoded.charCodeAt(offset + 1) << 16) + (decoded.charCodeAt(offset + 2) << 8) + decoded.charCodeAt(offset + 3)) >>> 0
  if (uint32(8) !== 13 || decoded.slice(12, 16) !== 'IHDR' || uint32(16) !== value.width || uint32(20) !== value.height) return invalid()
  let offset = 8, sawData = false, ended = false
  while (offset + 12 <= decoded.length) {
    const length = uint32(offset), type = decoded.slice(offset + 4, offset + 8)
    if (length > decoded.length - offset - 12) return invalid()
    if (type === 'IDAT') sawData = true
    offset += length + 12
    if (type === 'IEND') { ended = length === 0 && offset === decoded.length; break }
  }
  if (!sawData || !ended) return invalid()
}

/** A successful job is inserted at most once, including after a tab reload. */
export function insertGeneratedImage(editor: Editor, requestId: string, image: GeneratedImage, bounds: Bounds, description: string): TLShapeId {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId)) throw new Error('The image request identifier is invalid.')
  const existing = editor.store.allRecords().find(record => record.typeName === 'shape' && (record as TLImageShape).meta?.generatedImageRequest === requestId)
  if (existing) return existing.id
  validateGeneratedImage(image)
  if (!validImageBounds(bounds)) throw new Error('The image placement is no longer valid.')
  const assetId = AssetRecordType.createId(), shapeId = createShapeId()
  editor.completeInteraction()
  const asset: AssetRecord = { id: assetId, typeName: 'asset', type: 'image', meta: {}, props: { src: image.dataUrl, name: 'Generated image', w: image.width, h: image.height, mimeType: 'image/png', isAnimated: false } }
  const shape: TLImageShape = { id: shapeId, typeName: 'shape', type: 'image', x: bounds.x, y: bounds.y, rotation: 0, index: editor.getCurrentPageShapes().length + 1,
    parentId: editor.getCurrentPageId(), isLocked: false, opacity: 1,
    props: { assetId, w: bounds.w, h: bounds.h, altText: description.slice(0, 500) }, meta: { generatedImageRequest: requestId } }
  // Refuse aggregate image/record limits before changing the document: a saved
  // notebook must remain readable by the same portable-project validator.
  const snapshot = editor.getSnapshot()
  normalizeSnapshot({ ...snapshot, document: { ...snapshot.document, store: { ...snapshot.document.store, [assetId]: asset, [shapeId]: shape } } })
  editor.markHistoryStoppingPoint('Insert generated image')
  editor.run(() => {
    editor.createAssets([asset])
    // Let the editor choose a fresh frontmost index rather than replacing layer order.
    const { index: _index, ...newShape } = shape
    editor.createShape(newShape)
  })
  return shapeId
}
