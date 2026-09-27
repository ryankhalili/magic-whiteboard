import type { ImageCrop } from './board'

export function validateColor(color: string): string {
  if (typeof color !== 'string' || !(/^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]{1,24})$/i.test(color))) throw new Error('Use a hex color or a named color.')
  return color
}

export function validateOpacity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Opacity must be between 0 and 1.')
  return value
}

export function validateStrokeWidth(value: number): number {
  if (!Number.isFinite(value) || value < .25 || value > 24) throw new Error('Line width must be between 0.25 and 24.')
  return value
}

export function validateCrop(crop: ImageCrop): ImageCrop {
  if (!crop || ![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.w < .01 || crop.h < .01 || crop.x + crop.w > 1.000001 || crop.y + crop.h > 1.000001) throw new Error('Crop edges must stay inside the image and leave at least 1% of its width and height.')
  return { x: crop.x, y: crop.y, w: crop.w, h: crop.h }
}
