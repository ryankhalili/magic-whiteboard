import { Box, type Editor, type TLShape, type TLShapeId } from '../canvas/editor'
import type { Focus } from '../../shared/board'

const MAX_CAPTURE_EDGE = 1024
const MAX_CAPTURE_LENGTH = 2_000_000

// pages and problems from the textbook library; the model never sees book content
const isLibraryShape = (shape: TLShape) => { const value = shape.meta?.library; return !!value && typeof value === 'object' }

/** A screenshot is only worth sending when there is ink or an image that is not from the textbook library. */
export function boardNeedsImage(editor: Editor): boolean {
  return editor.getCurrentPageShapes().some(shape => shape.type === 'draw' || (shape.type === 'image' && !isLibraryShape(shape)))
}

/** Pad the user's gesture and complete selected strokes rather than cutting symbols at the lasso. */
export function getCaptureBounds(editor: Editor, focus?: Focus | null): Box {
  const targets = (focus?.targetIds || [])
    .map(id => editor.getShapePageBounds(id as TLShapeId))
    .filter((bounds): bounds is Box => !!bounds && [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite))
  const region = focus?.kind === 'region' && focus.bounds.w > 24 && focus.bounds.h > 24 ? focus.bounds : null
  if (targets.length || region) {
    const boxes = [...targets, ...(region ? [new Box(region.x, region.y, region.w, region.h)] : [])]
    const padding = targets.length ? 20 : 16
    const x = Math.min(...boxes.map(box => box.x)) - padding
    const y = Math.min(...boxes.map(box => box.y)) - padding
    const right = Math.max(...boxes.map(box => box.maxX)) + padding
    const bottom = Math.max(...boxes.map(box => box.maxY)) + padding
    return new Box(x, y, right - x, bottom - y)
  }
  return editor.getViewportPageBounds()
}

/**
 * A small board-only image for multimodal context. Includes ink and locked homework
 * backgrounds, but never application chrome, transcripts, or server configuration.
 * Textbook library images are left out; ink written on them still shows.
 */
export async function captureBoardContext(editor: Editor, focus?: Focus | null): Promise<string | null> {
  try {
    const bounds = getCaptureBounds(editor, focus)
    if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) return null
    const ids = editor.getCurrentPageShapes().filter(shape => {
      if (isLibraryShape(shape)) return false
      const box = editor.getShapePageBounds(shape)
      return box && box.maxX > bounds.x && box.maxY > bounds.y && box.x < bounds.maxX && box.y < bounds.maxY
    }).map(shape => shape.id)
    if (!ids.length) return null

    const scale = Math.min(1, MAX_CAPTURE_EDGE / bounds.w, MAX_CAPTURE_EDGE / bounds.h)
    const exported = await editor.toImage(ids, {
      format: 'png', bounds, scale, pixelRatio: 1, padding: 0, background: false, darkMode: false,
    })
    const url = URL.createObjectURL(exported.blob)
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const result = new Image()
        result.onload = () => resolve(result)
        result.onerror = reject
        result.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bounds.w * scale))
      canvas.height = Math.max(1, Math.round(bounds.h * scale))
      const context = canvas.getContext('2d')
      if (!context) return null
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.85, 0.65, 0.45]) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        if (dataUrl.length < MAX_CAPTURE_LENGTH) return dataUrl
      }
      return null
    } finally { URL.revokeObjectURL(url) }
  } catch {
    // Structured board context remains available if a browser cannot rasterize a shape.
    return null
  }
}
