import type { AssetRecord, TLEditorSnapshot, TLImageShape } from '../canvas/types'
import { getAnchors, getBook } from './store'
import { renderAnchor, renderPage } from './render'

/** Restore missing PDF-backed assets without discarding notebook objects or fetching external URLs. */
export async function restoreMissingLibraryAssets(snapshot: TLEditorSnapshot): Promise<TLEditorSnapshot> {
  const store = snapshot.document?.store
  if (!store) return snapshot
  const missing = Object.values(store).filter((record): record is TLImageShape => record.typeName === 'shape' && record.type === 'image'
    && typeof (record as TLImageShape).props?.assetId === 'string' && !store[(record as TLImageShape).props.assetId!])
  if (!missing.length) return snapshot
  const restored = structuredClone(snapshot)
  for (const shape of missing) {
    const source = shape.meta?.library as { bookId?: string; pageIndex?: number; anchorId?: string } | undefined
    if (!source?.bookId || !Number.isInteger(source.pageIndex)) continue
    const book = await getBook(source.bookId)
    if (!book) continue // Normal validation reports the missing source; never erase it.
    const anchor = source.anchorId ? (await getAnchors(book.id)).find(a => a.id === source.anchorId) : undefined
    if (source.anchorId && !anchor) throw new Error('The source excerpt must be reindexed before this missing image can be restored.')
    const image = anchor ? await renderAnchor(book.id, anchor) : await renderPage(book.id, source.pageIndex!)
    const id = shape.props.assetId!
    restored.document.store[id] = { id, typeName: 'asset', type: 'image', meta: {}, props: { ...image, name: 'Restored PDF excerpt', isAnimated: false } } satisfies AssetRecord
  }
  return restored
}
