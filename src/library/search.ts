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
const ITEMS = new RegExp(ITEM.source, 'gi')
const CHAPTER = /\b(?:chapter|chap|ch)\s*\.?\s*(\d{1,2})\b(?![\d.]*\d)/
const IN_SECTION = /\b(?:in|from|of)\s+(\d{1,2}\.\d{1,2})(?![\d.]*\d)/
// roman labels only after "page", so "pi" never reads as page i, and "the page I'm on" or "the page i am looking at" is not page i
const PAGE = /\b(?:pages?|pgs?|p)\s*(\d{1,4})\b|\b(?:pages?|pgs?)\s+([ivxlcdm]{1,7})\b(?!\s*['’]|\s+(?:am|have|was|had|did|need|want|just|can|will)\b)/
// a capital I alone after "page" is the teacher talking: "the page I have open"
const PAGE_PRONOUN = /\b(?:pages?|pgs?)\s+I\b/
const LONE = /^(\d{1,3}(?:\.\d{1,3}){1,2})$/
const LONE_SKIP = new Set(['the', 'a', 'an', 'in', 'from', 'of', 'on', 'to', 'at', 'for', 'me', 'us', 'up', 'onto', 'into'])

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
const GENERIC = new Set(['the', 'my', 'our', 'this', 'that', 'a', 'your', 'text', 'same', 'other', 'current', 'open', 'library', 'whole', 'board', 'it', 'there', 'here', 'detail', 'class', 'chapter', 'section', 'page', 'problem', 'example', 'exercise', 'these', 'those', 'which', 'what', 'order', 'general', 'fact', 'particular', 'front', 'back', 'color', 'red', 'blue', 'black', 'green',
  // words that follow "in" without naming a book: "problem 3.2 in pencil"
  'pen', 'pencil', 'marker', 'ink', 'full', 'colour', 'colors', 'big', 'bigger', 'large', 'larger', 'small', 'smaller', 'bold', 'left', 'right', 'top', 'bottom',
  'center', 'centre', 'middle', 'corner', 'margin', 'space', 'view', 'focus', 'panel', 'reference', 'place', 'advance', 'total', 'person', 'yellow', 'orange', 'purple', 'gray', 'grey',
  'white', 'whiteboard', 'notebook', 'pdf', 'reader', 'sidebar', 'window', 'row', 'column', 'box', 'frame', 'context', 'case', 'print', 'blank', 'turn', 'answer', 'solution',
  // words that say which book without naming it: "the new book"
  'new', 'newest', 'latest', 'last', 'recent', 'old', 'main', 'usual', 'regular', 'course', 'assigned', 'correct', 'first', 'second'])
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
  // "exercise 48 in section 5.1", "section 5.1 exercise 48", "exercise 48 from chapter 5"
  const scope: { section?: string; chapter?: string } = {}
  const found = [...clean.matchAll(ITEMS)]
  const within = found.length > 1 ? found.find(match => match[1] && KIND_WORDS[match[1].toLowerCase()] === 'section' && match[2].includes('.')) : undefined
  if (within) { scope.section = within[2]; clean = cut(clean, within) }
  // "exercise 48 in 5.1"
  const bare = !within && found.length === 1 ? IN_SECTION.exec(clean) : null
  if (bare && bare.index > (found[0].index ?? 0)) { scope.section = bare[1]; clean = cut(clean, bare) }
  const chapter = CHAPTER.exec(clean)
  if (chapter) { scope.chapter = String(Number(chapter[1])); clean = cut(clean, chapter) }
  const rest = (removed: string) => strip(clean.replace(removed, ' '), FILLERS).split(' ').filter(word => word && !STOP.has(word) && !/^(book|textbook|text)$/.test(word))

  const item = ITEM.exec(clean)
  const page = PAGE.exec(clean)
  if (page && (!item || page.index < item.index) && !(page[2] === 'i' && PAGE_PRONOUN.test(raw))) {
    const label = page[1] ? String(Number(page[1])) : page[2].toLowerCase()
    if (/^\d/.test(label) ? Number(label) >= 1 : romanValue(label) !== null) {
      return { query: { kind: 'page', label, ...book, raw }, leftovers: rest(page[0]) }
    }
  }
  if (item) {
    const word = item[1]?.toLowerCase()
    const itemKind = word ? KIND_WORDS[word] ?? undefined : undefined
    return { query: { kind: 'item', label: item[2], ...(itemKind ? { itemKind } : {}), ...book, ...scope, raw }, leftovers: rest(item[0]) }
  }
  const stripped = strip(clean, FILLERS)
  // "the 3.2", "3.2 in chapter 3", but never "what is 3.2"
  const lone = LONE.exec(stripped.split(' ').filter(word => !LONE_SKIP.has(word)).join(' '))
  if (lone) return { query: { kind: 'item', label: lone[1], ...book, ...scope, raw }, leftovers: [] }
  if (hint || scope.chapter || LIBRARY_WORDS.test(clean)) {
    const terms = stripped.replace(LIBRARY_WORDS, ' ').split(/\s+/).filter(word => word && !STOP.has(word) && !/^(book|textbook|text|library)$/.test(word))
    if (terms.length) return { query: { kind: 'topic', terms: terms.join(' '), ...book, ...scope, raw }, leftovers: [] }
  }
  return { query: null, leftovers: [] }
}

// "this page", "the page I'm looking at", "the page we are on": the page the teacher is on, not a search
const HERE_WORDS = new Set(['the', 'this', 'that', 'current', 'same', 'page', 'i', 'im', 'm', 've', 'am', 'have', 'was', 'looking', 'at', 'on', 'open', 'opened', 'we', 're', 'are',
  'here', 'right', 'now', 'showing', 'shown', 'reading', 'viewing', 'just', 'got', 'up', 'in', 'front', 'of', 'me', 'us', 'put', 'show', 'insert', 'add', 'board', 'whiteboard', 'onto', 'to', 'please'])
const HERE_MARKS = new Set(['this', 'current', 'same', 'i', 'im', 'we', 'here'])

export function isHerePage(text: string): boolean {
  const words: string[] = String(text ?? '').toLowerCase().replace(/['’]/g, ' ').match(/[a-z]+/g) ?? []
  return words.includes('page') && words.every(word => HERE_WORDS.has(word)) && words.some(word => HERE_MARKS.has(word))
}

function cut(text: string, match: RegExpMatchArray): string {
  const at = match.index ?? 0
  return `${text.slice(0, at)} ${text.slice(at + match[0].length)}`.replace(/\s+/g, ' ').trim()
}

/** "page 22", "problem 3.2", "the chain rule example from the book"; null when it is not about the library. */
export function parseLibraryQuery(text: string): LibraryQuery | null {
  return analyzeLibraryText(text).query
}

const PRIOR: Record<AnchorKind | 'page', number> = {
  problem: 0.9, exercise: 0.85, example: 0.8, checkpoint: 0.7, question: 0.7, section: 0.4, theorem: 0.5, definition: 0.4, figure: 0.1, table: 0.1, page: 0.3,
}
/** What "problem", "exercise", "question" or a bare number can mean. Sections, theorems and figures only when named. */
export const PRACTICE = new Set<AnchorKind>(['example', 'exercise', 'problem', 'checkpoint', 'question'])
// "problem 3.2", "number 12", "#12": a practice item of any kind
const GENERAL_WORD = /\b(?:prob|problems?|number|no)\b|#/
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
export function pageSections(anchors: Anchor[], count: number): (string | null)[] {
  const starts = anchors.filter(anchor => anchor.kind === 'section' && /^\d+\.\d+$/.test(anchor.label))
    .sort((a, b) => a.pageIndex - b.pageIndex || a.box.y - b.box.y)
  const out: (string | null)[] = new Array(Math.max(0, count)).fill(null)
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

/**
 * Things in the book that could be what the teacher asked for, with features for the ranker.
 * near is the page the teacher is on (reference panel or last insert), so repeated numbers prefer that chapter.
 */
export function buildCandidates(query: LibraryQuery, book: BookRecord, pages: PageRecord[], anchors: Anchor[], limit = 40, near: number | null = null): Candidate[] {
  if (query.kind === 'page') return []
  const count = Math.max(book.pageCount || 0, pages.length, ...anchors.map(anchor => anchor.pageIndex + 1))
  const early = (index: number) => count > 1 ? 1 - index / (count - 1) : 1
  const sectionOf = pageSections(anchors, count)
  const chapterOf = sectionOf.map(section => section ? Number(section.split('.')[0]) : null)
  const byIndex = new Map(pages.map(page => [page.index, page]))
  const out: Candidate[] = []
  const scoped = !!(query.section || query.chapter)
  const inScope = (index: number) => (!query.section || sectionOf[index] === query.section) && (!query.chapter || chapterOf[index] === Number(query.chapter))
  const here = near !== null && Number.isInteger(near) && near >= 0 && near < count ? { chapter: chapterOf[near], section: sectionOf[near] } : null
  // where the item sits compared with what the teacher asked for and where the teacher is
  const askedChapter = query.chapter ? Number(query.chapter) : query.section ? Number(query.section.split('.')[0]) : null
  const place = (index: number): Record<string, number> => {
    const features: Record<string, number> = {}
    // the right chapter but another section still beats another chapter
    if (scoped) features.inSection = inScope(index) ? 1 : chapterOf[index] !== null && chapterOf[index] === askedChapter ? .5 : 0
    if (here) {
      const chapter = chapterOf[index]
      features.nearChapter = here.chapter !== null && chapter !== null ? (chapter === here.chapter ? 1 : Math.max(0, .8 - .2 * Math.abs(chapter - here.chapter))) : 0
      features.nearSection = here.section !== null && sectionOf[index] === here.section ? 1 : 0
    }
    return features
  }

  if (query.kind === 'item') {
    const label = query.label
    const labelChapter = /^\d+\.\d/.test(label) ? Number(label.split('.')[0]) : null
    const words = tokenize(query.raw.replace(new RegExp(escape(label), 'g'), ' '))
      .filter(word => !(word in KIND_WORDS) && !FILLER_WORDS.has(word) && !/^\d+$/.test(word) && !/^(chapter|chap|ch)$/.test(word) && !(query.book ?? '').includes(word))
    const sameChapter = (index: number) => labelChapter !== null && chapterOf[index] !== null ? (chapterOf[index] === labelChapter ? 1 : 0) : 0
    const kindMatch = (kind: AnchorKind) => query.itemKind ? (query.itemKind === kind ? 1 : 0) : (PRACTICE.has(kind) ? 1 : 0)
    const labelled = anchors.filter(anchor => anchor.label === label)
    // "problem 3.2", "exercise 48", "question 5" and "3.2" mean practice items; a bare number falls back to anything with it
    let pool = !query.itemKind || PRACTICE.has(query.itemKind) ? labelled.filter(anchor => PRACTICE.has(anchor.kind)) : labelled
    if (!pool.length && !query.itemKind && !GENERAL_WORD.test(query.raw.toLowerCase())) pool = labelled
    const found = new Set(labelled.map(anchor => anchor.pageIndex))
    for (const anchor of pool) {
      out.push(anchorCandidate(book, anchor, {
        exactLabel: 1, kindMatch: kindMatch(anchor.kind), kindPrior: PRIOR[anchor.kind] ?? 0.2,
        textMatch: overlap(words, `${anchor.heading} ${anchor.snippet}`), early: early(anchor.pageIndex), sameChapter: sameChapter(anchor.pageIndex),
        ...place(anchor.pageIndex),
      }, sectionOf[anchor.pageIndex]))
    }
    // pages that name the item in their text, for books where it was not detected; once items were found,
    // only a page that names the asked for kind ("Exercise 7.3"), never a bare number like an answer key line
    const detected = out.length > 0
    if (!detected || (query.itemKind && !out.some(candidate => candidate.features.kindMatch === 1))) {
      const kinds = query.itemKind && (detected || !PRACTICE.has(query.itemKind)) ? escape(query.itemKind) : 'problem|exercise|example|question|checkpoint'
      const named = new RegExp(`\\b(${kinds})s?\\s+${escape(label)}(?![\\d]|\\.\\d)`, 'i')
      const leading = new RegExp(`(^|\\n)\\s*${escape(label)}\\s*[.)]?\\s+\\S`)
      const extra: Candidate[] = []
      for (const page of pages) {
        if (found.has(page.index)) continue
        const match = named.exec(page.text), lead = !detected && leading.test(page.text)
        if (!match && !lead) continue
        const kind = match ? (KIND_WORDS[match[1].toLowerCase()] ?? null) : null
        extra.push(pageCandidate(book, page.index, page, {
          exactLabel: 0, kindMatch: kind && query.itemKind === kind ? 1 : 0, kindPrior: PRIOR.page,
          textMatch: lead ? 1 : 0.5, early: early(page.index), sameChapter: sameChapter(page.index), ...place(page.index),
        }))
      }
      out.push(...extra.sort((p, q) => localScore(q.features) - localScore(p.features)).slice(0, 5))
    }
  } else {
    let hits = searchPages(pages, query.terms, scoped ? 400 : 30)
    // "limits examples in chapter 2" looks inside that chapter first
    if (scoped) hits = (hits.some(hit => inScope(hit.index)) ? hits.filter(hit => inScope(hit.index)) : hits).slice(0, 30)
    if (!hits.length) return []
    const best = hits[0].score
    const words = [...new Set(tokenize(query.terms))].filter(word => !(word in KIND_WORDS))
    const wanted = (query.terms.toLowerCase().match(/[a-z]+/g) ?? []).map(word => KIND_WORDS[word]).find((kind): kind is AnchorKind => !!kind)
    const pageScore = new Map(hits.map(hit => [hit.index, hit.score / best]))
    for (const anchor of anchors) {
      const score = pageScore.get(anchor.pageIndex)
      if (score === undefined || !TOPIC_KINDS.has(anchor.kind)) continue
      out.push(anchorCandidate(book, anchor, {
        exactLabel: 0, kindMatch: wanted ? (wanted === anchor.kind ? 1 : 0) : (PRACTICE.has(anchor.kind) ? 1 : 0), kindPrior: PRIOR[anchor.kind] ?? 0.2,
        textMatch: Math.max(overlap(words, `${anchor.heading} ${anchor.snippet}`), 0.6 * score), early: early(anchor.pageIndex), ...place(anchor.pageIndex),
      }, sectionOf[anchor.pageIndex]))
    }
    for (const hit of hits) {
      out.push(pageCandidate(book, hit.index, byIndex.get(hit.index), {
        exactLabel: 0, kindMatch: 0, kindPrior: PRIOR.page, textMatch: pageScore.get(hit.index) ?? 0, early: early(hit.index), ...place(hit.index),
      }))
    }
  }
  return out
    .map((candidate, order) => ({ candidate, order, score: localScore(candidate.features) }))
    .sort((p, q) => q.score - p.score || p.order - q.order)
    .slice(0, Math.max(1, limit))
    .map(entry => entry.candidate)
}

// kind words a teacher uses for any practice problem, so any practice item with the number fits them
const LOOSE_KINDS = new Set<AnchorKind>(['problem', 'exercise', 'question'])

/**
 * The item to insert without asking, else null and the teacher picks from the top matches: the teacher named the kind
 * and exactly one item of that kind has the number (in the section or chapter asked for), or exactly one item fits at all.
 * Two kinds sharing a number (Example 3.2, Checkpoint 3.2) always ask; the ranker only orders the choices.
 */
export function certainItem(query: LibraryQuery, candidates: Candidate[]): Candidate | null {
  if (query.kind !== 'item') return null
  const scoped = !!(query.section || query.chapter)
  const fits = candidates.filter(c => c.kind === 'item' && !!c.anchor && c.features.exactLabel === 1 && (!scoped || c.features.inSection === 1))
  // "problem 1.2" names the kind in books that print "Problem 1.2"
  const kind = query.itemKind ?? (/\bprob(?:lem)?s?\b/i.test(query.raw) ? 'problem' : undefined)
  const named = kind ? fits.filter(c => c.anchor!.kind === kind) : []
  if (named.length === 1) return named[0]
  if (!named.length && (!kind || LOOSE_KINDS.has(kind)) && fits.length === 1) return fits[0]
  return null
}

// words for the whole subject of the class, "the math book" or "our science textbook", say which kind of book without naming one
const SUBJECTS: Array<[RegExp, RegExp]> = [
  [/^math(s|ematics)?$/, /\b(math|maths|mathematics|calculus|precalculus|algebra|geometry|trigonometry|statistics|probability)\b/i],
  [/^science$/, /\b(science|physics|chemistry|biology|anatomy|physiology|astronomy|geology)\b/i],
]

/**
 * The books a subject name like "the math book" can mean: the books of that subject, else the books whose titles name no
 * subject at all. null when the name is more than a class subject (then it names a book that is not here).
 */
export function subjectBooks(hint: string, books: BookRecord[]): BookRecord[] | null {
  const words = String(hint ?? '').toLowerCase().split(/\s+/).filter(word => word && !/^\d{1,2}$/.test(word))
  const subject = words.length === 1 ? SUBJECTS.find(([name]) => name.test(words[0])) : undefined
  if (!subject) return null
  const title = (book: BookRecord) => `${book.title} ${book.fileName ?? ''}`
  const same = books.filter(book => subject[1].test(title(book)))
  const plain = books.filter(book => !SUBJECTS.some(([, titles]) => titles.test(title(book))))
  const found = same.length ? same : plain
  return found.length ? found : null
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
