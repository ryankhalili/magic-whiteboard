import { analyzeLibraryText, titleMatch } from './search'
import type { LibraryQuery } from './types'

export type LibraryIntent =
  | { action: 'insert'; query: LibraryQuery }
  | { action: 'route_import'; to: 'board' | 'library' }
  | { action: 'open_book'; book: string }
  | { action: 'close_reference' }
  /** one of the highlighted matches, 1 based */
  | { action: 'pick'; index: number }

export type IntentState = { importPending: boolean; hasBooks: boolean; bookTitles?: string[]; highlightCount?: number }

const POLITE = /^(?:(?:ok(?:ay)?|um+|uh+|so|now|and|hi|hey|please|can you|can we|could you|could we|would you|let'?s|go ahead and|just)\s+)*/
const TO_LIBRARY = [
  /^(?:store|save|keep|file|add)(?: (?:it|this|that|the (?:pdf|book|file|document)))?(?: (?:in|to|into) (?:the |my )?library)?$/,
  /^(?:put|send|move)(?: (?:it|this|that|the (?:pdf|book|file)))? (?:in|to|into) (?:the |my )?library$/,
  /^(?:(?:in|to|into) )?(?:the |my )?library$/,
  /^(?:save|store) (?:it|this|that) for later$/,
]
const TO_BOARD = [
  /^(?:put|place|add|drop|import|show|bring)(?: (?:it|this|that|them|the (?:pdf|pages?|file|document)))? (?:on|onto|to|on to) (?:the |my )?(?:white)?board$/,
  /^(?:on|onto|to) (?:the )?(?:white)?board$/,
  /^(?:the )?(?:white)?board$/,
]
const CLOSE = /^(?:close|hide|dismiss|put away)(?: the| my)? (?:book|textbook|reference(?: panel)?|panel|pdf|reader)(?: panel)?$/
const OPEN = /^(?:open|show|pull up|bring up|go to|switch to)(?: up)? (?:the |my |our )?(.+?)$/
const NOT_BOOKS = new Set(['board', 'whiteboard', 'notebook', 'settings', 'menu', 'file', 'files', 'export', 'library', 'pen', 'pens', 'tools', 'toolbar', 'panel', 'pdf',
  'image', 'images', 'help', 'camera', 'microphone', 'mic', 'voice', 'page', 'it', 'this', 'that', 'new', 'new board', 'new page', 'inspector', 'grid', 'graph', 'plot', 'history',
  'eraser', 'magic pen', 'chat', 'keyboard', 'calculator', 'import', 'import dialog', 'options', 'preferences', 'window', 'tab', 'link', 'door', 'a new board'])
// "number 2", "option 3", "the second one", "first one", "#2" or a bare "2" while matches are highlighted
const PICK = /^(?:(?:yes|yeah|yep)\s+)?(?:(?:pick|choose|select|take|use|insert|add|put|show me|show|give me|go with|i want|i'?ll take|let'?s do|do)\s+)?(?:the\s+)?(?:(?:(?:number|option|match|choice|badge|result|no|#)\s*)(\d{1,2}|one|two|three)|(\d{1,2}|first|second|third|1st|2nd|3rd|last)(?:\s+(?:one|match|option|choice|result|badge))?)(?:\s+(?:on|onto|to) (?:the )?(?:white)?board)?$/
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, first: 1, second: 2, third: 3, '1st': 1, '2nd': 2, '3rd': 3 }

function normalize(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[“”"!?,;:]+/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(/\s+please$/, '').trim()
}

/** The highlighted match a teacher picks by number, or null when the text is not a pick. */
export function pickIndex(text: string, count: number): number | null {
  if (!(count > 0)) return null
  const match = PICK.exec(normalize(text))
  if (!match) return null
  const word = match[1] ?? match[2]
  const index = word === 'last' ? count : /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word] ?? 0
  return index >= 1 && index <= count ? index : null
}

/**
 * Library requests clear enough to handle without the model: "page 22", "problem 3.2", "store it",
 * "open the calculus book", "number 2" while matches are highlighted. Anything unclear returns null and goes to the model as usual.
 */
export function detectLibraryIntent(text: string, state: IntentState): LibraryIntent | null {
  const clean = normalize(text)
  if (!clean || clean.length > 160) return null
  if (state.importPending) {
    if (TO_LIBRARY.some(pattern => pattern.test(clean))) return { action: 'route_import', to: 'library' }
    if (TO_BOARD.some(pattern => pattern.test(clean))) return { action: 'route_import', to: 'board' }
  }
  if (CLOSE.test(clean)) return { action: 'close_reference' }
  const index = pickIndex(clean, state.highlightCount ?? 0)
  if (index !== null) return { action: 'pick', index }
  if (!state.hasBooks) return null
  // Preserve original casing for "page I have open" versus Roman page i;
  // only discard conversational prefixes when checking leftover words.
  const { query } = analyzeLibraryText(text)
  const { leftovers } = analyzeLibraryText(clean)
  if (query && (query.kind === 'page' || query.kind === 'item') && !leftovers.length) return { action: 'insert', query }
  if (query) return null
  const open = OPEN.exec(clean)
  if (open) {
    const mentionsBook = /\b(book|textbook)$/.test(open[1])
    // "open the book" means the open or only book
    const name = /^(?:the |my |our )?(?:text ?)?book$/.test(open[1]) ? '' : open[1].replace(/\s+(?:book|textbook|text book)$/, '').replace(/^(?:the|my|our|a|an)\s+/, '').trim()
    if ((!name && !mentionsBook) || name.length > 60 || NOT_BOOKS.has(name) || /\d+\.\d|^\d+$/.test(name)) return null
    // without the word book, only "open" plus a name that matches a library title opens a book ("open a graph" is a board request)
    if (!mentionsBook && (!/^open\b/.test(clean) || !(state.bookTitles ?? []).some(title => titleMatch(name, title) >= .5))) return null
    return { action: 'open_book', book: name }
  }
  return null
}
