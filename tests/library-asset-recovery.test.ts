import { describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/canvas/editor'
import { restoreMissingLibraryAssets } from '../src/library/restoreAssets'
import { renderAnchor } from '../src/library/render'
const image = { src: 'data:image/png;base64,AAAA', w: 400, h: 200, mimeType: 'image/png' }
vi.mock('../src/library/store', () => ({ getBook: vi.fn(async () => ({ id: 'book' })), getAnchors: vi.fn(async () => [{ id: 'anchor' }]) }))
vi.mock('../src/library/render', () => ({ renderAnchor: vi.fn(async () => image), renderPage: vi.fn(async () => image) }))
describe('missing PDF asset recovery', () => {
  it('restores the source asset without changing object identity, geometry, or other notebook content', async () => {
    const editor = new Editor()
    const snapshot = editor.getSnapshot()
    snapshot.document.store['shape:excerpt'] = { id: 'shape:excerpt', typeName: 'shape', type: 'image', parentId: editor.getCurrentPageId(), index: 1, x: 10, y: 20, rotation: 0, opacity: 1, isLocked: false, props: { w: 600, h: 300, assetId: 'asset:lost' }, meta: { library: { bookId: 'book', pageIndex: 10, anchorId: 'anchor' } } }
    const restored = await restoreMissingLibraryAssets(snapshot)
    expect(snapshot.document.store['asset:lost']).toBeUndefined()
    expect(restored.document.store['shape:excerpt']).toEqual(snapshot.document.store['shape:excerpt'])
    expect(renderAnchor).toHaveBeenCalledWith('book', { id: 'anchor' })
    expect(restored.document.store['asset:lost']).toMatchObject({ typeName: 'asset', props: image })
    expect(() => editor.loadSnapshot(restored)).not.toThrow()
    expect(await restoreMissingLibraryAssets(restored)).toBe(restored)
  })
})
