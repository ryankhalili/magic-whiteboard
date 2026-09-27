import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../canvas/editor'
import { renderShapesToSvg } from './imageExporter'
import { installNativeInkRenderer } from '../canvas/nativeInkRenderer'

vi.mock('../board/MagicShape', () => ({ magicShapeToSvg: async () => <text>Math object</text> }))
const nativePath = 'M0,0 L30,0 L30,4 Z'
const nativeRenderer = vi.fn(() => nativePath)
let uninstall: () => void
beforeEach(() => { nativeRenderer.mockClear(); uninstall = installNativeInkRenderer(nativeRenderer) })
afterEach(() => uninstall())

describe('owned SVG export', () => {
  it('includes locked screenshot bytes, pressure ink and transformed grouped content', async () => {
    const editor = new Editor()
    editor.createAssets([{ id: 'asset:a', typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,AA==', w: 100, h: 100 } }])
    editor.createShapes([
      { id: 'shape:image', type: 'image', isLocked: true, props: { assetId: 'asset:a', w: 100, h: 100 } },
      { id: 'shape:group', type: 'group', x: 100, y: 50, rotation: Math.PI / 2 },
      { id: 'shape:ink', type: 'draw', parentId: 'shape:group', props: { points: [{ x: 0, y: 0, z: 0.25 }, { x: 30, y: 0, z: 0.8 }], color: 'blue', size: 'm' } },
    ])
    const result = await renderShapesToSvg(editor, [...editor.getCurrentPageShapeIds()], { bounds: { x: 0, y: 0, w: 200, h: 200 }, pixelRatio: 2 })
    expect(result.svg).toContain('data:image/png;base64,AA==')
    expect(result.svg).toContain('fill="#2563eb"')
    expect(result.svg).toContain('100,50)')
    expect(result.svg).toContain('<path')
    expect(result.svg).toContain(`d="${nativePath}"`)
    expect(nativeRenderer).toHaveBeenCalledWith(expect.objectContaining({ strokeWidth: 3.5, pressures: [.25, .8], simulatePressure: false }))
    expect([result.width, result.height]).toEqual([400, 400])
  })

  it('exports a selected group with its children and limits extreme raster dimensions', async () => {
    const editor = new Editor()
    editor.createShapes([{ id: 'shape:g', type: 'group' }, { id: 'shape:m', type: 'magic', parentId: 'shape:g' }, { id: 'shape:other', type: 'magic' }])
    const result = await renderShapesToSvg(editor, ['shape:g'], { bounds: { x: 0, y: 0, w: 100000, h: 100000 }, pixelRatio: 2 })
    expect(result.svg.match(/Math object/g)).toHaveLength(1)
    expect(result.width * result.height).toBeLessThanOrEqual(24_010_000)
    expect(result.width).toBeLessThanOrEqual(8192)
  })
})
