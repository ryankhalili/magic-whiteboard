import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoldToTalk, type HoldToTalkClient } from '../src/ai/hold-to-talk'

function client(enabled = false) {
  let on = enabled, connected = true, working = false
  return { isConnected: () => connected, isMicrophoneEnabled: () => on, isWorking: () => working,
    setMicrophoneEnabled: vi.fn((value: boolean) => { on = value }),
    disconnect: vi.fn(() => { connected = false; on = false }), busy: (value: boolean) => { working = value } }
}
describe('hold to talk lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('never opens the microphone when released before permission/connection finishes', async () => {
    let current: HoldToTalkClient | null = null
    let finish!: (value: HoldToTalkClient) => void
    const pending = new Promise<HoldToTalkClient>(resolve => { finish = resolve })
    const gate = createHoldToTalk({ getClient: () => current, connectMuted: vi.fn(() => pending) })
    const opening = gate.press(); gate.release()
    const voice = client(); current = voice; finish(voice); await opening
    expect(voice.setMicrophoneEnabled).not.toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(voice.disconnect).toHaveBeenCalledTimes(1)
  })
  it('ignores auto-repeat and waits for an applied turn before closing an owned connection', async () => {
    const voice = client(); let current: typeof voice | null = null
    const connectMuted = vi.fn(async () => { current = voice; return voice })
    const gate = createHoldToTalk({ getClient: () => current, connectMuted })
    await gate.press(); await gate.press(); await gate.press()
    expect(connectMuted).toHaveBeenCalledTimes(1)
    expect(voice.isMicrophoneEnabled()).toBe(true)
    voice.busy(true); gate.release()
    expect(voice.isMicrophoneEnabled()).toBe(false)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(voice.disconnect).not.toHaveBeenCalled()
    voice.busy(false); await vi.advanceTimersByTimeAsync(500)
    expect(voice.disconnect).toHaveBeenCalledTimes(1)
  })
  it('a second hold reuses the connection and cancels pending close', async () => {
    const voice = client(); let current: typeof voice | null = null
    const gate = createHoldToTalk({ getClient: () => current, connectMuted: async () => { current = voice; return voice } })
    await gate.press(); gate.release(); await vi.advanceTimersByTimeAsync(4_000)
    await gate.press(); await vi.advanceTimersByTimeAsync(10_000)
    expect(voice.disconnect).not.toHaveBeenCalled()
    expect(voice.isMicrophoneEnabled()).toBe(true)
    gate.release(); await vi.advanceTimersByTimeAsync(5_000)
    expect(voice.disconnect).toHaveBeenCalledTimes(1)
  })
  it('preserves an explicitly running continuous voice session on release', async () => {
    const voice = client(true)
    const gate = createHoldToTalk({ getClient: () => voice, connectMuted: async () => null })
    await gate.press(); gate.release(); await vi.advanceTimersByTimeAsync(90_000)
    expect(voice.isMicrophoneEnabled()).toBe(true)
    expect(voice.disconnect).not.toHaveBeenCalled()
  })
  it('cancels an in-flight connection when the notebook changes or component unmounts', async () => {
    let current: HoldToTalkClient | null = null, finish!: (value: HoldToTalkClient) => void
    const gate = createHoldToTalk<HoldToTalkClient>({ getClient: () => current, connectMuted: () => new Promise(resolve => { finish = resolve }) })
    const opening = gate.press(); gate.cancel()
    const voice = client(); current = voice; finish(voice); await opening
    expect(voice.isMicrophoneEnabled()).toBe(false)
    expect(voice.disconnect).toHaveBeenCalledTimes(1)
    expect(gate.isHeld()).toBe(false)
  })
  it('does not open a replaced client when its previous connection resolves', async () => {
    let current: HoldToTalkClient | null = null, finish!: (value: HoldToTalkClient) => void
    const gate = createHoldToTalk<HoldToTalkClient>({ getClient: () => current, connectMuted: () => new Promise(resolve => { finish = resolve }) })
    const opening = gate.press(); current = client(true)
    const old = client(); finish(old); await opening
    expect(old.disconnect).toHaveBeenCalledTimes(1)
    expect(current.isMicrophoneEnabled()).toBe(true)
    expect(gate.isHeld()).toBe(false)
  })
  it('a new hold after cancellation waits for the stale connection then starts cleanly', async () => {
    let current: HoldToTalkClient | null = null, finish!: (value: HoldToTalkClient) => void
    const fresh = client()
    const connectMuted = vi.fn<() => Promise<HoldToTalkClient | null>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockImplementationOnce(async () => { current = fresh; return fresh })
    const gate = createHoldToTalk({ getClient: () => current, connectMuted })
    const opening = gate.press(); gate.cancel(); void gate.press()
    const stale = client(); current = stale; finish(stale); await opening
    await vi.advanceTimersByTimeAsync(0)
    expect(stale.disconnect).toHaveBeenCalledTimes(1)
    expect(fresh.isMicrophoneEnabled()).toBe(true)
    expect(connectMuted).toHaveBeenCalledTimes(2)
    gate.dispose()
  })
  it('bounds an unresponsive final turn instead of leaving a paid session open forever', async () => {
    const voice = client(); let current: typeof voice | null = null
    const gate = createHoldToTalk({ getClient: () => current, connectMuted: async () => { current = voice; return voice } })
    await gate.press(); voice.busy(true); gate.release()
    await vi.advanceTimersByTimeAsync(89_500)
    expect(voice.disconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(voice.disconnect).toHaveBeenCalledTimes(1)
  })
})
