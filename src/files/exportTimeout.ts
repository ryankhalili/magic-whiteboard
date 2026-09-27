// iPad Safari refuses canvases above 16,777,216 pixels, so exports stay a little under it
export const MAX_EXPORT_PIXELS = 16_000_000

export function exportTimeout<T>(promise: Promise<T>, stage: string, milliseconds = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Export timed out while ${stage}. Please try again.`)), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
