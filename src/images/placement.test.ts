import { describe, expect, it, vi } from 'vitest'
import { imagePlacement, imagePlacementArea } from './placement'
import { insertGeneratedImage } from './insertGeneratedImage'
import { Editor } from '../canvas/editor'
import { normalizeSnapshot } from '../canvas/migration'
import type { BoardContext, BoardObject, Bounds } from '../../shared/board'
import { generatedPng } from '../../tests/fixtures/generated-image'

const context: BoardContext = { focus: { kind: 'region', bounds: { x: 100, y: 200, w: 20, h: 300 }, targetIds: [] }, focusMode: 'reference', pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
describe('confirmed image placement and persistence', () => {
  it('uses a skinny reference cue as a location without distorting the image', () => {
    const b = imagePlacement(context, { type: 'propose_image' }, '1536x1024')
    expect(b.w / b.h).toBeCloseTo(1.5)
    expect(b.x + b.w / 2).toBe(110)
    expect(b.w).toBe(560)
  })
  it('keeps a new image clear of textbook pages, problems and other content when nothing is pointed at', () => {
    const view = { x: 0, y: 0, w: 1440, h: 900 }
    const objects: BoardObject[] = [
      { id: 'shape:page', kind: 'textbook_page', bounds: { x: 100, y: 40, w: 560, h: 725 }, rotation: 0, locked: true },
      { id: 'shape:problem', kind: 'textbook_item', bounds: { x: 700, y: 600, w: 400, h: 100 }, rotation: 0, workBelow: 260 },
    ]
    const free = { ...context, focus: null, viewport: view, objects }
    const area = imagePlacementArea(free, { type: 'propose_image' })
    const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const object of objects) expect(overlaps(area, { ...object.bounds, h: object.bounds.h + (object.workBelow ?? 0) })).toBe(false)
    expect(area.x >= view.x && area.y >= view.y && area.x + area.w <= view.x + view.w && area.y + area.h <= view.y + view.h).toBe(true)
    // the old view center sits on the textbook page
    expect(overlaps({ x: 440, y: 230, w: 560, h: 440 }, objects[0].bounds)).toBe(true)
    // a pointed spot still wins
    expect(imagePlacement({ ...free, focus: context.focus }, { type: 'propose_image' }, '1536x1024').x + 280).toBe(110)
    // a crowded view gets a smaller free area before falling back to the center
    const crowded = { ...free, objects: [...objects, { id: 'shape:graph', kind: 'plot', bounds: { x: 700, y: 60, w: 400, h: 300 } }] as BoardObject[] }
    const small = imagePlacementArea(crowded, { type: 'propose_image' })
    expect(small.w).toBeLessThan(560)
    for (const object of crowded.objects) expect(overlaps(small, { ...object.bounds, h: object.bounds.h + (object.workBelow ?? 0) })).toBe(false)
    // a full view falls back to its center
    const full = { ...free, objects: [{ id: 'shape:sheet', kind: 'pdf_page', bounds: { x: -10, y: -10, w: 1460, h: 920 } }] as BoardObject[] }
    expect(imagePlacementArea(full, { type: 'propose_image' })).toEqual({ x: 440, y: 230, w: 560, h: 440 })
  })
  it('fits a literal region and rejects missing or escaping bounds', () => {
    const literal = { ...context, focusMode: 'literal' as const, focus: { ...context.focus!, bounds: { x: 100, y: 200, w: 300, h: 300 } } }
    expect(imagePlacement(literal, { type: 'propose_image' }, '1536x1024')).toEqual({ x: 100, y: 250, w: 300, h: 200 })
    expect(() => imagePlacement({ ...literal, focus: null }, { type: 'propose_image' }, '1024x1024')).toThrow('Circle')
    expect(() => imagePlacement(literal, { type: 'propose_image', bounds: { x: 0, y: 0, w: 300, h: 300 } }, '1024x1024')).toThrow('inside')
  })
  it('inserts a completed job once, preserves source through reload, and permits normal Undo', () => {
    const editor = new Editor()
    const image = generatedPng()
    const bounds = { x: 50, y: 80, w: 200, h: 200 }
    const id = insertGeneratedImage(editor, 'job-one-1', image, bounds, 'A leaf cross-section')
    expect(insertGeneratedImage(editor, 'job-one-1', image, bounds, 'A leaf')).toBe(id)
    expect(editor.getCurrentPageShapes()).toHaveLength(1)
    const restored = new Editor(); restored.loadSnapshot(normalizeSnapshot(editor.getSnapshot()))
    expect(insertGeneratedImage(restored, 'job-one-1', image, bounds, 'A leaf')).toBe(id)
    expect(restored.getCurrentPageShapes()).toHaveLength(1)
    editor.undo(); expect(editor.getCurrentPageShapes()).toHaveLength(0)
    editor.redo(); expect(editor.getCurrentPageShapes()).toHaveLength(1)
  })
  it('rejects forged PNGs, mismatched dimensions and out-of-range placement without leaving assets', () => {
    const editor = new Editor(), bounds = { x: 0, y: 0, w: 200, h: 200 }, before = editor.getSnapshot()
    for (const image of [{ dataUrl: 'data:image/png;base64,AA==', width: 1024, height: 1024 }, { ...generatedPng(), width: 1536 }]) {
      expect(() => insertGeneratedImage(editor, 'job-one-1', image, bounds, '')).toThrow('could not be read')
      expect(editor.getSnapshot()).toEqual(before)
    }
    expect(() => insertGeneratedImage(editor, 'job-one-1', generatedPng(), { ...bounds, x: 1e12 }, '')).toThrow('placement')
    expect(editor.getSnapshot()).toEqual(before)
  })
  it('refuses additions beyond the portable record limit before mutating the editor', () => {
    const editor = new Editor(), image = generatedPng()
    const snapshot = editor.getSnapshot()
    snapshot.document.store = Object.fromEntries(Array.from({ length: 19999 }, (_, index) => [`page:fixture-${index}`, { id: `page:fixture-${index}`, typeName: 'page', name: 'Fixture', meta: {} }]))
    vi.spyOn(editor, 'getSnapshot').mockReturnValue(snapshot)
    const before = editor.store.allRecords()
    expect(() => insertGeneratedImage(editor, 'job-one-1', image, { x: 0, y: 0, w: 200, h: 200 }, '')).toThrow('too large')
    expect(editor.store.allRecords()).toEqual(before)
  })
})
