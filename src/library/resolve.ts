import { needsReindex } from './indexer'
import { findPageIndexes } from './labels'
import { rankItems } from './rank'
import { renderAnchor, renderPage } from './render'
import { buildCandidates, certainItem, certainTopic, isHerePage, isStructureQuery, kindName, pageCandidate, pageSections, pickBook, subjectBooks, titleMatch } from './search'
import { isContentsPage } from './structure'
import { getBookGuideContext, guidePageScopes } from './guide'
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
  const exact = books.find(book => book.id === hint)
  if (exact) return exact
  if (hint && !books.some(book => Math.max(titleMatch(hint, book.title), titleMatch(hint, book.fileName ?? '')) >= .5)) {
    // A subject alone must identify one book; otherwise ask.
    const subject = subjectBooks(hint, books)
    if (subject?.length === 1) return subject[0]
    if (subject) return { error: 'Which book? Say its title or open it from the Library.', books: subject }
    // a named book that is not here is never swapped for another one
    return { error: `Which textbook do you mean by "${hint.slice(0, 60)}"? Choose one below.`, books }
  }
  const picked = pickBook(books, hint, openBookId)
  if (picked.book) return picked.book
  return { error: 'Which textbook do you mean? Choose one below.', books: picked.ambiguous.length ? picked.ambiguous : books }
}

function itemName(query: Extract<LibraryQuery, { kind: 'item' }>) {
  return `${query.itemKind ? kindName(query.itemKind) : 'Problem'} ${query.label}`
}

/**
 * "exercise 48 in section 3.9" when that section (or chapter) is in the book but has no such item: says so
 * instead of offering the ones in other chapters. null when something in scope fits or the book shows no sections.
 */
function scopeMiss(query: LibraryQuery, book: BookRecord, anchors: Anchor[], candidates: Candidate[]): string | null {
  if (query.kind !== 'item' || !(query.section || query.chapter)) return null
  if (candidates.some(candidate => candidate.features.inSection === 1)) return null
  const guideScopes = guidePageScopes(book, book.pageCount)
  const sections = pageSections(anchors, book.pageCount).map((section, index) => guideScopes.sections[index]
    ?? (guideScopes.chapters[index] !== null && section && Number(section.split('.')[0]) !== guideScopes.chapters[index] ? null : section))
  // the last exercises of a section can sit on the page where the next section starts
  const inScope = (section: string | null | undefined) => !!section && (query.section ? section === query.section : Number(section.split('.')[0]) === Number(query.chapter))
  if (candidates.some(candidate => candidate.features.exactLabel === 1 && inScope(sections[candidate.pageIndex - 1]))) return null
  const known = query.section ? sections.includes(query.section) : sections.some(section => section !== null && Number(section.split('.')[0]) === Number(query.chapter)) || guideScopes.chapters.includes(Number(query.chapter))
  if (!known) return null
  return `The local index did not identify ${itemName(query).toLowerCase()} in ${query.section ? `section ${query.section}` : `chapter ${query.chapter}`}. Try its printed number or page, or open the chapter and crop it visually.`
}

/** The ranker's context: what the teacher is doing and where in the book they are. */
function rankContext(book: BookRecord, anchors: Anchor[], near: number | null): string {
  const guide = getBookGuideContext(book, near).slice(0, 1200)
  const context = `${LIBRARY_CONTEXT}\nBook structure (source data):\n${guide}`
  if (near === null) return context
  const section = pageSections(anchors, Math.max(book.pageCount, near + 1))[near]
  const label = book.labels?.[near]
  const page = label ? `page ${label}` : `file page ${near + 1}`
  if (!section) return `${context}\nThe teacher is currently working on ${page}.`
  // naming only the chapter works best: with the section too, the ranker looks for that section and answers none
  const chapter = section.split('.')[0]
  return `${context}\nThe teacher is currently working in chapter ${chapter}, on ${page}. When the same number is in several chapters, the teacher means the one in chapter ${chapter}.`
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

  const at = opts.near && opts.near.bookId === book.id && Number.isInteger(opts.near.pageIndex) && opts.near.pageIndex >= 0 && opts.near.pageIndex < book.pageCount ? opts.near.pageIndex : null
  try {
    if (query.kind === 'page') {
      // a book without printed numbers is looked up by file page
      const labels = book.labels.some(label => label !== null) ? book.labels : Array.from({ length: book.pageCount }, (_, i) => String(i + 1))
      let found = findPageIndexes(labels, query.label).filter(index => index < book.pageCount)
      let note: string | undefined
      // no printed page with that number: the file page with it, said out loud
      const n = /^\d{1,4}$/.test(query.label.trim()) ? Number(query.label) : 0
      if (!found.length && n >= 1 && n <= book.pageCount) { found = [n - 1]; note = `No printed page ${n}, added file page ${n}.` }
      if (!found.length) return { error: `Page ${query.label} is not in ${book.title}.` }
      const candidateAt = async (index: number, p: number): Promise<RankedCandidate> => ({ ...pageCandidate(book, index, (await getPage(book.id, index).catch(() => null)) ?? undefined), p })
      // page numbers that repeat (a packet of units): the one nearest where the teacher is, else the teacher picks
      if (found.length > 1 && at === null) {
        const ranked = await Promise.all(found.slice(0, 3).map(index => candidateAt(index, 1 / found.length)))
        return { query, book, ranked, confident: false, source: 'exact' }
      }
      const index = at === null ? found[0] : found.reduce((best, next) => Math.abs(next - at) < Math.abs(best - at) ? next : best)
      return { query, book, ranked: [await candidateAt(index, 1)], confident: true, source: 'exact', ...(note ? { note } : {}) }
    }

    // "the page I'm looking at" is the page open in the reference panel (else the last one inserted)
    if (query.kind === 'topic' && at !== null && isHerePage(query.raw)) {
      return { query, book, ranked: [{ ...pageCandidate(book, at, (await getPage(book.id, at).catch(() => null)) ?? undefined), p: 1 }], confident: true, source: 'exact' }
    }
    const { pages, anchors } = await bookData(book)
    if (isStructureQuery(query) && query.kind === 'topic') {
      const index = query.terms === 'table of contents' ? pages.find(isContentsPage)?.index
        : (book.guide?.sections ?? book.outline).filter(entry => new RegExp(`^(?:chapter\\s+)?${query.chapter}(?:\\s|\\.)`, 'i').test(entry.title))
          .sort((a, b) => a.pageIndex - b.pageIndex)[0]?.pageIndex
      if (index === undefined) return { error: 'The book index could not locate that chapter or contents page. Open it in the reader and use Insert page.' }
      return { query, book, ranked: [{ ...pageCandidate(book, index, pages.find(page => page.index === index)), p: 1 }], confident: true, source: 'exact' }
    }
    const candidates = buildCandidates(query, book, pages, anchors, 40, at)
    const missing = scopeMiss(query, book, anchors, candidates)
    if (missing) return { error: missing }
    if (!candidates.length) {
      const partial = book.textPages < book.pageCount * .8
      return { error: partial
        ? `The searchable text does not identify that item. ${book.pageCount - book.textPages} pages have little or no text. Open the book, use its contents or a page number, and crop the item visually; OCR is not enabled.`
        : query.kind === 'item' ? `${itemName(query)} was not found in the local index for ${book.title}. Try its name or the printed page number.` : `No matching passage was found in ${book.title}. Try a distinctive phrase, its chapter, or a page number.` }
    }
    const sure = certainItem(query, candidates) ?? certainTopic(query, candidates)
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
