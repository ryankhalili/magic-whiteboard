import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { renderShapesToImage } from '../files/imageExporter'
import { Editor } from './editor'
import type { TLShape } from './types'
import { disconnectedInkBounds, isDisconnectedInk } from './disconnectedInk'

export type LiveContentShape = TLShape<'magic' | 'text' | 'geo' | 'draw'>

export function isLiveContentShape(shape: TLShape): shape is LiveContentShape {
  return isDisconnectedInk(shape) || (shape.type === 'magic' || shape.type === 'text' || shape.type === 'geo') && !shape.meta.excalidrawElement
}

// Increment when the bitmap renderer changes so old content-addressed files cannot be reused.
const RENDERER_VERSION = 3
const MAX_EDGE = 4096
const MAX_PIXELS = 2048 * 2048

function renderingMeta(shape: LiveContentShape) {
  return shape.type === 'magic' ? {
    axisMode: shape.meta.axisMode === 'equal' ? 'equal' : 'auto',
    literalBounds: !!shape.meta.literalBounds,
  } : {}
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}

/** Pixel identity excludes position, rotation, group, selection, lock and native opacity. */
export function liveContentKey(shape: LiveContentShape): string {
  return stableJson({ version: RENDERER_VERSION, type: shape.type, props: shape.props, meta: renderingMeta(shape) })
}

function localContentHash(key: string): string {
  // Four mixed words keep accidental cache collisions unlikely on HTTP LAN pages.
  // This identifies rendered content only; it is not an integrity or security check.
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    a = b ^ Math.imul(a ^ code, 597399067)
    b = c ^ Math.imul(b ^ code, 2869860233)
    c = d ^ Math.imul(c ^ code, 951274213)
    d = a ^ Math.imul(d ^ code, 2716044179)
  }
  a = Math.imul(c ^ (a >>> 18), 597399067)
  b = Math.imul(d ^ (b >>> 22), 2869860233)
  c = Math.imul(a ^ (c >>> 17), 951274213)
  d = Math.imul(b ^ (d >>> 19), 2716044179)
  return [a, b, c, d].map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

async function contentFileId(key: string): Promise<BinaryFileData['id']> {
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
      const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      return `magic-content-${hex}` as BinaryFileData['id']
    } catch { /* Browsers can expose Web Crypto while disallowing this operation. */ }
  }
  return `magic-content-local-${localContentHash(key)}` as BinaryFileData['id']
}

function blobDataUrl(blob: Blob): Promise<BinaryFileData['dataURL']> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result as BinaryFileData['dataURL'])
      : reject(new Error('The content image could not be read.'))
    reader.onerror = () => reject(reader.error ?? new Error('The content image could not be read.'))
    reader.onabort = () => reject(new Error('Reading the content image was interrupted.'))
    reader.readAsDataURL(blob)
  })
}

/** Render a private, untransformed copy. The caller discards stale results after edits. */
export async function renderLiveContentImage(shape: LiveContentShape): Promise<BinaryFileData> {
  if (!isLiveContentShape(shape)) throw new Error('This object uses native canvas rendering.')
  const source = structuredClone(shape)
  const key = liveContentKey(source)
  const isolated = new Editor()
  const local = {
    ...source, id: 'shape:live-content', x: 0, y: 0, rotation: 0, opacity: 1,
    parentId: isolated.getCurrentPageId(), index: 0, isLocked: false, meta: renderingMeta(source),
  } as LiveContentShape
  isolated.createShape(local)
  const bounds = isDisconnectedInk(local) ? disconnectedInkBounds(local) : isolated.getShapeGeometry(local).bounds
  const width = Math.max(1, bounds.w), height = Math.max(1, bounds.h)
  const scale = Math.min(2, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)))
  const [id, rendered] = await Promise.all([
    contentFileId(key),
    renderShapesToImage(isolated, [local.id], {
      bounds: { x: bounds.x, y: bounds.y, w: width, h: height }, padding: 0, background: false, scale,
    }),
  ])
  return { id, mimeType: 'image/png', dataURL: await blobDataUrl(rendered.blob), created: 1 }
}
