import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { Editor, type ImageExportOptions } from '../src/canvas/editor'
import {
  buildRegionPdf, exportBoard, exportRegionPdf, getExportBounds, pdfPageSize, regionFromSelection, regionShapeIds, renderBoardPng,
} from '../src/files/boardFiles'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/board'

// 40 x 40 transparent PNG with a red 10 x 10 square in its top left corner
const MARKER = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAA2SURBVFiF7c7BCQAgEAPBnP33rC0oJ/hw5h3I1kxmNlRSO7vbxovTEwK7BHYJ7BIIAAAAAP9aDEICFPEozGAAAAAASUVORK5CYII='
const pngBlob = () => new Blob([Buffer.from(MARKER, 'base64')], { type: 'image/png' })
const settings: AppSettings = { ...DEFAULT_SETTINGS, name: 'Lesson 4', paper: 'grid', backgroundColor: '#fdfcf7' }

type Canvas = { width: number; height: number; ops: string[] }
let canvases: Canvas[], downloads: { name: string; blob: Blob }[], exports: { ids: string[]; options: ImageExportOptions }[]

// a small stand in for the browser canvas, image and download link, recording what export does with them
beforeEach(() => {
  canvases = []; downloads = []; exports = []
  const blobs = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { const url = `blob:test/${blobs.size}`; blobs.set(url, blob as Blob); return url })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const canvas = () => {
    const record: Canvas & Record<string, unknown> = { width: 0, height: 0, ops: [] }
    const context: Record<string, unknown> = {}
    for (const name of ['beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke']) context[name] = () => {}
    context.scale = (x: number, y: number) => record.ops.push(`scale ${x.toFixed(3)} ${y.toFixed(3)}`)
    context.fillRect = (...args: number[]) => record.ops.push(`fill ${context.fillStyle} ${args.join(' ')}`)
    context.drawImage = (_image: unknown, ...args: number[]) => record.ops.push(`draw ${args.join(' ')}`)
    record.getContext = () => context
    record.toBlob = (done: (blob: Blob) => void) => done(pngBlob())
    canvases.push(record)
    return record
  }
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'canvas') return canvas()
      const link = { href: '', download: '', click: () => downloads.push({ name: link.download, blob: blobs.get(link.href)! }), remove: () => {} }
      return link
    },
    body: { appendChild: () => {} },
  })
  vi.stubGlobal('window', { setTimeout: () => 0 })
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_url: string) { queueMicrotask(() => this.onload?.()) }
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function board() {
  const editor = new Editor()
  editor.setImageExporter(async (_editor, ids, options) => { exports.push({ ids, options }); return { blob: pngBlob() } })
  editor.createAssets([{ id: 'asset:page', typeName: 'asset', type: 'image', meta: {}, props: { src: `data:image/png;base64,${MARKER}`, w: 40, h: 40 } }])
  editor.createShapes([
    { id: 'shape:page', type: 'image', x: 0, y: 0, isLocked: true, props: { assetId: 'asset:page', w: 816, h: 1056 }, meta: { marginaliaBackground: true } },
    { id: 'shape:ink', type: 'draw', props: { points: [{ x: 120, y: 150 }, { x: 260, y: 190 }], color: 'blue', size: 'm' } },
    { id: 'shape:note', type: 'geo', x: 300, y: 400, props: { w: 100, h: 50 } },
    { id: 'shape:far', type: 'geo', x: 3000, y: 3000, props: { w: 100, h: 100 } },
  ])
  return editor
}

describe('region helpers', () => {
  it('finds every object touching the region, locked pages included', () => {
    const editor = board()
    expect(regionShapeIds(editor, { x: 100, y: 100, w: 300, h: 200 })).toEqual(['shape:page', 'shape:ink'])
    expect(regionShapeIds(editor, { x: 350, y: 420, w: 10, h: 10 })).toEqual(['shape:page', 'shape:note'])
    expect(regionShapeIds(editor, { x: 900, y: 0, w: 100, h: 100 })).toEqual([])
    // touching an edge is not inside
    expect(regionShapeIds(editor, { x: 400, y: 400, w: 50, h: 50 })).toEqual(['shape:page'])
  })

  it('pads the selection by 24 on every side', () => {
    const editor = board()
    expect(regionFromSelection(editor)).toBeNull()
    editor.select('shape:note', 'shape:far')
    expect(regionFromSelection(editor)).toEqual({ x: 276, y: 376, w: 2848, h: 2748 })
    editor.select('shape:note')
    expect(regionFromSelection(editor, 0)).toEqual({ x: 300, y: 400, w: 100, h: 50 })
  })

  it('sizes PDF pages at 72 dpi and caps the longest edge', () => {
    expect(pdfPageSize({ x: 5, y: 5, w: 800, h: 400 })).toEqual([600, 300])
    const [w, h] = pdfPageSize({ x: 0, y: 0, w: 40_000, h: 100 })
    expect(w).toBeCloseTo(14_400)
    expect(h).toBeCloseTo(36)
  })
})

describe('selected area PDF', () => {
  it('renders just that area with its paper and page under it, one page at board scale', async () => {
    const editor = board(), region = { x: 100, y: 100, w: 300, h: 200 }
    const bytes = await buildRegionPdf(editor, region, settings)
    expect(exports).toHaveLength(1)
    expect(exports[0].ids).toEqual(['shape:page', 'shape:ink'])
    expect(exports[0].options).toMatchObject({ bounds: region, padding: 0, background: false, pixelRatio: 2, darkMode: false })
    expect(canvases[0]).toMatchObject({ width: 600, height: 400 })
    expect(canvases[0].ops).toEqual(['scale 2.000 2.000', 'fill #fdfcf7 0 0 300 200', 'draw 0 0 300 200'])
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(1)
    expect(pdf.getPage(0).getSize()).toEqual({ width: 225, height: 150 })
    expect(pdf.getTitle()).toBe('Lesson 4')
    const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    expect(images.length).toBeGreaterThan(0)
  })

  it('keeps huge areas inside canvas and PDF limits', async () => {
    const editor = board(), region = { x: -10_000, y: -5_000, w: 20_000, h: 10_000 }
    const bytes = await buildRegionPdf(editor, region, settings)
    const ratio = exports[0].options.pixelRatio!
    // iPad Safari's canvas limit is 16,777,216 pixels
    expect(ratio).toBeCloseTo(Math.sqrt(16_000_000 / 200_000_000))
    expect(canvases[0].width * canvases[0].height).toBeLessThanOrEqual(16_777_216)
    expect(exports[0].ids).toHaveLength(4)
    const size = (await PDFDocument.load(bytes)).getPage(0).getSize()
    expect(size.width).toBeCloseTo(14_400)
    expect(size.height).toBeCloseTo(7_200)
  })

  it('keeps six inserted textbook pages under the iPad canvas limit', async () => {
    const editor = board(), region = { x: -24, y: -24, w: 2248, h: 1914 }
    await buildRegionPdf(editor, region, settings)
    expect(canvases[0].width * canvases[0].height).toBeLessThanOrEqual(16_777_216)
    expect(exports[0].options.pixelRatio).toBeLessThan(2)
    // the image exporter's own canvas has the same cap
    const { renderShapesToSvg } = await import('../src/files/imageExporter')
    const svg = await renderShapesToSvg(editor, ['shape:note'], { bounds: region, pixelRatio: 2 })
    expect(svg.width * svg.height).toBeLessThanOrEqual(16_777_216)
  })

  it('explains empty, tiny and broken areas', async () => {
    const editor = board()
    await expect(buildRegionPdf(editor, { x: 900, y: 0, w: 100, h: 100 }, settings)).rejects.toThrow('Nothing on the board is inside that area.')
    await expect(buildRegionPdf(editor, { x: 100, y: 100, w: 4, h: 100 }, settings)).rejects.toThrow('The area to export is too small.')
    await expect(buildRegionPdf(editor, { x: Number.NaN, y: 0, w: 100, h: 100 }, settings)).rejects.toThrow('The export area is invalid.')
    await expect(buildRegionPdf(editor, { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 100 }, settings)).rejects.toThrow('The export area is invalid.')
    expect(exports).toHaveLength(0)
  })

  it('downloads the area as a named PDF', async () => {
    const editor = board()
    await exportRegionPdf(editor, { x: 100, y: 100, w: 300, h: 200 }, settings)
    await exportRegionPdf(editor, { x: 100, y: 100, w: 300, h: 200 }, settings, 'Problem 3.2: work')
    expect(downloads.map(download => download.name)).toEqual(['Lesson 4 area.pdf', 'Problem 3.2- work.pdf'])
    expect(downloads[0].blob.type).toBe('application/pdf')
    expect(new TextDecoder().decode((await downloads[0].blob.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
  })
})

describe('whole board export', () => {
  it('still sends every object and the full board bounds', async () => {
    const editor = board()
    const { bounds } = await renderBoardPng(editor, settings)
    expect(bounds).toEqual(getExportBounds(editor, settings))
    expect(exports[0].ids.sort()).toEqual(['shape:far', 'shape:ink', 'shape:note', 'shape:page'])
    expect(exports[0].options.bounds).toEqual(bounds)
  })

  it('keeps the A4 page size in page mode and the content size otherwise', async () => {
    const editor = board()
    await exportBoard(editor, 'pdf', { ...settings, mode: 'page' })
    await exportBoard(editor, 'pdf', settings)
    await exportBoard(editor, 'png', settings)
    expect(downloads.map(download => download.name)).toEqual(['Lesson 4.pdf', 'Lesson 4.pdf', 'Lesson 4.png'])
    const a4 = (await PDFDocument.load(await downloads[0].blob.arrayBuffer())).getPage(0).getSize()
    expect(a4.width).toBeCloseTo(595.28)
    expect(a4.height).toBeCloseTo(841.89)
    const whole = getExportBounds(editor, settings)
    const sized = (await PDFDocument.load(await downloads[1].blob.arrayBuffer())).getPage(0).getSize()
    expect(sized.width).toBeCloseTo(whole.w * 0.75)
    expect(sized.height).toBeCloseTo(whole.h * 0.75)
  })
})
