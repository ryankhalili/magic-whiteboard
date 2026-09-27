/** Local microphone RMS only: no audio samples leave this meter or get persisted. */
export function createAudioMeter(onLevel: ((level: number) => void) | undefined) {
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  if (onLevel) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      try { context = new AudioContextClass(); void context.resume().catch(() => {}) } catch { /* Meter unavailable; voice can still connect. */ }
    }
  }
  return {
    attach(stream: MediaStream) {
      if (!context || !onLevel) return
      try {
        analyser = context.createAnalyser(); analyser.fftSize = 512
        source = context.createMediaStreamSource(stream); source.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let smoothed = 0
        timer = setInterval(() => {
          if (!analyser) return
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) sum += sample * sample
          const rms = Math.sqrt(sum / samples.length)
          // Modest display gain, then smoothing; this visual does not alter the microphone.
          const level = Math.min(1, Math.max(0, (rms - 0.004) * 7))
          smoothed = level > smoothed ? level * 0.65 + smoothed * 0.35 : level * 0.25 + smoothed * 0.75
          onLevel(smoothed)
        }, 50)
      } catch { /* Don't fail voice if a device cannot analyze its input. */ }
    },
    stop() {
      clearInterval(timer); timer = undefined
      source?.disconnect(); source = undefined
      analyser?.disconnect(); analyser = undefined
      if (context && context.state !== 'closed') void context.close().catch(() => {})
      context = undefined
      onLevel?.(0)
    },
  }
}
