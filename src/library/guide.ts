import type { Anchor, BookGuide, BookRecord, PageRecord } from './types'

const clean = (text: string) => text.normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim()
const sectionNumber = (title: string) => /^(?:section\s+)?(\d+\.\d+(?:\.\d+)*)\b/i.exec(title)?.[1]
const chapterNumber = (title: string) => /^(?:chapter\s+)(\d+)\b/i.exec(title)?.[1] ?? /^(\d+)\s+[A-Za-z]/.exec(title)?.[1]
const hasContentsLeader = (line: string) => /(?:[.·]\s*){2,}(?:\d+|[ivxlcdm]+)\s*$/i.test(line)

/** Deterministic and free: the existing text pass also produces a reusable map of the book. */
export function buildBookGuide(book: Pick<BookRecord, 'pageCount' | 'labels' | 'outline'>, pages: PageRecord[], anchors: Anchor[]): BookGuide {
  const sections: BookGuide['sections'] = []
  const seen = new Set<string>()
  const contentsPages = new Set<number>()
  const add = (title: string, pageIndex: number, depth: number, source: BookGuide['sections'][number]['source']) => {
    title = clean(title).slice(0, 180)
    if (!title || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= book.pageCount || sections.length >= 600) return
    const key = `${pageIndex}:${title.toLowerCase()}`
    if (!seen.has(key)) { seen.add(key); sections.push({ title, pageIndex, depth: Math.min(6, Math.max(0, depth)), source }) }
  }
  for (const entry of book.outline) add(entry.title, entry.pageIndex, entry.depth, 'outline')

  // A printed TOC is useful even when the PDF has no bookmarks. Resolve printed labels,
  // never assume the number after a dotted leader is a zero-based file page.
  for (const page of pages.slice(0, Math.min(40, Math.ceil(book.pageCount / 4) + 4))) {
    const lines = page.text.split('\n').map(clean)
    const toc = /\b(?:table of contents|contents)\b/i.test(lines.slice(0, 8).join(' '))
      || lines.filter(hasContentsLeader).length >= 3
    if (!toc) continue
    contentsPages.add(page.index)
    for (const line of lines) {
      const match = /^(.{3,170}?)\s*(?:\.{2,}|\s)\s*(\d{1,4}|[ivxlcdm]{1,8})\s*$/i.exec(line)
      if (!match || !/[A-Za-z]{3}/.test(match[1])) continue
      const title = match[1].replace(/[.·\s]+$/, '').trim()
      const targets = book.labels.flatMap((label, i) => label?.toLowerCase() === match[2].toLowerCase() ? [i] : [])
      // A repeated label is ambiguous. Leave it out rather than invent a destination.
      const later = targets.filter(i => i > page.index)
      if (later.length !== 1 && targets.length !== 1) continue
      add(title, later.length === 1 ? later[0] : targets[0], sectionNumber(title) ? 1 : 0, 'contents')
    }
  }
  for (const anchor of anchors) if (anchor.kind === 'section') add(anchor.heading, anchor.pageIndex, 1, 'heading')
  // Plain chapter headings often do not become numbered section anchors.
  for (const page of pages) {
    if (contentsPages.has(page.index)) continue
    for (const line of page.lines.slice(0, 16)) {
      const text = clean(line.text)
      if (!hasContentsLeader(text) && /^chapter\s+\d+\b/i.test(text)) add(text, page.index, 0, 'heading')
    }
  }
  sections.sort((a, b) => a.pageIndex - b.pageIndex || a.depth - b.depth)
  const itemCounts: BookGuide['itemCounts'] = {}
  for (const anchor of anchors) itemCounts[anchor.kind] = (itemCounts[anchor.kind] ?? 0) + 1
  const exercisePages = [...new Set(anchors.filter(a => /^(exercise|problem|question)$/.test(a.kind)).map(a => a.pageIndex))].sort((a, b) => a - b)
  const unreadablePages = pages.filter(page => page.text.replace(/\s/g, '').length < 20).map(page => page.index)
  const notes = ['Search uses the local text index and exact item labels; a missing match does not prove the item is absent.']
  if (exercisePages.length) notes.push(`Practice items were detected on ${exercisePages.length} pages. Use the chapter or section when exercise numbers repeat.`)
  if (unreadablePages.length) notes.push(`${unreadablePages.length} pages have little or no searchable text. Open those pages and crop visually; OCR is not enabled.`)
  if (!sections.length) notes.push('No reliable table of contents or chapter headings were found; search the page text or navigate by page.')
  return { version: 1, sections, itemCounts, exercisePages, unreadablePages, notes }
}

export function bookGuideText(book: BookRecord): string {
  const guide = book.guide
  const page = (index: number) => book.labels[index] ? `printed p. ${book.labels[index]} (file page ${index + 1})` : `file page ${index + 1}`
  const entries = guide?.sections ?? book.outline.map(entry => ({ ...entry, source: 'outline' }))
  return [
    book.title, `File: ${book.fileName}`, `Pages: ${book.pageCount}; searchable text: ${book.textPages}.`,
    'Page references distinguish printed labels from the 1-based file page. A requested printed label may differ from the file page.',
    ...(guide?.notes ?? ['Reopen this book to create its local structure guide.']),
    '', 'CONTENTS', ...entries.map(entry => `${'  '.repeat(entry.depth)}${entry.title} — ${page(entry.pageIndex)}`),
    '', 'DETECTED ITEMS', ...Object.entries(guide?.itemCounts ?? {}).map(([kind, count]) => `${kind}: ${count}`),
    ...(guide?.exercisePages.length ? ['', `Practice pages: ${guide.exercisePages.map(page).join('; ')}`] : []),
    ...(guide?.unreadablePages.length ? ['', `Limited text: ${guide.unreadablePages.map(page).join('; ')}`] : []),
  ].join('\n')
}

/** Bounded context for the command model. The complete guide stays local and downloadable. */
export function getBookGuideContext(book: BookRecord, near: number | null = null): string {
  const guide = book.guide
  const sections = guide?.sections ?? book.outline
  const nearby = near === null ? [] : sections.filter(entry => entry.pageIndex <= near).slice(-2)
  const chosen = [...new Set([...nearby, ...sections.filter(entry => entry.depth === 0), ...sections.slice(0, 14)])]
  const text = [
    `${book.title}: ${book.pageCount} file pages, ${book.textPages} with searchable text.`,
    'Printed page labels may differ from 1-based file pages. Search by the exact theorem/exercise/figure name or label and chapter.',
    ...(guide?.notes ?? []),
    ...chosen.map(entry => `${entry.title}: ${book.labels[entry.pageIndex] ? `printed ${book.labels[entry.pageIndex]}, ` : ''}file page ${entry.pageIndex + 1}`),
  ].join('\n')
  return text.slice(0, 2500)
}

/** Chapter/section scopes also work for books whose structure exists only in PDF bookmarks. */
export function guidePageScopes(book: BookRecord, count: number): { sections: (string | null)[]; chapters: (number | null)[] } {
  const entries = [...(book.guide?.sections ?? book.outline)].sort((a, b) => a.pageIndex - b.pageIndex || a.depth - b.depth)
  const sections: (string | null)[] = new Array(count).fill(null), chapters: (number | null)[] = new Array(count).fill(null)
  let section: string | null = null, chapter: number | null = null, cursor = 0
  for (let index = 0; index < count; index++) {
    while (cursor < entries.length && entries[cursor].pageIndex <= index) {
      const entry = entries[cursor++], sn = sectionNumber(entry.title), cn = chapterNumber(entry.title)
      if (sn) { section = sn; chapter = Number(sn.split('.')[0]) }
      else if (cn) { chapter = Number(cn); section = null }
    }
    sections[index] = section; chapters[index] = chapter
  }
  return { sections, chapters }
}
