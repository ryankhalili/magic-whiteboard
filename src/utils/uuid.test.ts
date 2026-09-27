import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssetId, createShapeId, Editor } from '../canvas/editor'
import { NotebookRepository, parseNotebookManifest, NOTEBOOK_STORAGE_KEY } from '../notebooks/library'
import { uuid } from './uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('local record IDs', () => {
  it('uses native UUIDs and preserves supplied shape and asset suffixes', () => {
    const id = '01234567-89ab-4cde-8123-456789abcdef'
    const randomUUID = vi.fn(() => id)
    vi.stubGlobal('crypto', { randomUUID })
    expect(uuid()).toBe(id)
    expect(createShapeId()).toBe(`shape:${id}`)
    expect(createAssetId()).toBe(`asset:${id}`)
    randomUUID.mockClear()
    expect(createShapeId('existing')).toBe('shape:existing')
    expect(createAssetId('image')).toBe('asset:image')
    expect(createShapeId('')).toBe('shape:')
    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('creates distinct board and notebook records on HTTP using getRandomValues', () => {
    let seed = 0
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(++seed); return bytes })
    vi.stubGlobal('crypto', { getRandomValues })
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Weak randomness must not replace getRandomValues') })
    const editor = new Editor()
    editor.createShapes([{ type: 'magic' }, { type: 'text', props: { text: 'Another object' } }])
    const assetId = createAssetId()
    const shapes = editor.getCurrentPageShapes()
    expect(shapes).toHaveLength(2)
    expect(new Set(shapes.map(shape => shape.id)).size).toBe(2)
    for (const id of [...shapes.map(shape => shape.id), assetId]) expect(id.split(':')[1]).toMatch(UUID_V4)

    const saved = new Map<string, string>()
    const repository = new NotebookRepository({ getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) } })
    const notebookId = repository.createNotebook('LAN notebook')
    expect(notebookId).toMatch(UUID_V4)
    expect(parseNotebookManifest(saved.get(NOTEBOOK_STORAGE_KEY)!)?.activeNotebookId).toBe(notebookId)
    expect(getRandomValues).toHaveBeenCalledTimes(4)
  })

  it('keeps local canvas creation available when crypto itself is absent', () => {
    vi.stubGlobal('crypto', undefined)
    let value = 0
    vi.spyOn(Math, 'random').mockImplementation(() => (++value % 256) / 256)
    const editor = new Editor()
    editor.createShapes([{ type: 'magic' }, { type: 'magic' }])
    const ids = editor.getCurrentPageShapes().map(shape => shape.id)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id.slice('shape:'.length)).toMatch(UUID_V4)
  })
})
