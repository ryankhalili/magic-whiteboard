import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Editor } from './editor'
import { decodeLegacyInkPath, normalizeSnapshot } from './migration'
import type { TLShape } from './types'

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/legacy-canvas.json', import.meta.url), 'utf8'))

describe('owned canvas notebook migration', () => {
  it('preserves a real legacy export with four magic objects, locked homework, ink and camera', () => {
    const snapshot = normalizeSnapshot(fixture.snapshot)
    const shapes = Object.values(snapshot.document.store).filter(record => record.typeName === 'shape') as TLShape[]
    expect(shapes).toHaveLength(6)
    expect(shapes.filter(shape => shape.type === 'magic')).toHaveLength(4)
    expect(shapes.find(shape => shape.type === 'image')?.isLocked).toBe(true)
    const ink = shapes.find(shape => shape.type === 'draw')!
    if (ink.type !== 'draw') throw new Error('Missing ink')
    expect(ink.props.points).toHaveLength(9)
    expect(ink.props.points[8]).toEqual({ x: 206.75, y: 97.28125, z: 0.5 })
    expect(snapshot.session?.camera).toEqual(fixture.snapshot.session.pageStates[0].camera)
    expect(new Editor(snapshot).getCurrentPageShapes()).toHaveLength(6)
    expect(normalizeSnapshot(snapshot)).toEqual(snapshot)
  })

  it('reads pressure deltas and rejects malformed or non-finite encoded strokes', () => {
    const bytes = new Uint8Array(18), view = new DataView(bytes.buffer)
    view.setFloat32(0, 10, true); view.setFloat32(4, 20, true); view.setFloat32(8, 0.5, true)
    view.setUint16(12, 0x3c00, true); view.setUint16(14, 0xc000, true); view.setUint16(16, 0x3400, true)
    expect(decodeLegacyInkPath(btoa(String.fromCharCode(...bytes)), 3)).toEqual([{ x: 10, y: 20, z: 0.5 }, { x: 11, y: 18, z: 0.75 }])
    expect(() => decodeLegacyInkPath('invalid%')).toThrow('invalid encoded ink')
    expect(() => decodeLegacyInkPath('AAAA', 2)).toThrow('truncated')
    view.setFloat32(0, Infinity, true)
    expect(() => decodeLegacyInkPath(btoa(String.fromCharCode(...bytes)), 3)).toThrow('invalid object position')
  })

  it('rejects unsupported records without replacing an already populated editor', () => {
    const editor = new Editor(fixture.snapshot)
    const before = editor.getSnapshot()
    const damaged = structuredClone(fixture.snapshot)
    damaged.document.store['shape:bad'] = { id: 'shape:bad', typeName: 'shape', type: 'embed' }
    expect(() => editor.loadSnapshot(damaged)).toThrow('unsupported')
    expect(editor.getSnapshot()).toEqual(before)
  })

  it('rejects cyclic groups before transform traversal', () => {
    const group = (id: string, parentId: string) => ({ id, typeName: 'shape', type: 'group', parentId, props: {} })
    expect(() => normalizeSnapshot({ document: { store: { a: group('a', 'b'), b: group('b', 'a') } } })).toThrow('circular')
  })

  it('round-trips tall graph ranges used by exponential plots', () => {
    const editor = new Editor()
    editor.createShape({ type: 'magic', props: { kind: 'plot', expression: 'exp(x)', xMin: 0, xMax: 20, yMin: -1e8, yMax: 8e8 } })
    expect(() => new Editor(editor.getSnapshot())).not.toThrow()
  })

  it('counts shared ink segment samples once when reloading an owned snapshot', () => {
    const point = { x: 0, y: 0, z: 0.5 }
    const samples = Array.from({ length: 500_001 }, () => point)
    const raw = { document: { store: { ink: { id: 'ink', typeName: 'shape', type: 'draw', props: { points: samples, segments: [{ type: 'free', points: samples }] } } } } }
    const normalized = normalizeSnapshot(raw)
    expect((normalized.document.store.ink as TLShape<'draw'>).props.points).toHaveLength(500_001)
  })

  it('keeps point-only ink when its optional segment list is empty', () => {
    const raw = { document: { store: { ink: { id: 'ink', typeName: 'shape', type: 'draw', props: { points: [{ x: 12, y: 24 }], segments: [] } } } } }
    expect((normalizeSnapshot(raw).document.store.ink as TLShape<'draw'>).props.points).toEqual([{ x: 12, y: 24, z: 0.5 }])
  })

  it('blocks unsupported image treatments instead of silently changing their appearance', () => {
    const raw = structuredClone(fixture.snapshot)
    const image = Object.values(raw.document.store).find((record: any) => record.typeName === 'shape' && record.type === 'image') as any
    image.props.flipX = true
    expect(() => normalizeSnapshot(raw)).toThrow('cropped or flipped')
  })
})
