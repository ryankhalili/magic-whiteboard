import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Editor, type TLImageShape } from '../src/canvas/editor'
import { importPdfFile } from '../src/files/pdfImport'
import {
  MAX_PDF_PAGES, PAGE_GAP, PX_PER_PT, boardImportLimit, joinTextItems, layoutPdfPages, pdfPageInfo, worksheetPages,
} from '../src/files/pdfPages'
import { getPdfSource, pdfKey, putPdfSource } from '../src/files/pdfSources'

// the board importer opens PDFs through the library loader; node uses the legacy build
vi.mock('../src/library/pdfjs', async importOriginal => {
  const original = await importOriginal<typeof import('../src/library/pdfjs')>()
  return {
    ...original,
    openPdf: async (bytes: Uint8Array) => {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const task = lib.getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` })
      return task.promise
    },
  }
})

// pdf.js renders in node through its optional @napi-rs/canvas dependency; skip where it is missing
const canvas = await import('@napi-rs/canvas').catch(() => null)
const books = `${process.cwd()}/.local/test-books`
const png = 'data:image/png;base64,iVBORw0KGgo='

function pdfPage(editor: Editor, id: string, meta: Record<string, unknown>, y = 0) {
  const assetId = `asset:${id}`
  editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,AAAA', w: 10, h: 10 } }])
  editor.createShape({ id: `shape:${id}`, type: 'image', x: 0, y, isLocked: true, props: { assetId, w: 816, h: 1056 }, meta: { marginaliaBackground: true, pdf: meta } })
}

async function worksheet(pages: number, text = true) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792])
    if (text) page.drawText(`${i}. Solve 3x + ${i} = 10 for x.`, { x: 72, y: 700, size: 16, font })
  }
  return doc.save()
}

function pdfFile(bytes: Uint8Array, name = 'Unit 3 review.pdf') {
  return new File([bytes as BlobPart], name, { type: 'application/pdf' })
}

function useCanvas() {
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`)
      return canvas!.createCanvas(1, 1)
    },
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pdf page helpers', () => {
  it('joins pdf.js text items into trimmed lines and skips marked content', () => {
    const items = [{ str: '1.  Solve ', hasEOL: false }, { str: '3(x - 2) = 2x + 5.', hasEOL: true }, { type: 'beginMarkedContent', id: 'm1' }, { str: '   ', hasEOL: true }, { str: 'Name', hasEOL: false }]
    expect(joinTextItems(items)).toBe('1. Solve 3(x - 2) = 2x + 5.\nName')
    expect(joinTextItems(items, 8)).toBe('1. Solve')
    expect(joinTextItems([null, { str: 42 }, { hasEOL: true }])).toBe('')
  })

  it('stacks pages from the origin on an empty board and centers narrower pages', () => {
    const layout = layoutPdfPages([{ width: 612, height: 792 }, { width: 595.28, height: 841.89 }], [])
    expect(layout[0]).toEqual({ x: 0, y: 0, w: 816, h: 1056 })
    expect(layout[1].x).toBeCloseTo((816 - 595.28 * PX_PER_PT) / 2)
    expect(layout[1].y).toBe(1056 + PAGE_GAP)
    expect(layout[1].w).toBeCloseTo(793.7, 1)
  })

  it('places new pages to the right of existing work, top aligned', () => {
    const layout = layoutPdfPages([{ width: 612, height: 792 }], [{ x: -50, y: 30, w: 400, h: 200 }, { x: 600, y: -20, w: 100, h: 100 }])
    expect(layout[0]).toMatchObject({ x: 860, y: -20 })
  })

  it('fits a single page into the A4 frame from the top', () => {
    const [page] = layoutPdfPages([{ width: 612, height: 792 }], [], { x: 0, y: 0, w: 794, h: 1123 })
    expect(page.w).toBeCloseTo(794)
    expect(page.h).toBeCloseTo(1056 * 794 / 816)
    expect(page.y).toBe(0)
  })

  it('reads only well formed page metadata and orders pages by import, then page number', () => {
    const editor = new Editor()
    pdfPage(editor, 'b2', { doc: 'b', name: 'Second', page: 2, pages: 2, at: 20, source: null, width: 612, height: 792, text: '' })
    pdfPage(editor, 'a1', { doc: 'a', name: 'First', page: 1, pages: 1, at: 10, source: null, width: 612, height: 792, text: 'Problem 1' })
    pdfPage(editor, 'b1', { doc: 'b', name: 'Second', page: 1, pages: 2, at: 20, source: null, width: 612, height: 792, text: '' })
    pdfPage(editor, 'bad', { doc: 'c', page: 'one' })
    expect(worksheetPages(editor).map(page => page.id)).toEqual(['shape:a1', 'shape:b1', 'shape:b2'])
    expect(pdfPageInfo(editor.getShape('shape:bad'))).toBeNull()
    expect(pdfPageInfo(editor.getShape('shape:a1'))).toMatchObject({ name: 'First', text: 'Problem 1', width: 612 })
  })
})

describe('board import limits', () => {
  it('sends long or large PDFs to the library instead of the board', () => {
    expect(boardImportLimit(1, 200_000)).toBeNull()
    expect(boardImportLimit(0, 1000)).toBeNull()
    expect(boardImportLimit(MAX_PDF_PAGES, 40 * 1024 * 1024)).toBeNull()
    expect(boardImportLimit(769, 1000)).toBe('This PDF has 769 pages, too many for the board (up to 120). Save it to the library instead.')
    expect(boardImportLimit(1, 52_104_540)).toBe('This PDF is 50 MB, too big for the board (up to 40 MB). Save it to the library instead.')
  })

  it('checks the size before reading the file', async () => {
    const arrayBuffer = vi.fn()
    const big = { name: 'book.pdf', type: 'application/pdf', size: 41 * 1024 * 1024, arrayBuffer } as unknown as File
    await expect(importPdfFile(new Editor(), big, { mode: 'infinite' })).rejects.toThrow('Save it to the library instead.')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects a file that is not a PDF', async () => {
    const file = new File(['just some notes'], 'notes.pdf', { type: 'application/pdf' })
    await expect(importPdfFile(new Editor(), file, { mode: 'infinite' })).rejects.toThrow('This file is not a PDF.')
  })

  it('rejects more than 120 pages with the library hint and leaves the board alone', async () => {
    const editor = new Editor()
    await expect(importPdfFile(editor, pdfFile(await worksheet(121, false)), { mode: 'infinite' }))
      .rejects.toThrow('This PDF has 121 pages, too many for the board (up to 120). Save it to the library instead.')
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })

  it.skipIf(!existsSync(`${books}/calculus-volume-1.pdf`))('turns the real 769 page textbook away from the board', async () => {
    const bytes = readFileSync(`${books}/calculus-volume-1.pdf`)
    await expect(importPdfFile(new Editor(), pdfFile(bytes, 'calculus-volume-1.pdf'), { mode: 'infinite' })).rejects.toThrow('Save it to the library instead.')
  })
})

describe('board PDF import', () => {
  it.skipIf(!canvas)('puts every page on the board as a locked background with its text', async () => {
    useCanvas()
    const editor = new Editor(), bytes = await worksheet(2), progress: number[][] = []
    const result = await importPdfFile(editor, pdfFile(bytes), { mode: 'infinite', onProgress: (page, pages) => progress.push([page, pages]) })
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(progress).toEqual([[1, 2], [2, 2]])
    expect(result).toMatchObject({ pages: 2, source: `sha256:${sha}`, keptSource: true, hasText: true, switchToInfinite: false })
    expect(result.layout[0]).toEqual({ x: 0, y: 0, w: 816, h: 1056 })
    expect(result.layout[1].y).toBe(1056 + PAGE_GAP)
    const shapes = result.ids.map(id => editor.getShape<TLImageShape>(id)!)
    shapes.forEach((shape, index) => {
      expect(shape).toMatchObject({ type: 'image', isLocked: true, meta: { marginaliaBackground: true } })
      expect(shape.props.assetId).toBe(`asset:pdf-${sha.slice(0, 24)}-p${index + 1}`)
      expect(shape.props.altText).toBe(`Unit 3 review, page ${index + 1} of 2`)
      const info = pdfPageInfo(shape)!
      expect(info).toMatchObject({ name: 'Unit 3 review', page: index + 1, pages: 2, width: 612, height: 792, source: `sha256:${sha}` })
      expect(info.text).toBe(`${index + 1}. Solve 3x + ${index + 1} = 10 for x.`)
      const asset = editor.getAsset(shape.props.assetId)!
      expect(asset.props.src).toMatch(/^data:image\/(png|jpeg);base64,/)
      expect(asset.props.w).toBe(Math.round(612 * 2 * PX_PER_PT))
    })
    // the raster really shows the page: dark text on white near the top left
    const src = editor.getAsset(shapes[0].props.assetId)!.props.src
    const image = await canvas!.loadImage(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'))
    const surface = canvas!.createCanvas(image.width, image.height), context = surface.getContext('2d')
    context.drawImage(image, 0, 0)
    const band = context.getImageData(0, 0, image.width, Math.round(image.height * 0.2)).data
    let dark = 0
    for (let i = 0; i < band.length; i += 4) if (band[i] < 100 && band[i + 3] > 200) dark++
    expect(dark).toBeGreaterThan(200)
    expect(Array.from(context.getImageData(image.width - 5, image.height - 5, 1, 1).data)).toEqual([255, 255, 255, 255])
    expect(editor.getSelectedShapeIds()).toEqual([])
    // the snapshot reloads, so every page asset passed the same checks as normalizeSnapshot
    expect(() => new Editor().loadSnapshot(editor.getSnapshot())).not.toThrow()
    expect(Array.from(await getPdfSource(`sha256:${sha}`) ?? [])).toEqual(Array.from(bytes))

    // the same file again reuses its page images and goes to the right of the first copy
    const again = await importPdfFile(editor, pdfFile(bytes), { mode: 'infinite', zoom: false })
    expect(again.layout[0]).toMatchObject({ x: 816 + 160, y: 0 })
    expect(editor.store.allRecords().filter(record => record.typeName === 'asset')).toHaveLength(2)
    editor.undo()
    expect(again.ids.every(id => !editor.getShape(id))).toBe(true)
    expect(result.ids.every(id => !!editor.getShape(id))).toBe(true)
  })

  it.skipIf(!canvas)('replaces the A4 background with a one page PDF in page mode', async () => {
    useCanvas()
    const editor = new Editor()
    editor.createAssets([{ id: 'asset:old', typeName: 'asset', type: 'image', meta: {}, props: { src: png, w: 10, h: 10 } }])
    editor.createShape({ id: 'shape:old', type: 'image', isLocked: true, props: { assetId: 'asset:old', w: 794, h: 1123 }, meta: { marginaliaBackground: true } })
    editor.createShape({ id: 'shape:ink', type: 'draw', props: { points: [{ x: 10, y: 10 }, { x: 40, y: 40 }], color: 'black', size: 'm' } })
    const result = await importPdfFile(editor, pdfFile(await worksheet(1), 'quiz.PDF'), { mode: 'page' })
    expect(result.switchToInfinite).toBe(false)
    expect(result.first.x).toBeCloseTo(0)
    expect(result.first.w).toBeCloseTo(794)
    expect(editor.getShape('shape:old')).toBeUndefined()
    expect(editor.getShape('shape:ink')).toBeDefined()
    expect(pdfPageInfo(editor.getShape(result.ids[0]))?.name).toBe('quiz')
    // backgrounds go under the ink
    expect(editor.getCurrentPageShapesSorted().map(shape => shape.id)).toEqual([result.ids[0], 'shape:ink'])
  })

  it.skipIf(!canvas)('still imports when the original cannot be kept on the device', async () => {
    useCanvas()
    vi.stubGlobal('indexedDB', undefined)
    vi.resetModules()
    const { importPdfFile: fresh } = await import('../src/files/pdfImport')
    const result = await fresh(new Editor(), pdfFile(await worksheet(1)), { mode: 'infinite' })
    expect(result).toMatchObject({ pages: 1, keptSource: false })
    expect(result.source).toMatch(/^sha256:[\da-f]{64}$/)
  })

  it.skipIf(!canvas || !existsSync(`${books}/six-pages.pdf`))('imports a real multi page PDF', async () => {
    useCanvas()
    const editor = new Editor()
    const result = await importPdfFile(editor, pdfFile(readFileSync(`${books}/six-pages.pdf`), 'six-pages.pdf'), { mode: 'infinite' })
    expect(result.pages).toBe(6)
    expect(editor.getCurrentPageShapes()).toHaveLength(6)
    expect(() => new Editor().loadSnapshot(editor.getSnapshot())).not.toThrow()
  }, 60_000)
})

describe('original PDF store', () => {
  it('keys each PDF by the SHA-256 of its bytes, stores it once and reads it back', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 test file')
    const key = await putPdfSource(bytes)
    expect(key).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    expect(await pdfKey(bytes)).toBe(key)
    expect(await putPdfSource(bytes)).toBe(key)
    expect(Array.from(await getPdfSource(key) ?? [])).toEqual(Array.from(bytes))
    expect(await getPdfSource('sha256:missing')).toBeNull()
  })
})

describe('board asset checks', () => {
  const asset = (id: string, src: string, size: Partial<{ w: number; h: number }> = {}) =>
    ({ id, typeName: 'asset' as const, type: 'image' as const, meta: {}, props: { src, w: 10, h: 10, ...size } })

  it('accepts embedded rasters and rejects anything a reload would refuse', () => {
    const editor = new Editor()
    editor.createAssets([asset('asset:ok', png), asset('asset:jpeg', 'data:image/jpeg;base64,/9j/4AAQ\nSkZJRg==')])
    expect(editor.getAsset('asset:ok')?.props.src).toBe(png)
    for (const src of ['https://example.com/page.png', 'blob:http://localhost/1', 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:application/pdf;base64,JVBERi0xLjcK', 'data:image/png;base64,<script>', 'data:image/png,raw']) {
      expect(() => editor.createAssets([asset('asset:bad', src)]), src).toThrow('Only embedded PNG, JPEG, WebP, or GIF images')
    }
    expect(() => editor.createAssets([{ ...asset('asset:pdf', png), type: 'pdf' } as never])).toThrow('Only embedded')
    expect(() => editor.createAssets([asset('asset:zero', png, { w: 0 })])).toThrow('invalid size')
    expect(() => editor.createAssets([asset('asset:nan', png, { h: Number.NaN })])).toThrow('invalid size')
    expect(editor.getAsset('asset:bad')).toBeUndefined()
    expect(() => new Editor().loadSnapshot(editor.getSnapshot())).not.toThrow()
  })

  it('adds a batch all or nothing and never overwrites a shape', () => {
    const editor = new Editor()
    editor.createShape({ id: 'shape:x', type: 'geo', props: { w: 10, h: 10 } })
    expect(() => editor.createAssets([asset('asset:good', png), asset('asset:bad', 'https://example.com/a.png')])).toThrow()
    expect(editor.getAsset('asset:good')).toBeUndefined()
    expect(() => editor.createAssets([asset('shape:x', png)])).toThrow('Only embedded')
    expect(editor.getShape('shape:x')).toBeDefined()
  })

  it('refuses images past the notebook limit instead of breaking the next reload', () => {
    const editor = new Editor()
    const big = `data:image/png;base64,${'A'.repeat(30_000_000)}`
    editor.createAssets([asset('asset:one', big)])
    // replacing an asset with itself does not count twice
    editor.createAssets([asset('asset:one', big)])
    expect(() => editor.createAssets([asset('asset:two', big)])).toThrow('no room for more images')
    expect(editor.getAsset('asset:two')).toBeUndefined()
  })
})
