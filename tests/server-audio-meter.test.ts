import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAudioMeter } from '../src/ai/audio-meter'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('local microphone display meter', () => {
  it('reports signal strength and releases its analyser and AudioContext on stop', async () => {
    vi.useFakeTimers()
    const disconnectSource = vi.fn(); const disconnectAnalyser = vi.fn(); const close = vi.fn(async () => {})
    const level = vi.fn()
    const samples = vi.fn((data: Float32Array) => data.fill(0.1))
    vi.stubGlobal('window', { AudioContext: class {
      state = 'running'
      resume = vi.fn(async () => {})
      close = close
      createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: samples, disconnect: disconnectAnalyser } }
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: disconnectSource } }
    } })
    const meter = createAudioMeter(level)
    meter.attach({} as MediaStream)
    await vi.advanceTimersByTimeAsync(50)
    expect(level.mock.calls[0][0]).toBeGreaterThan(0)
    expect(level.mock.calls[0][0]).toBeLessThanOrEqual(1)
    meter.stop()
    expect(close).toHaveBeenCalledTimes(1)
    expect(disconnectSource).toHaveBeenCalledTimes(1)
    expect(disconnectAnalyser).toHaveBeenCalledTimes(1)
    expect(level).toHaveBeenLastCalledWith(0)
    const calls = level.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(level).toHaveBeenCalledTimes(calls)
  })
  it('leaves voice usable when AudioContext is unavailable', () => {
    vi.stubGlobal('window', {})
    const meter = createAudioMeter(vi.fn())
    expect(() => meter.attach({} as MediaStream)).not.toThrow()
    expect(() => meter.stop()).not.toThrow()
  })
})
