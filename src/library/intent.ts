import { analyzeLibraryText } from './search'
import type { LibraryQuery } from './types'

export type LibraryIntent =
  | { action: 'insert'; query: LibraryQuery }
  | { action: 'route_import'; to: 'board' | 'library' }
  | { action: 'open_book'; book: string }
  | { action: 'close_reference' }

const POLITE = /^(?:(?:ok(?:ay)?|um+|uh+|so|now|and|hey|please|can you|could you|would you|let'?s|go ahead and|just)\s+)*/
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

function normalize(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[“”"!?,;:]+/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(/\s+please$/, '').trim()
}

/**
 * Library requests clear enough to handle without the model: "page 22", "problem 3.2", "store it",
 * "open the calculus book". Anything unclear returns null and goes to the model as usual.
 */
export function detectLibraryIntent(text: string, state: { importPending: boolean; hasBooks: boolean }): LibraryIntent | null {
  const clean = normalize(text)
  if (!clean || clean.length > 160) return null
  if (state.importPending) {
    if (TO_LIBRARY.some(pattern => pattern.test(clean))) return { action: 'route_import', to: 'library' }
    if (TO_BOARD.some(pattern => pattern.test(clean))) return { action: 'route_import', to: 'board' }
  }
  if (CLOSE.test(clean)) return { action: 'close_reference' }
  if (!state.hasBooks) return null
  const { query, leftovers } = analyzeLibraryText(text)
  if (query && (query.kind === 'page' || query.kind === 'item') && !leftovers.length) return { action: 'insert', query }
  if (query) return null
  const open = OPEN.exec(clean)
  if (open) {
    const mentionsBook = /\b(book|textbook)$/.test(open[1])
    // "open the book" means the open or only book
    const name = /^(?:the |my |our )?(?:text ?)?book$/.test(open[1]) ? '' : open[1].replace(/\s+(?:book|textbook|text book)$/, '').replace(/^(?:the|my|our)\s+/, '').trim()
    if ((!name && !mentionsBook) || name.length > 60 || NOT_BOOKS.has(name) || /\d+\.\d|^\d+$/.test(name)) return null
    // "show the graph" is a board request; only "open" names a book without the word book
    if (!mentionsBook && !/^open\b/.test(clean)) return null
    return { action: 'open_book', book: name }
  }
  return null
}
