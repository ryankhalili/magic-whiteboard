import type { BoardContext, BoardObject, Bounds } from '../shared/board'
import type { Editor, TLShapeId } from './canvas/editor'
import { findSpots, obstaclesFromObjects } from './board/placementSpots'
import { overlaps } from './files/pdfPages'
import type { Spot } from './library/types'

/** the area covered by the objects a command just added (ids not on the page before), or null */
export function addedBounds(editor: Pick<Editor, 'getShapePageBounds'>, before: ReadonlySet<string>, ids: readonly string[]): Bounds | null {
  const boxes: Bounds[] = []
  for (const id of ids) {
    const b = before.has(id) ? null : editor.getShapePageBounds(id as TLShapeId)
    if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h })
  }
  if (!boxes.length) return null
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y))
  return { x: left, y: top, w: Math.max(...boxes.map(b => b.x + b.w)) - left, h: Math.max(...boxes.map(b => b.y + b.h)) - top }
}

/** the message after a library insert; a note that already says what was added ("... added file page 5.") is not repeated */
export function insertMessage(added: string, notes: readonly string[]): string {
  const said = !!added && notes.some(note => note.toLowerCase().includes(added.toLowerCase().replace(/\.$/, '')))
  return [said ? '' : added, ...notes].filter(Boolean).join(' ')
}

/** the server refuses typed instructions longer than this (requestSchema text) */
export const MAX_INSTRUCTION = 3000

/** a plain message for an instruction the server would refuse, or null */
export function instructionTooLong(text: string): string | null {
  const length = text.trim().length
  if (length <= MAX_INSTRUCTION) return null
  return `That instruction is ${length.toLocaleString('en-US')} characters long. Shorten it to ${MAX_INSTRUCTION.toLocaleString('en-US')} or fewer and send it again.`
}

const HISTORY = /^(?:please\s+)?(undo|redo)(?:\s+(?:that|it|this|the last (?:change|step|edit|one)))?(?:\s*,?\s*please)?[.!]*$/i
/** "undo" or "redo" typed on its own runs on the board, with no model call */
export function localHistoryCommand(text: string): 'undo' | 'redo' | null {
  const match = HISTORY.exec(text.trim())
  return match ? match[1].toLowerCase() as 'undo' | 'redo' : null
}

// "the graph" is a thing to change; "graph y = x" and "write the derivative" make something new
const NAMED_THING = /\b(?:the|this|that|my|its|his|her|their|a|an)\s+(?:plot|graph|drawing|sketch|label|list)s?\b/gi
const CREATES = /\b(?:plot|graph|draw|sketch|write|add|put|insert|create|place|label|copy|duplicate|show|solve|derive|differentiate|integrate|explain|annotate|list|new|another|make\s+(?:a|an|another|me|some|two|three))\b/i
// "make it red", "move the graph left": a change to the selection, not a new answer
const EDITS = /^\s*(?:(?:please|now|ok|okay)[\s,]+)*(?:make\s+(?:it|this|that|these|those|them|the|its|everything|all)\b|turn|change|colou?r|recolou?r|move|shift|drag|rotate|flip|resize|scale|shrink|enlarge|grow|delete|remove|erase|clear|hide|bring|send|lock|unlock|fill|bold|highlight|set|update|fix|correct|replace|edit)\b/i
/** false when nothing new will be placed: a focus decides placement, and an edit of the selection creates nothing */
export function wantsPlacement(text: string, context: Pick<BoardContext, 'focus' | 'selectedIds'>): boolean {
  if (context.focus) return false
  if (!context.selectedIds.length) return true
  // a follow up question ("find the vertex") still places its answer, even with the graph selected
  return CREATES.test(text.replace(NAMED_THING, ' ')) || !EDITS.test(text)
}

const PANEL_PAGE = /^(?:(?:please|can you|could you|would you)\s+)*(?:(?:put|insert|add|place|bring|paste|drop|show(?: me)?|copy|stick|pull|get|give me)(?:\s+(?:up|in))?\s+)?(?:this page|the current page|the open page|the page (?:that )?(?:i'm|i am|im|i have|i've got|i've) (?:looking at|on|reading|viewing|open|up|got open))(?:\s+(?:(?:on|onto|to|into|up on)\s+(?:the\s+)?(?:board|whiteboard|canvas)|here|there))?(?:\s*,?\s*please)?$/
/** "this page", "the page I'm looking at": the page open in the reference panel */
export function asksForPanelPage(text: string): boolean {
  const plain = text.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  return PANEL_PAGE.test(plain)
}

/** what a typed reply must still match: the board, not the pointer, a gesture or the view (new content is revealed after) */
export function boardOnly(context: BoardContext): BoardContext {
  return { ...context, library: undefined, placementOptions: undefined, pointer: null, gesture: null, viewport: { x: 0, y: 0, w: 0, h: 0 } }
}

type BoardCommandState = { active: boolean; ready: boolean; notebookId: string; editor: Editor | null; boardKey: string; libraryKey?: string }
/** Async PDF work may finish after Stop, a source edit, or a notebook switch. It must not commit then. */
export function captureBoardCommandGuard(getState: () => BoardCommandState, isCurrent: () => boolean = () => true) {
  const original = { ...getState() }
  const current = () => {
    const current = getState()
    return current.active && current.ready && !!current.editor && isCurrent()
      && current.notebookId === original.notebookId && current.editor === original.editor && current.boardKey === original.boardKey
      && current.libraryKey === original.libraryKey
  }
  // Used only immediately after the instruction's own guarded, synchronous panel changes.
  return { isCurrent: current, acceptLibraryChange: () => { original.libraryKey = getState().libraryKey } }
}

const whole = (b: Bounds): Bounds => ({ x: Math.round(b.x), y: Math.round(b.y), w: b.w > 0 ? Math.max(1, Math.round(b.w)) : b.w, h: b.h > 0 ? Math.max(1, Math.round(b.h)) : b.h })
/**
 * objects for the model, most useful first: selection and focus, worksheet pages in view, other content newest first,
 * then loose ink, so handwriting never pushes a graph or a problem out of the snapshot; bounds in whole units
 */
export function modelObjects(objects: readonly BoardObject[], important: ReadonlySet<string>, view: Bounds | null | undefined, limit = 120): BoardObject[] {
  const trimmed = objects.map((o): BoardObject => o.kind === 'pdf_page' && o.text && !(view && overlaps(o.bounds, view)) ? { ...o, text: undefined } : o)
  const first: BoardObject[] = [], pages: BoardObject[] = [], rest: BoardObject[] = []
  for (const o of trimmed) (important.has(o.id) ? first : o.kind === 'pdf_page' && o.text ? pages : rest).push(o)
  rest.reverse()
  return [...first, ...pages, ...rest.filter(o => o.kind !== 'draw'), ...rest.filter(o => o.kind === 'draw')]
    .slice(0, limit).map(o => ({ ...o, bounds: whole(o.bounds) }))
}

/** Local target checks need exact page bounds; only model-facing snapshots may round them. */
export function localContextObjects(objects: readonly BoardObject[], important: ReadonlySet<string>, view: Bounds | null | undefined, limit = 120): BoardObject[] {
  const bounds = new Map(objects.map(object => [object.id, object.bounds]))
  return modelObjects(objects, important, view, limit).map(object => ({ ...object, bounds: { ...bounds.get(object.id)! } }))
}

type ShelfBook = { title?: string; fileName?: string; pageCount: number; labels?: readonly (string | null)[] }
/** the page open in the reference panel: printed label when there is one, and the file page index from 0 */
export type PanelPage = { label: string | null; pageIndex: number }
/** book titles and page counts only: the model never sees book text, and book ids tell it nothing */
export type ModelLibrary = {
  openBook: { title: string } | null
  books: { title: string; pages: number }[]
  pendingImport?: { name: string; pages: number } | null
  highlights?: string[]
  panelPage?: PanelPage
}
const bookTitle = (book: Pick<ShelfBook, 'title' | 'fileName'>) => (book.title || book.fileName || 'Untitled book').slice(0, 200)
export function modelLibrary(input: { books: readonly ShelfBook[]; open: ShelfBook | null; pending: { name: string; pages: number } | null; highlights: readonly string[]; panelPageIndex: number | null }): ModelLibrary | undefined {
  const { books, open, pending, highlights, panelPageIndex } = input
  if (!books.length && !open && !pending) return undefined
  const page = open && panelPageIndex !== null && Number.isInteger(panelPageIndex) && panelPageIndex >= 0 && panelPageIndex < Math.max(1, open.pageCount) ? panelPageIndex : null
  return {
    openBook: open ? { title: bookTitle(open) } : null,
    books: books.slice(0, 20).map(book => ({ title: bookTitle(book), pages: Math.min(100_000, Math.max(0, Math.floor(book.pageCount) || 0)) })),
    pendingImport: pending ? { name: pending.name.slice(0, 240), pages: Math.min(100_000, Math.max(0, Math.floor(pending.pages) || 0)) } : null,
    ...(open && highlights.length ? { highlights: highlights.slice(0, 3).map(title => title.slice(0, 160)) } : {}),
    ...(open && page !== null ? { panelPage: { label: open.labels?.[page]?.slice(0, 40) || null, pageIndex: page } } : {}),
  }
}

type Insets = { left: number; top: number; right: number; bottom: number }
/** A4 page mode: the part of the sheet in view when it can hold the content, else the whole sheet (the board glides there) */
export function sheetAreas(viewport: Bounds, insets: Insets, sheet: Bounds, size: { w: number; h: number }): Bounds[] {
  const left = Math.max(viewport.x + insets.left, sheet.x), top = Math.max(viewport.y + insets.top, sheet.y)
  const right = Math.min(viewport.x + viewport.w - insets.right, sheet.x + sheet.w), bottom = Math.min(viewport.y + viewport.h - insets.bottom, sheet.y + sheet.h)
  const seen = { x: left, y: top, w: right - left, h: bottom - top }
  return seen.w >= size.w && seen.h >= size.h ? [seen, sheet] : [sheet]
}
export const onSheet = (b: Bounds, sheet: Bounds) => b.x >= sheet.x - .5 && b.y >= sheet.y - .5 && b.x + b.w <= sheet.x + sheet.w + .5 && b.y + b.h <= sheet.y + sheet.h + .5

/** screen edges kept for the tool rail, the board options, the footer and the right margin, in css pixels */
const EDGES = { left: 84, top: 56, right: 16, bottom: 40 }
const SHEET_MARGIN = 24
/**
 * free spots for new content, best first, clear of floating panels (avoid) and everything on the board;
 * with a sheet (A4 page mode) only spots on it count, a background is the paper, and none means the view center
 */
export function freeSpots(input: {
  viewport: Bounds; zoom: number; objects: readonly BoardObject[]; size: { w: number; h: number }; workBelow: number
  sheet?: Bounds | null; isBackground?: (id: string) => boolean; extra?: readonly Bounds[]; near?: Bounds | null; avoid?: readonly Bounds[]
}): Spot[] {
  const { viewport, objects, size, workBelow, sheet, isBackground, extra = [], near = null, avoid = [] } = input
  const z = input.zoom > 0 ? input.zoom : 1
  const insets = { left: EDGES.left / z, top: EDGES.top / z, right: EDGES.right / z, bottom: EDGES.bottom / z }
  const obstacles = [...obstaclesFromObjects(sheet && isBackground ? objects.filter(o => !isBackground(o.id)) : objects), ...extra]
  const find = (area: Bounds, edges: Insets) => findSpots({ viewport: area, obstacles, size, workBelow, near, max: 12, avoid, insets: edges })
  if (!sheet) return find(viewport, insets)
  // a small margin keeps new content off the edge of the printed page
  const paper = sheet.w > 4 * SHEET_MARGIN && sheet.h > 4 * SHEET_MARGIN ? { x: sheet.x + SHEET_MARGIN, y: sheet.y + SHEET_MARGIN, w: sheet.w - 2 * SHEET_MARGIN, h: sheet.h - 2 * SHEET_MARGIN } : sheet
  for (const area of sheetAreas(viewport, insets, paper, size)) {
    const spots = find(area, { left: 0, top: 0, right: 0, bottom: 0 }).filter(spot => onSheet(spot.bounds, paper))
    if (spots.length) return spots
  }
  return []
}

/** the server's answer when this device's pairing has lapsed (restart, or after a day) */
export function isPairingError(error: unknown): boolean {
  if (typeof error === 'string') return /pair this device/i.test(error)
  const e = error as { code?: unknown; status?: unknown; message?: unknown } | null
  if (!e || typeof e !== 'object') return false
  return e.code === 'pairing_required' || e.status === 401 || (typeof e.message === 'string' && /pair this device/i.test(e.message))
}

/** typed commands left in the local allowance, from /api/status; low from 90 percent used */
export function commandAllowance(status: { limits?: { commandLimit?: number }; usage?: { commands?: number } } | null | undefined): { used: number; limit: number; left: number; low: boolean } | null {
  const limit = status?.limits?.commandLimit, used = status?.usage?.commands
  if (typeof limit !== 'number' || !(limit > 0) || typeof used !== 'number' || !(used >= 0)) return null
  const left = Math.max(0, Math.floor(limit - used))
  return { used, limit, left, low: used >= limit * .9 }
}

/** the start of an utterance from the local mic level (0 to 1, every 50 ms): true once when it rises after quietMs of quiet */
export function createSpeechStart({ on = .08, off = .03, quietMs = 700 } = {}) {
  let loud = false, quietSince = -Infinity
  return (level: number, now: number): boolean => {
    if (level >= on) {
      if (loud) return false
      loud = true
      return now - quietSince >= quietMs
    }
    if (level <= off && loud) { loud = false; quietSince = now }
    return false
  }
}
