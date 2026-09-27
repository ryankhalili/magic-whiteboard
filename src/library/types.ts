import type { Bounds } from '../../shared/board'

/** A rectangle on a book page as fractions of the page width and height (0..1, origin top left). */
export type PageBox = { x: number; y: number; w: number; h: number }

export type BookRecord = {
  /** 'sha256:<64 hex>' of the original PDF bytes */
  id: string
  /** PDF metadata title when it looks real, else the file name without .pdf */
  title: string
  fileName: string
  /** bytes of the original PDF */
  size: number
  pageCount: number
  addedAt: number
  openedAt: number
  /** printed page label for each file page (index 0 is the first page of the file), null when none was found */
  labels: (string | null)[]
  /** flattened PDF outline (chapters and sections) */
  outline: { title: string; pageIndex: number; depth: number }[]
  /** small JPEG data URL of the first page, about 240 px wide, or null */
  cover: string | null
  /** false while indexing, true once pages and anchors are stored */
  indexed: boolean
  /** pages that had a usable text layer */
  textPages: number
  /** version of the item finder that indexed this book, missing means 1 */
  indexVersion?: number
}

/** One visual line of text on a page. size is the font height as a fraction of the page height. */
export type TextLine = { text: string; box: PageBox; size: number }

export type PageRecord = {
  bookId: string
  /** 0 based file page index */
  index: number
  /** printed page label, same as BookRecord.labels[index] */
  label: string | null
  /** page size in PDF points (rotation applied) */
  width: number
  height: number
  /** normalized page text, lines joined with \n, at most 8000 characters */
  text: string
  lines: TextLine[]
}

export type AnchorKind = 'example' | 'exercise' | 'problem' | 'checkpoint' | 'section' | 'theorem' | 'definition' | 'question' | 'figure' | 'table'

/** Something a teacher can ask for by name: "Example 3.2", "exercise 48", "section 3.2". */
export type Anchor = {
  /** `${bookId}#${pageIndex}:${kind}:${label}` plus a numeric suffix if repeated */
  id: string
  bookId: string
  pageIndex: number
  kind: AnchorKind
  /** the number as printed, e.g. '3.2' or '48' */
  label: string
  /** the first line of the item, trimmed, at most 160 characters */
  heading: string
  /** the area to crop for this item on its page */
  box: PageBox
  /** the start of the item's text, at most 300 characters */
  snippet: string
  /** the rest of an item that runs past the bottom of its page (or column), drawn under the first part */
  continues?: { pageIndex: number; box: PageBox }
  /** bits of neighbouring items inside box, painted white when the item is drawn */
  mask?: PageBox[]
}

export type LibraryQuery =
  /** "page 22": a printed page label */
  | { kind: 'page'; label: string; book?: string; raw: string }
  /** "problem 3.2", "example 3.2", "exercise 48", "3.2"; section and chapter from "exercise 48 in section 5.1" */
  | { kind: 'item'; label: string; itemKind?: AnchorKind; book?: string; raw: string; section?: string; chapter?: string }
  /** anything else: "the chain rule example" */
  | { kind: 'topic'; terms: string; book?: string; raw: string; section?: string; chapter?: string }

export type Candidate = {
  /** stable id: an anchor id, or `${bookId}#${pageIndex}:page` */
  id: string
  bookId: string
  pageIndex: number
  /** printed page label of pageIndex */
  label: string | null
  kind: 'page' | 'item'
  anchor?: Anchor
  /** one line a model can judge: "Example 3.2 on page 191: Finding the derivative of ..." at most 300 characters */
  description: string
  /** numeric features in 0..1 used by the local ranker (see shared/ranking.ts FEATURE_WEIGHTS.library) */
  features: Record<string, number>
}

export type RankedCandidate = Candidate & { p: number }

export type LibraryMatch = {
  query: LibraryQuery
  book: BookRecord
  /** best first, at most 3 */
  ranked: RankedCandidate[]
  /** true when ranked[0] can be inserted without asking */
  confident: boolean
  source: 'exact' | 'jev' | 'local'
  /** what the teacher should know about the pick, e.g. "No printed page 5, added file page 5." */
  note?: string
}

export type ImportProgress = { phase: 'reading' | 'indexing' | 'saving'; done: number; total: number }

/** A rendered raster ready to become a board image asset. src is a data:image/(png|jpeg) base64 URL. */
export type RenderedImage = { src: string; w: number; h: number; mimeType: 'image/png' | 'image/jpeg' }

/** A candidate board rectangle for new content, see src/board/placementSpots.ts. */
export type Spot = { id: string; bounds: Bounds; description: string; features: Record<string, number> }
