import type { ImageCrop } from '../../shared/board'
import { validateCrop } from '../../shared/appearance'
import type { ImageProps } from './types'

export type NativeImageCrop = { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number }

export function cropFromNative(crop: NativeImageCrop): ImageCrop {
  if (![crop.naturalWidth, crop.naturalHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('This image has invalid crop dimensions.')
  return validateCrop({ x: crop.x / crop.naturalWidth, y: crop.y / crop.naturalHeight, w: crop.width / crop.naturalWidth, h: crop.height / crop.naturalHeight })
}

/** Read earlier Excalidraw checkpoints as well as the portable normalized crop. */
export function imageCrop(props: ImageProps): ImageCrop | undefined {
  return props.crop ? validateCrop(props.crop) : props.excalidrawCrop ? cropFromNative(props.excalidrawCrop as NativeImageCrop) : undefined
}

export function cropToNative(props: ImageProps, naturalWidth: number, naturalHeight: number): NativeImageCrop | null {
  const crop = imageCrop(props)
  if (!crop || (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1)) return null
  return { x: crop.x * naturalWidth, y: crop.y * naturalHeight, width: crop.w * naturalWidth, height: crop.h * naturalHeight, naturalWidth, naturalHeight }
}
