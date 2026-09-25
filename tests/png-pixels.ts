import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

export function pngPixel(image: Buffer, targetX: number, targetY: number): [number, number, number, number] {
  const width = image.readUInt32BE(16)
  const height = image.readUInt32BE(20)
  assert.equal(image[24], 8, 'expected 8-bit PNG')
  assert.equal(image[25], 6, 'expected RGBA PNG')
  assert.ok(targetX >= 0 && targetX < width && targetY >= 0 && targetY < height)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < image.length;) {
    const length = image.readUInt32BE(offset)
    const type = image.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(image.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') break
  }
  const scanlines = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * (targetY + 1))
  for (let row = 0; row <= targetY; row++) {
    const source = row * (stride + 1)
    const filter = scanlines[source]
    for (let column = 0; column < stride; column++) {
      const left = column >= 4 ? pixels[row * stride + column - 4] : 0
      const above = row ? pixels[(row - 1) * stride + column] : 0
      const aboveLeft = row && column >= 4 ? pixels[(row - 1) * stride + column - 4] : 0
      const predictor = left + above - aboveLeft
      const distances = [Math.abs(predictor - left), Math.abs(predictor - above), Math.abs(predictor - aboveLeft)]
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left
        : distances[1] <= distances[2] ? above : aboveLeft
      const reconstruction = [0, left, above, Math.floor((left + above) / 2), paeth][filter]
      assert.notEqual(reconstruction, undefined, `unknown PNG filter ${filter}`)
      pixels[row * stride + column] = (scanlines[source + 1 + column] + reconstruction) & 255
    }
  }
  const position = targetY * stride + targetX * 4
  return [pixels[position], pixels[position + 1], pixels[position + 2], pixels[position + 3]]
}
