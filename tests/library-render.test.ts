import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { bodyFontSize, detectAnchors, type OpenItem } from '../src/library/anchors'
import { pageLines, setPdfJsLoader } from '../src/library/pdfjs'
import { inkBounds, renderAnchor, shadedEnd } from '../src/library/render'
import { putBookBytes } from '../src/library/store'
import type { Anchor, PageBox, RenderedImage, TextLine } from '../src/library/types'

// pdf.js draws in node through its optional @napi-rs/canvas dependency; skip drawing where it is missing
const canvas = await import('@napi-rs/canvas').catch(() => null)
const realBook = `${process.cwd()}/.local/test-books/calculus-volume-1.pdf`

/** RGBA rows of one color each. */
function rows(width: number, colors: Array<[number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * colors.length * 4)
  colors.forEach((color, y) => { for (let x = 0; x < width; x++) data.set([...color, 255], (y * width + x) * 4) })
  return data
}
const repeat = <T,>(value: T, n: number): T[] => Array.from({ length: n }, () => value)
const WHITE: [number, number, number] = [255, 255, 255], TINT: [number, number, number] = [244, 247, 244], INK: [number, number, number] = [20, 20, 20]

describe('trimming helpers', () => {
  it('finds where a shaded box ends', () => {
    expect(shadedEnd(rows(20, [...repeat(WHITE, 10), ...repeat(TINT, 20), ...repeat(INK, 3), ...repeat(TINT, 27), ...repeat(WHITE, 10), ...repeat(INK, 20)]), 20, 90)).toBe(60)
    // a shaded title bar with one row of text over a white item is not a box when two rows are asked for
    const bar = rows(20, [...repeat(TINT, 5), ...repeat(INK, 3), ...repeat(TINT, 5), ...repeat(WHITE, 10), ...repeat(INK, 3), ...repeat(WHITE, 5), ...repeat(INK, 3)])
    expect(shadedEnd(bar, 20, 34, 2)).toBeNull()
    expect(shadedEnd(bar, 20, 34, 1)).toBe(13)
    expect(shadedEnd(rows(20, [...repeat(TINT, 40), ...repeat(INK, 3), ...repeat(TINT, 20)]), 20, 63)).toBeNull()
    expect(shadedEnd(rows(20, [...repeat(INK, 5), ...repeat(WHITE, 10), ...repeat(INK, 5)]), 20, 20)).toBeNull()
  })

  it('drops blank rows above the second part of a split item', () => {
    const data = rows(40, [...repeat(WHITE, 30), ...repeat(INK, 10), ...repeat(WHITE, 20)])
    expect(inkBounds(data, 40, 60, 12, true)).toEqual({ top: 24, w: 40, h: 28 })
    expect(inkBounds(data, 40, 60, 12).top).toBe(0)
  })
})

type Text = [text: string, x: number, top: number, size?: number]

/** Page 1: a shaded theorem box that runs off the foot. Page 2: its last line in the box, a black figure, then "Proof". Page 3: two cells. */
async function fixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const shade = rgb(244 / 255, 247 / 255, 244 / 255)
  const pages: Array<{ boxes: Array<[top: number, bottom: number, color: ReturnType<typeof rgb>]>; texts: Text[] }> = [
    { boxes: [[480, 760, shade]], texts: [['Theorem 9.9', 80, 490], ...Array.from({ length: 12 }, (_, i): Text => [`statement line ${i} of the theorem goes on`, 80, 520 + 18 * i])] },
    { boxes: [[40, 100, shade], [140, 240, rgb(0, 0, 0)]], texts: [['for every x, the last line.', 80, 60], ['Proof', 72, 270, 12], ['The proof is short.', 72, 290]] },
    { boxes: [], texts: [['57. Kept words of this cell', 72, 100], ['58. Neighbour text', 330, 100]] },
  ]
  for (const { boxes, texts } of pages) {
    const page = pdf.addPage([612, 792])
    for (const [top, bottom, color] of boxes) page.drawRectangle({ x: 45, y: 792 - bottom, width: 522, height: bottom - top, color })
    for (const [text, x, top, size = 10] of texts) page.drawText(text, { x, y: 792 - top - size * 0.8, size, font })
  }
  return pdf.save()
}

async function decode(image: RenderedImage) {
  const loaded = await canvas!.loadImage(Buffer.from(image.src.split(',')[1], 'base64'))
  const drawn = canvas!.createCanvas(loaded.width, loaded.height)
  drawn.getContext('2d').drawImage(loaded, 0, 0)
  return drawn.getContext('2d').getImageData(0, 0, loaded.width, loaded.height).data
}

/** Rows crossed by one long dark run: a filled black figure, never text. */
function solidRows(data: Uint8ClampedArray, width: number, height: number): number {
  let solid = 0
  for (let y = 0; y < height; y++) {
    let run = 0, longest = 0
    for (let x = 0; x < width; x++) { run = data[(y * width + x) * 4] < 80 ? run + 1 : 0; longest = Math.max(longest, run) }
    if (longest > width * 0.3) solid++
  }
  return solid
}

const box = (x: number, y: number, w: number, h: number): PageBox => ({ x, y, w, h })
const anchor = (pageIndex: number, area: PageBox, extra: Partial<Anchor> = {}): Anchor => ({
  id: `fixture#${pageIndex}:theorem:9.9`, bookId: 'fixture', pageIndex, kind: 'theorem', label: '9.9', heading: 'Theorem 9.9', box: area, snippet: '', ...extra,
})

describe.skipIf(!canvas)('renderAnchor', () => {
  beforeAll(async () => {
    setPdfJsLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs'), { standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` })
    vi.stubGlobal('document', { createElement: () => canvas!.createCanvas(1, 1) })
    await putBookBytes('fixture', await fixture())
  })
  afterAll(() => { vi.unstubAllGlobals() })

  const head = box(0.09, 470 / 792, 0.82, 0.95 - 470 / 792)

  it('stitches the rest of a split item under it at the same width, leaving out what follows its box', async () => {
    const alone = await renderAnchor('fixture', anchor(0, head))
    const stitched = await renderAnchor('fixture', anchor(0, head, { continues: { pageIndex: 1, box: box(0.09, 0.04, 0.82, 262 / 792 - 0.04) } }))
    expect(stitched.mimeType).toBe('image/png')
    expect(stitched.h).toBeGreaterThan(alone.h + 30)
    expect(stitched.w).toBe(alone.w)
    // the black figure under the shaded box on page 2 is not part of the theorem
    expect(solidRows(await decode(stitched), stitched.w, stitched.h)).toBe(0)
  })

  it('does not stitch a plain region under a shaded item, or a blank one', async () => {
    const alone = await renderAnchor('fixture', anchor(0, head))
    const plain = await renderAnchor('fixture', anchor(0, head, { continues: { pageIndex: 1, box: box(0.09, 262 / 792, 0.82, 0.05) } }))
    expect(plain.h).toBe(alone.h)
    const blank = await renderAnchor('fixture', anchor(0, head, { continues: { pageIndex: 1, box: box(0.09, 0.4, 0.82, 0.1) } }))
    expect(blank.h).toBe(alone.h)
    // a page that is not in the book is ignored
    const missing = await renderAnchor('fixture', anchor(0, head, { continues: { pageIndex: 9, box: box(0.09, 0.1, 0.82, 0.1) } }))
    expect(missing.h).toBe(alone.h)
  })

  it('paints out a neighbour inside the crop', async () => {
    const area = box(0.1, 95 / 792, 0.8, 0.03)
    const plain = await renderAnchor('fixture', anchor(2, area, { kind: 'exercise', label: '57' }))
    const masked = await renderAnchor('fixture', anchor(2, area, { kind: 'exercise', label: '57', mask: [box(0.53, 95 / 792, 0.37, 0.03)] }))
    // the neighbour's words were the right end of the ink, so the crop is trimmed much narrower
    expect(masked.w).toBeLessThan(plain.w * 0.75)
    expect(masked.h).toBe(plain.h)
  })

  it.skipIf(!existsSync(realBook))('draws the real book’s split theorem as one image and grid cells without their neighbours', async () => {
    const bytes = new Uint8Array(readFileSync(realBook))
    await putBookBytes('calc', bytes)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise
    const lines: TextLine[][] = []
    for (const index of [205, 206, 226, 227]) {
      const page = await doc.getPage(index + 1)
      lines[index] = (await pageLines(page)).lines
      page.cleanup()
    }
    await doc.loadingTask.destroy()
    const body = bodyFontSize([...lines[226], ...lines[227]])
    const first = detectAnchors('calc', { index: 226, lines: lines[226], exerciseMode: false }, body)
    const next = detectAnchors('calc', { index: 227, lines: lines[227], exerciseMode: false, carry: first.open as OpenItem[] }, body)
    const theorem = first.anchors.find(item => item.kind === 'theorem' && item.label === '3.4')!
    theorem.continues = next.continued.find(entry => entry.id === theorem.id)?.continues
    expect(theorem.continues?.pageIndex).toBe(227)
    const alone = await renderAnchor('calc', { ...theorem, continues: undefined })
    const stitched = await renderAnchor('calc', theorem)
    // the constant multiple rule's formula from the next page sits under the first part
    expect(stitched.h).toBeGreaterThan(alone.h + 40)
    expect(stitched.w).toBe(alone.w)

    const grid = detectAnchors('calc', { index: 206, lines: lines[206], exerciseMode: detectAnchors('calc', { index: 205, lines: lines[205], exerciseMode: false }, body).exerciseMode }, body)
    const six = grid.anchors.find(item => item.kind === 'exercise' && item.label === '6')!
    const image = await renderAnchor('calc', six)
    // one row of the grid, not the eight rows under it it used to take in
    expect(image.h).toBeLessThan(120)
    expect(image.h).toBeGreaterThan(30)
  }, 120_000)
})
