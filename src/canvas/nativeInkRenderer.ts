import type { ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import { getStrokeWidth, strokePoints } from './geometry'
import type { DrawProps } from './types'

type NativeInkRenderer = (element: ExcalidrawFreeDrawElement) => string
let renderer: NativeInkRenderer | undefined

/** The browser canvas registers its public renderer; this module stays DOM-free. */
export function installNativeInkRenderer(next: NativeInkRenderer): () => void {
  const previous = renderer
  renderer = next
  return () => { if (renderer === next) renderer = previous }
}

/** Keep coordinates local to the document shape; its SVG parent applies the pose. */
export function nativeInkParameters(props: DrawProps): Pick<ExcalidrawFreeDrawElement, 'points' | 'pressures' | 'simulatePressure' | 'strokeWidth' | 'lastCommittedPoint'> {
  const points = strokePoints(props)
  return {
    points: (points.length ? points.map(point => [point.x, point.y]) : [[0, 0]]) as ExcalidrawFreeDrawElement['points'],
    pressures: points.map(point => Math.max(0, Math.min(1, point.pressure ?? point.z ?? .5))),
    simulatePressure: props.simulatePressure === true,
    strokeWidth: getStrokeWidth(props),
    // The canvas projection uses null too; matching it preserves endpoint rendering.
    lastCommittedPoint: null,
  }
}

export function nativeInkSvgPath(props: DrawProps): string {
  if (!renderer) throw new Error('The canvas ink renderer is not ready. Wait for the canvas to load and export again.')
  // This public API consumes only the freedraw geometry fields above. The installed
  // canvas package owns width scaling, smoothing, and pressure simulation.
  return renderer(nativeInkParameters(props) as ExcalidrawFreeDrawElement)
}
