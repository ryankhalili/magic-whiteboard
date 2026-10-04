import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { Editor } from '../src/canvas/editor'
import { Matrix2d } from '../src/canvas/geometry'
import { buildWorksheetPdf, worksheetAnnotationIds, worksheetOverlayOptions } from '../src/files/pdfExport'
import { pdfKey, putPdfSource } from '../src/files/pdfSources'
import { worksheetPages, PX_PER_PT } from '../src/files/pdfPages'
import { loadProject, parseProjectFile, portableProjectFileBlob } from '../src/files/boardFiles'
import { DEFAULT_SETTINGS } from '../shared/board'

const canvas = await import('@napi-rs/canvas').catch(() => null)
const marker = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAA2SURBVFiF7c7BCQAgEAPBnP33rC0oJ/hw5h3I1kxmNlRSO7vbxovTEwK7BHYJ7BIIAAAAAP9aDEICFPEozGAAAAAASUVORK5CYII='
function useCanvas() {
  vi.stubGlobal('document', { createElement: () => canvas!.createCanvas(1, 1) })
  // Browsers accept percent-encoded SVG data URLs; the Node canvas expects decoded bytes.
  vi.stubGlobal('Image', function () {
    const image = new canvas!.Image(), setter = Object.getOwnPropertyDescriptor(canvas!.Image.prototype, 'src')!.set!
    Object.defineProperty(image, 'src', { set(value: string) {
      setter.call(image, value.startsWith('data:image/svg+xml;') ? Buffer.from(decodeURIComponent(value.slice(value.indexOf(',') + 1))) : value)
    } })
    return image
  })
}
afterEach(() => vi.unstubAllGlobals())

async function source(rotations = [0], forms = false) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const [index, rotation] of rotations.entries()) {
    const page = pdf.addPage([200 + index * 20, 160])
    page.setCropBox(20, 30, 160, 100)
    page.setRotation(degrees(rotation))
    page.drawText(`Problem ${index + 1}`, { x: 30, y: 75, size: 12, font })
  }
  if (forms) {
    const field = pdf.getForm().createTextField('student-name')
    field.addToPage(pdf.getPage(0), { x: 30, y: 40, width: 70, height: 16 })
    field.setText('Ada')
  }
  return pdf.save()
}

async function board(bytes: Uint8Array, options: { stored?: boolean; canvasRotation?: number } = {}) {
  const original = await PDFDocument.load(bytes), editor = new Editor()
  const key = options.stored === false ? null : await putPdfSource(bytes)
  editor.createAssets([{ id: 'asset:page', typeName: 'asset', type: 'image', meta: {}, props: { src: `data:image/png;base64,${marker}`, w: 40, h: 40 } }])
  original.getPages().forEach((page, index) => {
    const crop = page.getCropBox(), swapped = page.getRotation().angle % 180 !== 0
    const width = swapped ? crop.height : crop.width, height = swapped ? crop.width : crop.height
    editor.createShape({ id: `shape:group-${index}`, type: 'group', x: index * 1000, y: 100, rotation: options.canvasRotation ?? 0 })
    editor.createShape({ id: `shape:page-${index}`, type: 'image', parentId: `shape:group-${index}`, isLocked: true,
      props: { assetId: 'asset:page', w: width * PX_PER_PT, h: height * PX_PER_PT },
      meta: { pdf: { doc: 'worksheet', name: 'Review', page: index + 1, pages: original.getPageCount(), width, height, at: 1, source: key, text: '' } } })
  })
  return editor
}

async function renderPdf(bytes: Uint8Array, index: number) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = lib.getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` })
  const pdf = await loading.promise
  try {
    const page = await pdf.getPage(index + 1), viewport = page.getViewport({ scale: PX_PER_PT })
    const surface = canvas!.createCanvas(Math.round(viewport.width), Math.round(viewport.height))
    await page.render({ canvas: surface as never, viewport, background: '#ffffff', intent: 'print' }).promise
    return surface
  } finally { await loading.destroy() }
}

describe('worksheet page export', () => {
  it('preserves every original page, boxes and rotations, including a missing board page', async () => {
    const bytes = await source([0, 90, 180, 270]), editor = await board(bytes)
    editor.run(() => editor.deleteShapes(['shape:page-1']), { ignoreShapeLock: true })
    const progress: number[] = []
    const result = await buildWorksheetPdf(editor, { title: 'Completed homework', onProgress: done => progress.push(done) })
    const output = await PDFDocument.load(result.bytes), original = await PDFDocument.load(bytes)
    expect(result).toMatchObject({ pages: 4, rasterizedPages: 0 })
    expect(progress).toEqual([1, 2, 3, 4])
    output.getPages().forEach((page, index) => {
      expect(page.getMediaBox()).toEqual(original.getPage(index).getMediaBox())
      expect(page.getCropBox()).toEqual(original.getPage(index).getCropBox())
      expect(page.getRotation()).toEqual(original.getPage(index).getRotation())
    })
  })

  it('preserves interactive form fields for a single worksheet', async () => {
    const editor = await board(await source([0], true))
    const output = await PDFDocument.load((await buildWorksheetPdf(editor)).bytes)
    expect(output.getForm().getTextField('student-name').getText()).toBe('Ada')
    expect(output.getForm().getTextField('student-name').acroField.getWidgets()).toHaveLength(1)
  })

  it.skipIf(!canvas)('clips edge-crossing ink, excludes side scratchwork, and aligns all PDF and canvas rotations', async () => {
    useCanvas()
    const editor = await board(await source([0, 90, 180, 270]), { canvasRotation: Math.PI / 5 })
    for (let index = 0; index < 4; index++) {
      editor.createShape({ id: `shape:answer-${index}`, type: 'geo', parentId: `shape:group-${index}`, x: -10, y: 15,
        props: { w: 50, h: 20, color: '#ff0000', fill: 'solid' } })
      editor.createShape({ id: `shape:scratch-${index}`, type: 'geo', parentId: `shape:group-${index}`, x: 300, y: 15,
        props: { w: 50, h: 20, color: '#00ff00', fill: 'solid' } })
    }
    const result = await buildWorksheetPdf(editor)
    for (let index = 0; index < 4; index++) {
      const surface = await renderPdf(result.bytes, index), context = surface.getContext('2d')
      expect([...context.getImageData(5, 25, 1, 1).data].slice(0, 3)).toEqual([255, 0, 0])
      expect([...context.getImageData(70, 25, 1, 1).data].slice(0, 3)).toEqual([255, 255, 255])
      const pixels = context.getImageData(0, 0, surface.width, surface.height).data
      let green = 0
      for (let pixel = 0; pixel < pixels.length; pixel += 4) if (pixels[pixel] < 50 && pixels[pixel + 1] > 200 && pixels[pixel + 2] < 50) green++
      expect(green).toBe(0)
    }
  }, 30000)

  it('maps cropped and flipped page coordinates back to the original full page', async () => {
    const editor = await board(await source(), { canvasRotation: Math.PI / 2 })
    editor.run(() => editor.updateShape({ id: 'shape:page-0', type: 'image', props: {
      w: 80, h: 50, crop: { x: .25, y: .3, w: .5, h: .4 }, excalidrawScale: [-1, 1],
    } }), { ignoreShapeLock: true })
    const page = worksheetPages(editor)[0], options = worksheetOverlayOptions(editor, page)
    const world = editor.getShapePageTransform('shape:page-0')
    const combined = (options.sceneTransform as Matrix2d).clone().multiply(world)
    expect(combined.applyToPoint({ x: 0, y: 0 }).x).toBeCloseTo(160 * PX_PER_PT * .75)
    expect(combined.applyToPoint({ x: 80, y: 50 }).x).toBeCloseTo(160 * PX_PER_PT * .25)
    expect(combined.applyToPoint({ x: 80, y: 50 }).y).toBeCloseTo(100 * PX_PER_PT * .7)
    expect(options.clip?.w).toBeCloseTo(160 * PX_PER_PT * .5)
  })

  it('exports legacy notebook rasters as ordered pages of their original dimensions', async () => {
    const editor = await board(await source([0, 90]), { stored: false })
    const result = await buildWorksheetPdf(editor)
    const pdf = await PDFDocument.load(result.bytes)
    expect(result).toMatchObject({ pages: 2, rasterizedPages: 2 })
    expect(pdf.getPage(0).getSize()).toEqual({ width: 160, height: 100 })
    expect(pdf.getPage(1).getSize()).toEqual({ width: 100, height: 160 })
  })

  it('does not silently omit missing pages when neither the original nor its image exists', async () => {
    const editor = await board(await source([0, 90]), { stored: false })
    editor.run(() => editor.deleteShapes(['shape:page-0']), { ignoreShapeLock: true })
    await expect(buildWorksheetPdf(editor)).rejects.toThrow('Some original worksheet pages are missing')
  })

  it('excludes page images nested in groups from every annotation layer', async () => {
    const editor = await board(await source([0]))
    editor.createShape({ id: 'shape:answer', type: 'geo', parentId: 'shape:group-0', props: { w: 50, h: 50 } })
    expect(worksheetAnnotationIds(editor, worksheetPages(editor)[0])).toEqual(['shape:answer'])
  })

  it('combines documents in import order and can export only the active worksheet', async () => {
    const editor = await board(await source([0, 90]))
    const second = await source([180]), key = await putPdfSource(second)
    editor.createShape({ id: 'shape:second', type: 'image', x: 3000, isLocked: true,
      props: { assetId: 'asset:page', w: 160 * PX_PER_PT, h: 100 * PX_PER_PT },
      meta: { pdf: { doc: 'second', name: 'Other homework', page: 1, pages: 1, width: 160, height: 100, at: 2, source: key, text: '' } } })
    const all = await PDFDocument.load((await buildWorksheetPdf(editor)).bytes)
    expect(all.getPages().map(page => page.getRotation().angle)).toEqual([0, 90, 180])
    const only = await PDFDocument.load((await buildWorksheetPdf(editor, { docId: 'second' })).bytes)
    expect(only.getPageCount()).toBe(1)
    expect(only.getPage(0).getRotation().angle).toBe(180)
  })

  it('rejects ambiguous duplicated pages instead of dropping either annotation layer', async () => {
    const editor = await board(await source())
    const shape = editor.getShape('shape:page-0')!
    editor.createShape({ ...shape, id: 'shape:duplicate', x: 3000 })
    await expect(buildWorksheetPdf(editor)).rejects.toThrow('duplicate page numbers')
  })
})

describe('portable original PDFs', () => {
  it('includes each PDF once in editable backups and restores bytes and document mode', async () => {
    const bytes = await source([0, 90]), editor = await board(bytes)
    const blob = await portableProjectFileBlob(editor, { ...DEFAULT_SETTINGS, mode: 'document' })
    const parsed = parseProjectFile(await blob.text()), key = await pdfKey(bytes)
    expect(Object.keys(parsed.pdfSources!)).toEqual([key])
    expect(Buffer.from(parsed.pdfSources![key], 'base64')).toEqual(Buffer.from(bytes))
    const restored = new Editor()
    const settings = await loadProject(restored, new File([blob], 'review.marginalia.json'))
    expect(settings.mode).toBe('document')
    expect(worksheetPages(restored)).toHaveLength(2)
    expect((await buildWorksheetPdf(restored)).rasterizedPages).toBe(0)
  })

  it('rejects a corrupted original before changing the active board', async () => {
    const editor = await board(await source())
    const file = JSON.parse(await (await portableProjectFileBlob(editor, DEFAULT_SETTINGS)).text())
    const key = Object.keys(file.pdfSources)[0]
    file.pdfSources[key] = Buffer.from('%PDF-1.7 damaged original').toString('base64')
    const prior = new Editor(); prior.createShape({ id: 'shape:keep', type: 'geo', props: { w: 10, h: 10 } })
    await expect(loadProject(prior, new File([JSON.stringify(file)], 'broken.json'))).rejects.toThrow('damaged')
    expect(prior.getShape('shape:keep')).toBeDefined()
  })
})
