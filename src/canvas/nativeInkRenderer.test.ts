import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeInkRenderer, nativeInkParameters, nativeInkSvgPath } from './nativeInkRenderer'
import type { DrawProps } from './types'

const props: DrawProps = { points: [{ x: -10, y: 4, z: 0 }, { x: 30, y: 8, pressure: .8 }], color: 'blue', size: 'm' }
let uninstall: (() => void) | undefined
afterEach(() => { uninstall?.(); uninstall = undefined })

describe('shared native ink renderer', () => {
  it('forwards original width and pressure to the canvas renderer without applying another width multiplier', () => {
    const renderer = vi.fn(() => 'M0,0 L10,0 Z')
    uninstall = installNativeInkRenderer(renderer)
    expect(nativeInkSvgPath(props)).toBe('M0,0 L10,0 Z')
    expect(renderer).toHaveBeenCalledWith({ points: [[-10, 4], [30, 8]], pressures: [0, .8], strokeWidth: 3.5, simulatePressure: false, lastCommittedPoint: null })
  })

  it('retains mouse simulation and matches the live projection pressure defaults and clamps', () => {
    expect(nativeInkParameters({ ...props, strokeWidth: 7, simulatePressure: true, points: [{ x: 0, y: 0 }, { x: 10, y: 10, z: -1 }, { x: 20, y: 20, z: 2 }] })).toEqual({
      points: [[0, 0], [10, 10], [20, 20]], pressures: [.5, 0, 1], strokeWidth: 7, simulatePressure: true, lastCommittedPoint: null,
    })
  })

  it('reports an unavailable canvas renderer instead of silently exporting thinner ink', () => {
    expect(() => nativeInkSvgPath(props)).toThrow('canvas ink renderer is not ready')
  })
})
