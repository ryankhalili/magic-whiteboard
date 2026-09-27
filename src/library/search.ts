import { FEATURE_WEIGHTS } from '../../shared/ranking'
import { romanValue } from './labels'
import type { Anchor, AnchorKind, BookRecord, Candidate, LibraryQuery, PageRecord } from './types'

const KIND_WORDS: Record<string, AnchorKind | null> = {
  problem: null, problems: null, prob: null, number: null, no: null, '#': null,
  example: 'example', examples: 'example', ex: 'exercise', exercise: 'exercise', exercises: 'exercise',
  question: 'question', questions: 'question', checkpoint: 'checkpoint', checkpoints: 'checkpoint', 'check point': 'checkpoint',
  section: 'section', sections: 'section', sec: 'section', theorem: 'theorem', theorems: 'theorem', thm: 'theorem',
  definition: 'definition', definitions: 'definition', def: 'definition', figure: 'figure', figures: 'figure', fig: 'figure',
  table: 'table', tables: 'table',
}
const KIND_PATTERN = Object.keys(KIND_WORDS).filter(word => word !== '#' && word !== 'no').sort((a, b) => b.length - a.length).join('|')
const ITEM = new RegExp(`(?:\\b(${KIND_PATTERN})\\s*#?\\s*|#\\s*)(\\d{1,3}(?:\\.\\d{1,3}){0,2})(?![\\d.]*\\d)`, 'i')
// roman labels only after "page", so "pi" never reads as page i
const PAGE = /\b(?:pages?|pgs?|p)\s*(\d{1,4})\b|\b(?:pages?|pgs?)\s+([ivxlcdm]{1,7})\b/i
const LONE = /^(\d{1,3}(?:\.\d{1,3}){1,2})$/

// longest first so "show me" goes before "show"
const FILLERS = [
  'can you', 'could you', 'would you', 'will you', 'i want to see', 'i want', 'i need', "i'd like", 'id like', "let's", 'lets', 'let me see', 'let me',
  'go to', 'turn to', 'flip to', 'jump to', 'take me to', 'show me', 'give me', 'bring up', 'pull up', 'put up', 'look up', 'find me',
  'on the whiteboard', 'onto the whiteboard', 'on the board', 'onto the board', 'to the board', 'on board', 'on the screen', 'up here', 'over here',
  'workbook', 'work on', 'work', 'put', 'insert', 'bring', 'show', 'give', 'pull', 'grab', 'get', 'fetch', 'display', 'add', 'paste', 'place',
  'drop', 'open', 'load', 'find', 'do', 'try', 'here', 'there', 'please', 'now', 'for me', 'for us', 'quickly', 'real quick',
]
const FILLER_WORDS = new Set(FILLERS.filter(phrase => !phrase.includes(' ')))
const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'from', 'for', 'me', 'us', 'up', 'and', 'this', 'that', 'it', 'onto', 'into', 'at', 'my', 'our', 'is', 'are', 'with', 'about', 'by', 'as', 'be', 'or', 'so', 'we', 'you', 'i', 'its', 'one', 'what', 'which', 'how', 'can', 'some', 'out', 'okay', 'ok', 'um', 'uh', 'then', 'next'])
const GENERIC = new Set(['the', 'my', 'our', 'this', 'that', 'a', 'your', 'text', 'same', 'other', 'current', 'open', 'library', 'whole', 'board', 'it', 'there', 'here', 'detail', 'class', 'chapter', 'section', 'page', 'problem', 'example', 'exercise', 'these', 'those', 'which', 'what', 'order', 'general', 'fact', 'particular', 'front', 'back', 'color', 'red', 'blue', 'black', 'green'])
const LIBRARY_WORDS = /\b(book|textbook|text book|library|chapter|in the text)\b/

function escape(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function bookHint(text: string): { hint?: string; phrase?: string } {
  const patterns = [
    /\b(?:from|in|of|out of)\s+(?:the|my|our|this)?\s*([a-z0-9][a-z0-9 '&:-]{0,60}?)\s+(?:book|textbook|text)\b/,
    /\b(?:the\s+)?([a-z][a-z0-9'-]{2,40})\s+(?:book|textbook)\b/,
    /\b(?:from|in)\s+([a-z][a-z0-9'-]{2,40}(?:\s+(?:volume|vol\.?|book|part)\s*\d+)?)\s*$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const hint = match?.[1]?.trim().replace(/^(the|my|our|this)\s+/, '')
    if (!match || !hint || GENERIC.has(hint) || /^(chapter|section|page|problem|example|exercise)\b/.test(hint) || /^\d/.test(hint)) continue
    return { hint, phrase: match[0] }
  }
  return {}
}

function strip(text: string, phrases: string[]): string {
  let out = ` ${text} `
  for (const phrase of phrases) out = out.replace(new RegExp(`(^|\\s)${escape(phrase)}(?=\\s|$)`, 'g'), ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** The query, plus the words it did not account for (a clear request leaves none). */
export function analyzeLibraryText(text: string): { query: LibraryQuery | null; leftovers: string[] } {
  const raw = String(text ?? '').trim().slice(0, 500)
  let clean = raw.toLowerCase().replace(/[“”"!?,;]+/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return { query: null, leftovers: [] }
  const { hint, phrase } = bookHint(clean)
  if (phrase) clean = clean.replace(phrase, ' ').replace(/\s+/g, ' ').trim()
  const book = hint ? { book: hint } : {}
  const rest = (removed: string) => strip(clean.replace(removed, ' '), FILLERS).split(' ').filter(word => word && !STOP.has(word) && !/^(book|textbook|text)$/.test(word))

  const item = ITEM.exec(clean)
  const page = PAGE.exec(clean)
  if (page && (!item || page.index < item.index)) {
    const label = page[1] ? String(Number(page[1])) : page[2].toLowerCase()
    if (/^\d/.test(label) ? Number(label) >= 1 : romanValue(label) !== null) {
      return { query: { kind: 'page', label, ...book, raw }, leftovers: rest(page[0]) }
    }
  }
  if (item) {
    const word = item[1]?.toLowerCase()
    const itemKind = word ? KIND_WORDS[word] ?? undefined : undefined
    return { query: { kind: 'item', label: item[2], ...(itemKind ? { itemKind } : {}), ...book, raw }, leftovers: rest(item[0]) }
  }
  const stripped = strip(clean, FILLERS)
  const lone = LONE.exec(stripped)
  if (lone) return { query: { kind: 'item', label: lone[1], ...book, raw }, leftovers: [] }
  if (hint || LIBRARY_WORDS.test(clean)) {
    const terms = stripped.replace(LIBRARY_WORDS, ' ').split(/\s+/).filter(word => word && !STOP.has(word) && !/^(book|textbook|text|library)$/.test(word))
    if (terms.length) return { query: { kind: 'topic', terms: terms.join(' '), ...book, raw }, leftovers: [] }
  }
  return { query: null, leftovers: [] }
}

/** "page 22", "problem 3.2", "the chain rule example from the book"; null when it is not about the library. */
export function parseLibraryQuery(text: string): LibraryQuery | null {
  return analyzeLibraryText(text).query
}

const PRIOR: Record<AnchorKind | 'page', number> = {
  problem: 0.9, exercise: 0.85, example: 0.8, checkpoint: 0.7, question: 0.7, section: 0.4, theorem: 0.5, definition: 0.4, figure: 0.1, table: 0.1, page: 0.3,
}
const GENERAL = new Set<AnchorKind>(['example', 'exercise', 'problem', 'checkpoint'])
const TOPIC_KINDS = new Set<AnchorKind>(['example', 'exercise', 'problem', 'checkpoint', 'theorem', 'definition'])
const KIND_NAME: Record<AnchorKind, string> = {
  example: 'Example', exercise: 'Exercise', problem: 'Problem', checkpoint: 'Checkpoint', section: 'Section', theorem: 'Theorem',
  definition: 'Definition', question: 'Question', figure: 'Figure', table: 'Table',
}

export function kindName(kind: AnchorKind): string { return KIND_NAME[kind] ?? 'Item' }

const TOKEN_STOP = new Set([...STOP, 'be', 'was', 'were', 'has', 'have', 'had', 'not', 'if', 'then', 'else', 'when', 'where', 'there', 'these', 'those', 'their', 'than', 'also', 'such', 'each', 'use', 'using', 'used', 'find', 'let', 'figure', 'table', 'example', 'solution', 'see', 'book', 'textbook'])

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const word of String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length < 2 || TOKEN_STOP.has(word)) continue
    out.push(word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
  }
  return out
}

type Bm25 = { docs: { index: number; tf: Map<string, number>; len: number }[]; df: Map<string, number>; avg: number }
const indexes = new WeakMap<PageRecord[], Bm25>()

function bm25Index(pages: PageRecord[]): Bm25 {
  const cached = indexes.get(pages)
  if (cached) return cached
  const df = new Map<string, number>()
  let total = 0
  const docs = pages.map(page => {
    const tf = new Map<string, number>()
    const words = tokenize(page.text)
    for (const word of words) tf.set(word, (tf.get(word) ?? 0) + 1)
    for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1)
    total += words.length
    return { index: page.index, tf, len: words.length }
  })
  const index = { docs, df, avg: docs.length ? total / docs.length || 1 : 1 }
  indexes.set(pages, index)
  return index
}

/** BM25 scores of pages for the terms, best first, only pages that match. */
export function searchPages(pages: PageRecord[], terms: string, limit = 30): { index: number; score: number }[] {
  const words = [...new Set(tokenize(terms))]
  if (!words.length || !pages.length) return []
  const { docs, df, avg } = bm25Index(pages)
  const n = docs.length, k1 = 1.2, b = 0.75
  const scored: { index: number; score: number }[] = []
  for (const doc of docs) {
    let score = 0
    for (const word of words) {
      const f = doc.tf.get(word)
      if (!f) continue
      const d = df.get(word) ?? 0
      score += Math.log(1 + (n - d + 0.5) / (d + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.len / avg))
    }
    if (score > 0) scored.push({ index: doc.index, score })
  }
  return scored.sort((p, q) => q.score - p.score || p.index - q.index).slice(0, limit)
}

function overlap(words: string[], text: string): number {
  if (!words.length) return 0
  const have = new Set(tokenize(text))
  return words.filter(word => have.has(word)).length / words.length
}

function pageName(book: BookRecord, index: number) {
  const label = book.labels?.[index]
  return label ? `page ${label}` : `file page ${index + 1}`
}

function anchorDescription(book: BookRecord, anchor: Anchor, section?: string | null): string {
  const name = `${kindName(anchor.kind)}${anchor.label ? ` ${anchor.label}` : ''}`
  const where = section && (anchor.kind === 'exercise' || anchor.kind === 'problem' || anchor.kind === 'question') ? ` in section ${section}` : ''
  const heading = anchor.heading.replace(new RegExp(`^(${escape(anchor.kind)}|${escape(name)})?\\s*${anchor.label ? `${escape(anchor.label)}\\s*\\.?` : ''}\\s*`, 'i'), '').trim()
  let tail = anchor.snippet.startsWith(anchor.heading) ? anchor.snippet.slice(anchor.heading.length).trim() : anchor.snippet
  if (!heading && !tail) tail = anchor.snippet
  const body = [heading, tail].filter(Boolean).join('. ').replace(/\.\s*\./g, '.')
  return `${name}${where} on ${pageName(book, anchor.pageIndex)}${body ? `: ${body}` : ''}`.replace(/\s+/g, ' ').slice(0, 300)
}

function pageDescription(book: BookRecord, page: PageRecord | undefined, index: number): string {
  const label = book.labels?.[index]
  // running headers and footers repeat on every page and say nothing about it
  const lines = (page?.text ?? '').split('\n').filter((line, k, all) => !/access for free at/i.test(line)
    && !((k === 0 || k === all.length - 1) && label && new RegExp(`(^|\\s)${escape(label)}(\\s|$)`).test(line.trim())))
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  const name = pageName(book, index)
  return `${name[0].toUpperCase()}${name.slice(1)}${text ? `: ${text}` : ''}`.slice(0, 300)
}

export function pageCandidate(book: BookRecord, index: number, page?: PageRecord, features: Record<string, number> = { exactLabel: 1, kindPrior: PRIOR.page }): Candidate {
  return {
    id: `${book.id}#${index}:page`, bookId: book.id, pageIndex: index, label: book.labels?.[index] ?? null,
    kind: 'page', description: pageDescription(book, page, index), features,
  }
}

export function anchorCandidate(book: BookRecord, anchor: Anchor, features: Record<string, number>, section?: string | null): Candidate {
  return {
    id: anchor.id, bookId: book.id, pageIndex: anchor.pageIndex, label: book.labels?.[anchor.pageIndex] ?? null,
    kind: 'item', anchor, description: anchorDescription(book, anchor, section), features,
  }
}

/** The numbered section each page belongs to, from the section headings before it. */
function sections(anchors: Anchor[], count: number): (string | null)[] {
  const starts = anchors.filter(anchor => anchor.kind === 'section' && /^\d+\.\d+$/.test(anchor.label))
    .sort((a, b) => a.pageIndex - b.pageIndex || a.box.y - b.box.y)
  const out: (string | null)[] = new Array(count).fill(null)
  let k = 0, current: string | null = null
  for (let index = 0; index < count; index++) {
    while (k < starts.length && starts[k].pageIndex <= index) current = starts[k++].label
    out[index] = current
  }
  return out
}

function localScore(features: Record<string, number>) {
  let score = 0
  for (const [name, weight] of Object.entries(FEATURE_WEIGHTS.library)) score += weight * Math.min(1, Math.max(0, features[name] ?? 0))
  return score
}

/** Things in the book that could be what the teacher asked for, with features for the ranker. */
export function buildCandidates(query: LibraryQuery, book: BookRecord, pages: PageRecord[], anchors: Anchor[], limit = 40): Candidate[] {
  if (query.kind === 'page') return []
  const count = Math.max(book.pageCount || 0, pages.length, ...anchors.map(anchor => anchor.pageIndex + 1))
  const early = (index: number) => count > 1 ? 1 - index / (count - 1) : 1
  const sectionOf = sections(anchors, count)
  const chapterOf = sectionOf.map(section => section ? Number(section.split('.')[0]) : null)
  const byIndex = new Map(pages.map(page => [page.index, page]))
  const out: Candidate[] = []

  if (query.kind === 'item') {
    const label = query.label
    const labelChapter = /^\d+\.\d/.test(label) ? Number(label.split('.')[0]) : null
    const words = tokenize(query.raw.replace(new RegExp(escape(label), 'g'), ' '))
      .filter(word => !(word in KIND_WORDS) && !FILLER_WORDS.has(word) && !/^\d+$/.test(word) && !(query.book ?? '').includes(word))
    const sameChapter = (index: number) => labelChapter !== null && chapterOf[index] !== null ? (chapterOf[index] === labelChapter ? 1 : 0) : 0
    const kindMatch = (kind: AnchorKind) => query.itemKind ? (query.itemKind === kind ? 1 : 0) : (GENERAL.has(kind) ? 1 : 0)
    const found = new Set<number>()
    for (const anchor of anchors) {
      if (anchor.label !== label) continue
      found.add(anchor.pageIndex)
      out.push(anchorCandidate(book, anchor, {
        exactLabel: 1, kindMatch: kindMatch(anchor.kind), kindPrior: PRIOR[anchor.kind] ?? 0.2,
        textMatch: overlap(words, `${anchor.heading} ${anchor.snippet}`), early: early(anchor.pageIndex), sameChapter: sameChapter(anchor.pageIndex),
      }, sectionOf[anchor.pageIndex]))
    }
    // pages that name the item in their text, for books where it was not detected
    if (out.length < 3) {
      const named = new RegExp(`\\b(problem|exercise|example|question|checkpoint|theorem|definition)s?\\s+${escape(label)}(?![\\d]|\\.\\d)`, 'i')
      const leading = new RegExp(`(^|\\n)\\s*${escape(label)}\\s*[.)]?\\s+\\S`)
      const extra: Candidate[] = []
      for (const page of pages) {
        if (found.has(page.index)) continue
        const match = named.exec(page.text), lead = leading.test(page.text)
        if (!match && !lead) continue
        const kind = match ? (KIND_WORDS[match[1].toLowerCase()] ?? null) : null
        extra.push(pageCandidate(book, page.index, page, {
          exactLabel: 0, kindMatch: kind && query.itemKind === kind ? 1 : 0, kindPrior: PRIOR.page,
          textMatch: lead ? 1 : 0.5, early: early(page.index), sameChapter: sameChapter(page.index),
        }))
      }
      out.push(...extra.sort((p, q) => localScore(q.features) - localScore(p.features)).slice(0, 5))
    }
  } else {
    const hits = searchPages(pages, query.terms, 30)
    if (!hits.length) return []
    const best = hits[0].score
    const words = [...new Set(tokenize(query.terms))].filter(word => !(word in KIND_WORDS))
    const wanted = (query.terms.toLowerCase().match(/[a-z]+/g) ?? []).map(word => KIND_WORDS[word]).find((kind): kind is AnchorKind => !!kind)
    const pageScore = new Map(hits.map(hit => [hit.index, hit.score / best]))
    for (const anchor of anchors) {
      const score = pageScore.get(anchor.pageIndex)
      if (score === undefined || !TOPIC_KINDS.has(anchor.kind)) continue
      out.push(anchorCandidate(book, anchor, {
        exactLabel: 0, kindMatch: wanted ? (wanted === anchor.kind ? 1 : 0) : (GENERAL.has(anchor.kind) ? 1 : 0), kindPrior: PRIOR[anchor.kind] ?? 0.2,
        textMatch: Math.max(overlap(words, `${anchor.heading} ${anchor.snippet}`), 0.6 * score), early: early(anchor.pageIndex),
      }, sectionOf[anchor.pageIndex]))
    }
    for (const hit of hits) {
      out.push(pageCandidate(book, hit.index, byIndex.get(hit.index), {
        exactLabel: 0, kindMatch: 0, kindPrior: PRIOR.page, textMatch: pageScore.get(hit.index) ?? 0, early: early(hit.index),
      }))
    }
  }
  return out
    .map((candidate, order) => ({ candidate, order, score: localScore(candidate.features) }))
    .sort((p, q) => q.score - p.score || p.order - q.order)
    .slice(0, Math.max(1, limit))
    .map(entry => entry.candidate)
}

function titleTokens(text: string): string[] {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => !['the', 'a', 'an', 'of', 'and', 'book', 'textbook', 'pdf', 'vol', 'volume'].includes(word))
}

/** How well a spoken book name matches a title, 0..1. */
export function titleMatch(hint: string, title: string): number {
  const want = titleTokens(hint), have = titleTokens(title)
  if (!want.length || !have.length) return 0
  const hit = want.filter(word => have.some(other => other === word || (Math.min(word.length, other.length) >= 4 && (other.startsWith(word) || word.startsWith(other)))))
  return hit.length / want.length
}

/** The open book unless the teacher names another; a named book; the only book; else the choices. */
export function pickBook(books: BookRecord[], hint?: string, openBookId?: string | null): { book: BookRecord | null; ambiguous: BookRecord[] } {
  const list = books.filter(book => book && typeof book.id === 'string')
  const open = openBookId ? list.find(book => book.id === openBookId) ?? null : null
  if (hint && hint.trim()) {
    const scored = list.map(book => ({ book, score: Math.max(titleMatch(hint, book.title), titleMatch(hint, book.fileName ?? '')) }))
    const top = Math.max(0, ...scored.map(entry => entry.score))
    if (top >= 0.5) {
      const matches = scored.filter(entry => entry.score === top).map(entry => entry.book)
      if (open && matches.includes(open)) return { book: open, ambiguous: [] }
      if (matches.length === 1) return { book: matches[0], ambiguous: [] }
      return { book: null, ambiguous: matches }
    }
  }
  if (open) return { book: open, ambiguous: [] }
  if (list.length === 1) return { book: list[0], ambiguous: [] }
  return { book: null, ambiguous: [...list].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0)) }
}
