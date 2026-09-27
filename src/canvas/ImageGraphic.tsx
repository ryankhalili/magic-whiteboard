import type { ImageProps } from './types'

/** A reversible viewport over the original embedded image; export uses the same viewBox. */
export function ImageGraphic({ src, props, label }: { src: string; props: ImageProps; label?: string }) {
  const crop = props.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  return <svg className="whiteboard-image" width={props.w} height={props.h} viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`} preserveAspectRatio="none" overflow="hidden" role={label ? 'img' : undefined} aria-label={label}>
    <image href={src} width={1} height={1} preserveAspectRatio="none"/>
  </svg>
}
