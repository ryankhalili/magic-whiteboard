import type { AxisMode, AxisRange } from '../../shared/board'

/** Missing metadata preserves the appearance of notebooks saved before equal axes existed. */
export function getAxisMode(meta?: Record<string, unknown>): AxisMode {
  return meta?.axisMode === 'equal' ? 'equal' : 'auto'
}

export function getPlotLayout(props: AxisRange & { w: number; h: number; title?: string }, axisMode: AxisMode) {
  const pad = { l: 46, r: 18, t: props.title ? 63 : 43, b: 34 }
  const width = Math.max(1, props.w - pad.l - pad.r), height = Math.max(1, props.h - pad.t - pad.b)
  const { xMin, xMax } = props
  let { yMin, yMax } = props
  if (axisMode === 'equal') {
    // Keep the requested x domain exact. A unit occupies the same pixels on each
    // axis; auto mode remains available when fitting the whole curve matters more.
    const unitsPerPixel = (xMax - xMin) / width
    const cy = (yMin + yMax) / 2
    yMin = cy - unitsPerPixel * height / 2; yMax = cy + unitsPerPixel * height / 2
  }
  return {
    pad, width, height, range: { xMin, xMax, yMin, yMax },
    X: (x: number) => (x - xMin) / (xMax - xMin) * width,
    Y: (y: number) => (yMax - y) / (yMax - yMin) * height,
  }
}
