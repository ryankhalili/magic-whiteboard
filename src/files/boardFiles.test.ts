import { describe, expect, it } from 'vitest'
import { Box, type Editor } from 'tldraw'
import { DEFAULT_SETTINGS } from '../../shared/board'
import { getExportBounds, parseProjectFile } from './boardFiles'

function project(records: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'marginalia', version: 1, settings,
    snapshot: { document: { schema: {}, store: records }, session: {} },
  })
}

describe('project file validation', () => {
  it('rejects arbitrary JSON and out-of-range shape positions', () => {
    expect(() => parseProjectFile('{}')).toThrow('not a supported')
    expect(() => parseProjectFile(project({ a: { typeName: 'shape', type: 'geo', x: 1e20, y: 1, rotation: 0 } }))).toThrow('invalid object position')
  })

  it('rejects asset URLs and active embedded content before replacing the current board', () => {
    expect(() => parseProjectFile(project({ asset: { typeName: 'asset', type: 'image', props: { src: 'https://example.com/image.png' } } }))).toThrow('unsupported external asset')
    expect(() => parseProjectFile(project({ shape: { typeName: 'shape', type: 'embed', x: 0, y: 0, rotation: 0 } }))).toThrow('unsupported online content')
  })

  it('keeps embedded raster assets and normalizes only safe application settings', () => {
    const parsed = parseProjectFile(project(
      { asset: { typeName: 'asset', type: 'image', props: { src: 'data:image/png;base64,AA==' } } },
      { name: 'My homework', mode: 'page', paper: 'grid', backgroundColor: 'url(https://example.com)' },
    ))
    expect(parsed.settings).toEqual({ name: 'My homework', mode: 'page', paper: 'grid', backgroundColor: DEFAULT_SETTINGS.backgroundColor, focusMode: 'reference' })
  })

  it('preserves literal placement and defaults legacy or unknown placement modes to reference', () => {
    expect(parseProjectFile(project({}, { focusMode: 'literal' })).settings.focusMode).toBe('literal')
    expect(parseProjectFile(project()).settings.focusMode).toBe('reference')
    expect(parseProjectFile(project({}, { focusMode: 'stretch' })).settings.focusMode).toBe('reference')
  })
})

describe('export framing', () => {
  it('crops page mode to exactly one portrait A4 canvas independent of object positions', () => {
    const bounds = getExportBounds({} as Editor, { ...DEFAULT_SETTINGS, mode: 'page' })
    expect([bounds.x, bounds.y, bounds.w, bounds.h]).toEqual([0, 0, 794, 1123])
  })

  it('includes all shapes, including locked backgrounds, in an infinite export', () => {
    const objects = [{ id: 'image', isLocked: true }, { id: 'ink', isLocked: false }]
    const boxes: Record<string, Box> = { image: new Box(-100, -50, 500, 700), ink: new Box(600, 100, 40, 20) }
    const editor = { getCurrentPageShapes: () => objects, getShapePageBounds: (shape: { id: string }) => boxes[shape.id] } as unknown as Editor
    const bounds = getExportBounds(editor, DEFAULT_SETTINGS)
    expect([bounds.x, bounds.y, bounds.w, bounds.h]).toEqual([-132, -82, 804, 764])
  })
})
