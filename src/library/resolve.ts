import { needsReindex } from './indexer'
import { findPageIndex } from './labels'
import { rankItems } from './rank'
import { renderAnchor, renderPage } from './render'
import { buildCandidates, certainItem, kindName, pageCandidate, pageSections, pickBook, titleMatch } from './search'
import { getAnchors, getPage, getPages, listBooks } from './store'
import type { Anchor, BookRecord, Candidate, LibraryMatch, LibraryQuery, PageRecord, RankedCandidate, RenderedImage } from './types'

type BookData = { pages: PageRecord[]; anchors: Anchor[] }
const loaded = new Map<string, { version: number; data: Promise<BookData> }>()

/** Pages and items of a book, kept for the last two books asked about (read again after a re index). */
function bookData(book: BookRecord): Promise<BookData> {
  const version = book.indexVersion ?? 1
  const kept = loaded.get(book.id)
  loaded.delete(book.id)
  if (kept && kept.version === version) { loaded.set(book.id, kept); return kept.data }
  const data = Promise.all([getPages(book.id), getAnchors(book.id)]).then(([pages, anchors]) => ({ pages, anchors }))
  data.catch(() => { if (loaded.get(book.id)?.data === data) loaded.delete(book.id) })
  loaded.set(book.id, { version, data })
  while (loaded.size > 2) loaded.delete(loaded.keys().next().value as string)
  return data
}

export function forgetBookData(bookId?: string) {
  if (bookId) loaded.delete(bookId)
  else loaded.clear()
}

/** Told to the ranker with every library lookup. */
export const LIBRARY_CONTEXT = 'A teacher wants one textbook item on the whiteboard to solve live in class. Checkpoints, exercises, problems and questions are practice problems; examples are worked problems; sections, theorems, definitions and figures are not problems.'

export type LibraryError = { error: string; books?: BookRecord[]; code?: 'reindex'; bookId?: string }

async function chooseBook(query: LibraryQuery, books: BookRecord[], openBookId: string | null): Promise<BookRecord | LibraryError> {
  const hint = query.book?.trim()
  // a named book that is not here is never swapped for another one
  if (hint && !books.some(book => Math.max(titleMatch(hint, book.title), titleMatch(hint, book.fileName ?? '')) >= .5)) {
    return { error: `No book called "${hint.slice(0, 60)}" in your library.`, books }
  }
  const picked = pickBook(books, hint, openBookId)
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

/** The ranker's context: what the teacher is doing and where in the book they are. */
function rankContext(book: BookRecord, anchors: Anchor[], near: number | null): string {
  if (near === null) return LIBRARY_CONTEXT
  const section = pageSections(anchors, Math.max(book.pageCount, near + 1))[near]
  const label = book.labels?.[near]
  const page = label ? `page ${label}` : `file page ${near + 1}`
  if (!section) return `${LIBRARY_CONTEXT} The teacher is currently working on ${page}.`
  // naming only the chapter works best: with the section too, the ranker looks for that section and answers none
  const chapter = section.split('.')[0]
  return `${LIBRARY_CONTEXT} The teacher is currently working in chapter ${chapter}, on ${page}. When the same number is in several chapters, the teacher means the one in chapter ${chapter}.`
}

/**
 * Finds what the teacher asked for: an exact page, one sure item, or the top 3 to pick from.
 * near is the page the teacher is on (reference panel page, else the last insert), so repeated numbers prefer that chapter.
 */
export async function matchLibrary(query: LibraryQuery, opts: { openBookId?: string | null; near?: { bookId: string; pageIndex: number } | null } = {}): Promise<LibraryMatch | LibraryError> {
  let books: BookRecord[]
  try { books = await listBooks() }
  catch (error) { return { error: error instanceof Error ? error.message : 'The library could not be read.' } }
  if (!books.length) return { error: 'The library is empty. Import a textbook first.' }
  const chosen = await chooseBook(query, books, opts.openBookId ?? null)
  if ('error' in chosen) return chosen
  const book = chosen
  // an unfinished import or an older index is read again first; printed pages from an older index are still right
  if (!book.indexed || (query.kind !== 'page' && needsReindex(book))) {
    return { error: 'This book needs a quick update. Opening it now.', code: 'reindex', bookId: book.id }
  }

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

    const { pages, anchors } = await bookData(book)
    const at = opts.near && opts.near.bookId === book.id && Number.isInteger(opts.near.pageIndex) && opts.near.pageIndex >= 0 && opts.near.pageIndex < book.pageCount ? opts.near.pageIndex : null
    const candidates = buildCandidates(query, book, pages, anchors, 40, at)
    if (!candidates.length) {
      return { error: query.kind === 'item' ? `${itemName(query)} is not in ${book.title}.` : `Nothing in ${book.title} matches that.` }
    }
    const sure = certainItem(query, candidates)
    if (sure) return { query, book, ranked: [{ ...sure, p: 1 }], confident: true, source: 'exact' }
    const result = await rankItems({
      task: 'library', query: query.raw, context: rankContext(book, anchors, at),
      items: candidates.map(candidate => ({ id: candidate.id, text: candidate.description, features: candidate.features })),
    })
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
    const ranked: RankedCandidate[] = []
    for (const entry of result.ranked) {
      const candidate = byId.get(entry.id)
      if (candidate && ranked.length < 3) ranked.push({ ...candidate, p: entry.p })
    }
    if (!ranked.length) return { error: `Nothing in ${book.title} matches that.` }
    // a numbered item is only inserted without asking when it is certain; the ranker just orders the choices
    return { query, book, ranked, confident: query.kind === 'topic' && result.confident, source: result.source }
  } catch (error) {
    return { error: error instanceof Error && error.message ? error.message : 'The library could not be searched.' }
  }
}

/** The image to put on the board: an exact crop of an item, or the whole page. */
export async function problemImage(c: Candidate): Promise<RenderedImage> {
  if (c.kind === 'item' && c.anchor) return renderAnchor(c.bookId, c.anchor)
  return renderPage(c.bookId, c.pageIndex)
}
