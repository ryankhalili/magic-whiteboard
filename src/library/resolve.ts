import { findPageIndex } from './labels'
import { rankItems } from './rank'
import { renderCrop, renderPage } from './render'
import { buildCandidates, kindName, pageCandidate, pickBook, titleMatch } from './search'
import { getAnchors, getPage, getPages, listBooks } from './store'
import type { Anchor, BookRecord, Candidate, LibraryMatch, LibraryQuery, PageRecord, RankedCandidate, RenderedImage } from './types'

type BookData = { pages: PageRecord[]; anchors: Anchor[] }
const loaded = new Map<string, Promise<BookData>>()

/** Pages and items of a book, kept for the last two books asked about. */
function bookData(bookId: string): Promise<BookData> {
  let data = loaded.get(bookId)
  if (data) { loaded.delete(bookId); loaded.set(bookId, data); return data }
  data = Promise.all([getPages(bookId), getAnchors(bookId)]).then(([pages, anchors]) => ({ pages, anchors }))
  data.catch(() => loaded.delete(bookId))
  loaded.set(bookId, data)
  while (loaded.size > 2) loaded.delete(loaded.keys().next().value as string)
  return data
}

export function forgetBookData(bookId?: string) {
  if (bookId) loaded.delete(bookId)
  else loaded.clear()
}

async function chooseBook(query: LibraryQuery, books: BookRecord[], openBookId: string | null): Promise<BookRecord | { error: string; books?: BookRecord[] }> {
  const picked = pickBook(books, query.book, openBookId)
  if (picked.book) return picked.book
  const choices = picked.ambiguous.length ? picked.ambiguous : books
  const times = choices.map(book => book.openedAt || 0)
  const newest = Math.max(...times), oldest = Math.min(...times)
  const result = await rankItems({
    task: 'book', query: query.book ?? query.raw,
    items: choices.map(book => ({
      id: book.id, text: book.title,
      features: { titleMatch: query.book ? titleMatch(query.book, book.title) : 0, recent: newest > oldest ? ((book.openedAt || 0) - oldest) / (newest - oldest) : 1 },
    })),
  })
  const order = result.ranked.map(entry => choices.find(book => book.id === entry.id)).filter((book): book is BookRecord => !!book)
  if (result.confident && order[0]) return order[0]
  return { error: 'Which book? Say its title or open it from the Library.', books: order.length ? order : choices }
}

function itemName(query: Extract<LibraryQuery, { kind: 'item' }>) {
  return `${query.itemKind ? kindName(query.itemKind) : 'Problem'} ${query.label}`
}

/** Finds what the teacher asked for: an exact page, one sure item, or the top 3 to pick from. */
export async function matchLibrary(query: LibraryQuery, opts: { openBookId?: string | null } = {}): Promise<LibraryMatch | { error: string; books?: BookRecord[] }> {
  let books: BookRecord[]
  try { books = (await listBooks()).filter(book => book.indexed) }
  catch (error) { return { error: error instanceof Error ? error.message : 'The library could not be read.' } }
  if (!books.length) return { error: 'The library is empty. Import a textbook first.' }
  const chosen = await chooseBook(query, books, opts.openBookId ?? null)
  if ('error' in chosen) return chosen
  const book = chosen

  try {
    if (query.kind === 'page') {
      // a book without printed numbers is looked up by file page
      const labels = book.labels.some(label => label !== null) ? book.labels : Array.from({ length: book.pageCount }, (_, i) => String(i + 1))
      const index = findPageIndex(labels, query.label)
      if (index === null || index >= book.pageCount) return { error: `Page ${query.label} is not in ${book.title}.` }
      const page = await getPage(book.id, index).catch(() => null)
      const candidate = pageCandidate(book, index, page ?? undefined)
      return { query, book, ranked: [{ ...candidate, p: 1 }], confident: true, source: 'exact' }
    }

    const { pages, anchors } = await bookData(book.id)
    const candidates = buildCandidates(query, book, pages, anchors)
    if (!candidates.length) {
      return { error: query.kind === 'item' ? `${itemName(query)} is not in ${book.title}.` : `Nothing in ${book.title} matches that.` }
    }
    const exact = candidates.filter(candidate => candidate.features.exactLabel === 1)
    const strong = exact.filter(candidate => candidate.features.kindMatch === 1)
    // "example 3.12" names one thing; "3.2" alone must also be the only item with that number
    if (query.kind === 'item' && strong.length === 1 && (query.itemKind || exact.length === 1)) {
      return { query, book, ranked: [{ ...strong[0], p: 1 }], confident: true, source: 'exact' }
    }
    const result = await rankItems({
      task: 'library', query: query.raw,
      items: candidates.map(candidate => ({ id: candidate.id, text: candidate.description, features: candidate.features })),
    })
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
    const ranked: RankedCandidate[] = []
    for (const entry of result.ranked) {
      const candidate = byId.get(entry.id)
      if (candidate && ranked.length < 3) ranked.push({ ...candidate, p: entry.p })
    }
    if (!ranked.length) return { error: `Nothing in ${book.title} matches that.` }
    return { query, book, ranked, confident: result.confident, source: result.source }
  } catch (error) {
    return { error: error instanceof Error && error.message ? error.message : 'The library could not be searched.' }
  }
}

/** The image to put on the board: an exact crop of an item, or the whole page. */
export async function problemImage(c: Candidate): Promise<RenderedImage> {
  if (c.kind === 'item' && c.anchor) return renderCrop(c.bookId, c.pageIndex, c.anchor.box, { trim: true })
  return renderPage(c.bookId, c.pageIndex)
}
