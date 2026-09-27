import { deflateSync } from 'node:zlib'

/** Small valid PNG fixture; dimensions can match the production image-size contract. */
export function generatedPng(width = 1024, height = 1024) {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length); body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))])
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height }
}
