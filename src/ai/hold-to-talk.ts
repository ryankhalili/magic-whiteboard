export type HoldToTalkClient = {
  isConnected(): boolean
  isMicrophoneEnabled(): boolean
  setMicrophoneEnabled(enabled: boolean): void
  isWorking(): boolean
  disconnect(): void
}

/** Keyboard/pointer lifecycle shared by desktop shortcuts and a touch hold button.
 * connectMuted MUST create a client with initiallyEnabled:false, including while
 * permission/negotiation is pending. No audio may escape after an early release.
 */
export function createHoldToTalk<T extends HoldToTalkClient>(options: {
  getClient(): T | null
  connectMuted(): Promise<T | null>
  onHoldChange?(held: boolean): void
  onError?(error: unknown): void
}) {
  let held = false
  let disposed = false
  let epoch = 0
  let active: T | null = null
  let owned = false
  let restoreEnabled = false
  let connecting: Promise<void> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  function notify(value: boolean) {
    if (held !== value) { held = value; options.onHoldChange?.(value) }
  }
  function clearClose() { clearTimeout(closeTimer); closeTimer = undefined }
  function closeAfterTurn(client: T) {
    clearClose()
    // A key-up can precede speech_started in a slow network. Leave enough time for
    // the VAD commit, then wait for tools/repair to settle instead of cutting them off.
    const deadline = Date.now() + 90_000
    const close = () => {
      if (held || !owned || active !== client) return
      if (!client.isConnected() || !client.isWorking() || Date.now() >= deadline) {
        client.disconnect(); active = null; owned = false
      } else closeTimer = setTimeout(close, 500)
    }
    closeTimer = setTimeout(close, 5_000)
  }
  function enable(client: T) {
    // An app may replace its client on notebook changes or explicit voice toggles.
    if (options.getClient() !== client || !client.isConnected()) return
    client.setMicrophoneEnabled(true)
  }
  function press(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (held) return connecting ?? Promise.resolve()
    notify(true); clearClose()
    if (connecting) return connecting
    const existing = options.getClient()
    if (existing?.isConnected()) {
      if (active !== existing) { active = existing; owned = false; restoreEnabled = existing.isMicrophoneEnabled() }
      enable(existing)
      return Promise.resolve()
    }
    const started = epoch
    connecting = (async () => {
      try {
        const client = await options.connectMuted()
        if (!client) { if (started === epoch) notify(false); return }
        if (disposed || started !== epoch || options.getClient() !== client) {
          client.disconnect()
          if (started === epoch) notify(false)
          return
        }
        active = client; owned = true; restoreEnabled = false
        if (held) enable(client)
        else { client.setMicrophoneEnabled(false); closeAfterTurn(client) }
      } catch (error) { if (!disposed && started === epoch) { notify(false); options.onError?.(error) } }
      finally {
        connecting = null
        // A notebook change invalidates the old request. A new keydown may have
        // arrived while its browser permission dialog was still resolving.
        if (!disposed && started !== epoch && held) { held = false; void press() }
      }
    })()
    return connecting
  }
  function release() {
    notify(false)
    if (active) {
      active.setMicrophoneEnabled(owned ? false : restoreEnabled)
      if (owned) closeAfterTurn(active)
    }
  }
  function cancel() {
    epoch++; notify(false); clearClose()
    if (active) {
      active.setMicrophoneEnabled(false)
      if (owned) active.disconnect()
    }
    active = null; owned = false
  }
  return { press, release, cancel, isHeld: () => held, dispose() { disposed = true; cancel() } }
}
