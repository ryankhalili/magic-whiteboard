import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './editor'
import { isLiveContentShape, liveContentKey, renderLiveContentImage, type LiveContentShape } from './liveContentImage'
import { renderShapesToImage } from '../files/imageExporter'
import { disconnectedInkBounds } from './disconnectedInk'
import type { TLShape } from './types'

vi.mock('../files/imageExporter', () => ({ renderShapesToImage: vi.fn(async () => ({ blob: new Blob(['png'], { type: 'image/png' }) })) }))

function shape(): LiveContentShape {
  const editor = new Editor()
  editor.createShape({ id: 'shape:source', type: 'magic', x: 120, y: 340, rotation: .7, opacity: .4, props: { kind: 'plot', w: 420, h: 300 } })
  return editor.getShape('shape:source') as LiveContentShape
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('live content image projection', () => {
  it('renders separate legacy ink paths using their padded nonzero local bounds', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,cG5n'
      onload?: () => void
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    })
    const editor = new Editor()
    const segments = [{ points: [{ x: -40, y: 10 }, { x: -20, y: 15 }] }, { points: [{ x: 80, y: 50 }, { x: 100, y: 80 }] }]
    editor.createShape({ id: 'legacy-ink', type: 'draw', x: 100, props: { points: segments.flatMap(segment => segment.points), segments, color: 'blue', size: 'm' } })
    const ink = editor.getShape<TLShape<'draw'>>('legacy-ink')!
    expect(isLiveContentShape(ink)).toBe(true)
    await renderLiveContentImage(ink)
    const [isolated, ids, options] = vi.mocked(renderShapesToImage).mock.calls[0]
    expect(isolated.getShape(ids[0])?.props).toMatchObject({ segments })
    expect(options?.bounds).toEqual(disconnectedInkBounds(ink))
    expect(options?.bounds?.x).toBeLessThan(-40)
    expect(liveContentKey({ ...ink, x: 900, rotation: .9 })).toBe(liveContentKey(ink))
  })
  it('reuses pixels across poses and metadata ordering, but invalidates render changes', () => {
    const source = shape()
    const moved = { ...source, id: 'shape:copy', x: 9, y: 8, rotation: 2, opacity: .1, index: 99, parentId: 'shape:group', meta: { excalidrawGroupIds: ['g'] } }
    expect(liveContentKey(moved)).toBe(liveContentKey(source))
    expect(liveContentKey({ ...source, props: Object.fromEntries(Object.entries(source.props).reverse()) } as LiveContentShape)).toBe(liveContentKey(source))
    expect(liveContentKey({ ...source, meta: { axisMode: 'equal' } })).not.toBe(liveContentKey(source))
    expect(liveContentKey({ ...source, props: { ...source.props, w: 840 } } as LiveContentShape)).not.toBe(liveContentKey(source))
    expect(isLiveContentShape({ ...source, meta: { excalidrawElement: { id: source.id } } })).toBe(false)
  })

  it('renders an isolated opaque copy and keeps deterministic file identity', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,cG5n'
      onload?: () => void
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    })
    const source = shape(), before = structuredClone(source)
    const file = await renderLiveContentImage(source)
    const repeat = await renderLiveContentImage({ ...source, x: -40, opacity: .2 })
    expect(file.id).toBe(repeat.id)
    expect(file).toMatchObject({ mimeType: 'image/png', dataURL: 'data:image/png;base64,cG5n' })
    expect(source).toEqual(before)
    const [isolated, ids, options] = vi.mocked(renderShapesToImage).mock.calls[0]
    expect(isolated.getCurrentPageShapes()).toHaveLength(1)
    expect(isolated.getShape(ids[0])).toMatchObject({ x: 0, y: 0, rotation: 0, opacity: 1, parentId: isolated.getCurrentPageId() })
    expect(options).toMatchObject({ scale: 2, background: false, padding: 0, bounds: { x: 0, y: 0, w: 420, h: 300 } })
  })

  it('caps bitmap memory for very large content', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,cG5n'
      onload?: () => void
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    })
    const source = shape()
    await renderLiveContentImage({ ...source, props: { ...source.props, w: 100_000, h: 50_000 } } as LiveContentShape)
    const options = vi.mocked(renderShapesToImage).mock.calls[0][2]!
    const { w, h } = options.bounds!, scale = options.scale!
    expect(w * scale).toBeLessThanOrEqual(4096)
    expect(h * scale).toBeLessThanOrEqual(4096)
    expect(w * h * scale * scale).toBeLessThanOrEqual(2048 * 2048 + 1)
  })

  it.each([
    ['HTTP without subtle', {}],
    ['missing Web Crypto', undefined],
    ['blocked digest', { subtle: { digest: async () => { throw new Error('Web Crypto is unavailable') } } }],
  ])('keeps content identity and renders with %s', async (_name, cryptoValue) => {
    vi.stubGlobal('crypto', cryptoValue)
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,cG5n'
      onload?: () => void
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    })
    const source = shape()
    const file = await renderLiveContentImage(source)
    const moved = await renderLiveContentImage({ ...source, id: 'shape:moved', x: 20, rotation: 1, opacity: .2 })
    const edited = await renderLiveContentImage({ ...source, props: { ...source.props, expression: 'cos(x)' } } as LiveContentShape)
    const resized = await renderLiveContentImage({ ...source, props: { ...source.props, w: 800 } } as LiveContentShape)
    expect(file.id).toMatch(/^magic-content-local-[0-9a-f]{32}$/)
    expect(moved.id).toBe(file.id)
    expect(new Set([file.id, edited.id, resized.id]).size).toBe(3)
    expect(file.dataURL).toBe('data:image/png;base64,cG5n')
  })
})
