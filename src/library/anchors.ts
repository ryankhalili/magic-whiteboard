import { printedNumberCandidates } from './labels'
import type { Anchor, AnchorKind, PageBox, TextLine } from './types'

/** The most common line size, weighted by text length. */
export function bodyFontSize(lines: TextLine[]): number {
  const buckets = new Map<number, { weight: number; sum: number }>()
  for (const line of lines) {
    const n = line.text.replace(/\s/g, '').length
    if (!n || !(line.size > 0)) continue
    const key = Math.round(line.size * 2000)
    const bucket = buckets.get(key) ?? { weight: 0, sum: 0 }
    bucket.weight += n; bucket.sum += n * line.size
    buckets.set(key, bucket)
  }
  let best: { weight: number; sum: number } | null = null
  for (const bucket of buckets.values()) if (!best || bucket.weight > best.weight) best = bucket
  return best ? best.sum / best.weight : 0.012
}

type Found = { kind: AnchorKind; label: string; line: TextLine; order: number }

/** An item that ran off the bottom of its page, handed to the next page to find the rest of it. */
export type OpenItem = {
  id: string
  kind: AnchorKind
  /** the item's number and its box, measured from its column's left edge */
  dx: number
  boxDx: number
  w: number
  /** where body text starts on its page, so an empty top margin is not taken for the rest of the item */
  top: number
  /** exercises on its page wrap with a hanging indent */
  hanging: boolean
}

export type Continued = { id: string; continues: { pageIndex: number; box: PageBox } }

const EXERCISES_ON = [
  /^SECTION\s+\d+(\.\d+)*\s+(EXERCISES|PROBLEMS)$/i,
  /^(EXERCISES|PROBLEMS|PRACTICE PROBLEMS|PRACTICE EXERCISES|REVIEW EXERCISES|CHAPTER REVIEW EXERCISES|REVIEW PROBLEMS|PROBLEM SET|HOMEWORK PROBLEMS)$/i,
  /^(EXERCISES|PROBLEMS)\s+(FOR\s+)?(SECTION\s+)?\d+(\.\d+)*$/i,
]
const EXERCISES_OFF = /^(chapter review|key terms|key equations|key concepts|summary|chapter summary|glossary|references|further reading|index)$/i
const SECTION_HEADING = /^Section\s+\d+(\.\d+)*\b/i
const ANSWERS = /^(answer key|answers|answers to (selected |odd.numbered )?(exercises|problems)|solutions to (selected )?(exercises|problems))$/i
const STOPPERS = /^(Rule:|Problem-Solving Strategy|MEDIA$|STUDENT PROJECT|Learning Objectives$)/
// the instruction for the next group of exercises: "For the following exercises, find ..."
const INSTRUCTION = /^(\[T\]\s*)?((For|In)\s+(each of\s+)?the\s+(following|next)\b|[A-Z][a-z]+ the following\b|The following (graphs?|tables?|figures?|questions|problems|exercises|data)\b|True or False\b)/
const KEYWORDS: Array<[RegExp, AnchorKind]> = [
  [/^(EXAMPLE|Example)\s+(\d+(?:\.\d+)*)/, 'example'],
  [/^(THEOREM|Theorem)\s+(\d+(?:\.\d+)*)/, 'theorem'],
  [/^(DEFINITION|Definition)\b\s*(\d+(?:\.\d+)*)?/, 'definition'],
  [/^(PROBLEM|Problem)\s+(\d+(?:\.\d+)*)/, 'problem'],
  [/^(EXERCISE|Exercise)\s+(\d+(?:\.\d+)*)/, 'exercise'],
  [/^(QUESTION|Question)\s+(\d+)/, 'question'],
  [/^(Figure|FIGURE)\s+(\d+(?:\.\d+)*)/, 'figure'],
  [/^(Table|TABLE)\s+(\d+(?:\.\d+)*)/, 'table'],
]

const REFERENCE_END = /\b(Table|Figure|Example|Equation|Section|Chapter|Theorem|Exercises?|Checkpoint|Definition|Problem|Rule|Appendix|Eq\.|Fig\.)$/i
const CONTINUATION = /^(to|and|or|shows?|gives|illustrates|lists|we|that|which|with|from|as|at|by|on|in|of|the|a|an|but|so|then)\s/

/** The line above ends mid sentence, so this line is its continuation. */
function continues(previous: string) {
  return !!previous && (REFERENCE_END.test(previous) || /[A-Za-z,]$/.test(previous))
}

function matchLine(text: string, ratio: number, exerciseMode: boolean, previous: string): { kind: AnchorKind; label: string } | null {
  for (const [pattern, kind] of KEYWORDS) {
    const match = pattern.exec(text)
    if (!match) continue
    const rest = text.slice(match[0].length).trim()
    const upper = match[1] === match[1].toUpperCase()
    // "Example 3.5 shows that" or "(see) Example 3.5, we found" is a reference inside a sentence, not the item itself
    if (!upper && ratio < 1.05 && (/^[a-z,;]/.test(rest) || continues(previous))) return null
    if (kind === 'definition' && !match[2] && rest && !/^[.:(]/.test(rest) && !upper) return null
    return { kind, label: match[2] ?? '' }
  }
  const numbered = /^(\d{1,3}\.\d{1,3})\s+(\S.*)$/.exec(text)
  // "Table" at the end of the line above makes "1.8 shows the ..." a wrapped reference
  if (numbered && !numbered[1].startsWith('0.') && /[A-Za-z]{2}/.test(numbered[2])) {
    if (ratio >= 1.25) return { kind: 'section', label: numbered[1] }
    if (ratio <= 1.1 && !continues(previous) && !CONTINUATION.test(numbered[2])) return { kind: 'checkpoint', label: numbered[1] }
    return null
  }
  // "12. Find" is an exercise only inside an exercise set, otherwise it is a step of a worked solution
  const exercise = exerciseMode ? /^(\d{1,3})\s?\.(?:\s|$)/.exec(text) : null
  if (exercise && ratio < 1.25 && Number(exercise[1]) >= 1) return { kind: 'exercise', label: String(Number(exercise[1])) }
  return null
}

/**
 * The line just above in the same column when this line could carry on its sentence, else ''.
 * A heading, a line after a paragraph gap, or a line that stops well short of the margin ended its sentence.
 */
function sentenceBefore(lines: TextLine[], order: number, body: number, column: (line: TextLine) => { left: number; right: number }): string {
  const line = lines[order]
  for (let k = order - 1; k >= 0; k--) {
    const other = lines[k]
    if (line.box.y - other.box.y > 2.2 * line.box.h) return ''
    if (other.box.y < line.box.y - 0.3 * line.box.h && other.box.x < line.box.x + line.box.w && other.box.x + other.box.w > line.box.x) {
      if (other.size >= body * 1.15 || line.box.y - other.box.y > 1.8 * line.box.h) return ''
      // the sentence goes on from the last piece of that row, after any math between the pieces
      const { left, right } = column(other)
      const end = lines.filter(piece => Math.abs(piece.box.y - other.box.y) <= 0.5 * other.box.h && column(piece).left === left)
        .reduce((last, piece) => piece.box.x + piece.box.w > last.box.x + last.box.w ? piece : last, other)
      const text = end.text.trim()
      if (REFERENCE_END.test(text)) return text
      return end.box.x + end.box.w >= right - 0.3 * Math.max(0.1, right - left) ? text : ''
    }
  }
  return ''
}

function isHeading(line: TextLine, body: number) {
  return line.size >= body * 1.15 && /[A-Za-z]{2}/.test(line.text) && line.text.length <= 140
}

/**
 * Running headers and footers: the lines at the very top and bottom of the page, set apart from the body
 * by a clear gap, in small print or with a page number, and "Access for free at". An item heading is never one.
 */
function edgeLines(lines: TextLine[], body: number, lineH: number): Set<TextLine> {
  const edges = new Set<TextLine>()
  const marginal = (text: string) => /access for free at|^page \d+\b/i.test(text)
  const running = (line: TextLine, text: string) => !KEYWORDS.some(([pattern]) => pattern.test(text)) && !/^\d{1,3}\s?\.(\s|$)/.test(text)
    && (line.size < body * 0.93 || printedNumberCandidates([text]).length > 0)
  for (const fromTop of [true, false]) {
    const order = fromTop ? lines : [...lines].sort((p, q) => (q.box.y + q.box.h) - (p.box.y + p.box.h))
    let inner: number | null = null, count = 0, apart = true
    for (const line of order) {
      const gap = inner === null ? Infinity : fromTop ? line.box.y - inner : inner - (line.box.y + line.box.h)
      if (count && gap >= 0.9 * lineH) break
      if (fromTop ? line.box.y >= 0.07 : line.box.y + line.box.h <= 0.93) { apart = count > 0 && gap >= 0.9 * lineH; break }
      count++
      inner = fromTop ? Math.max(inner ?? 0, line.box.y + line.box.h) : Math.min(inner ?? 1, line.box.y)
    }
    for (const line of order.slice(0, count)) {
      const text = line.text.trim()
      if (marginal(text) || (apart && running(line, text))) edges.add(line)
    }
  }
  return edges
}

function median(values: number[], fallback: number) {
  if (!values.length) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const exerciseLike = (kind: AnchorKind) => kind === 'exercise' || kind === 'problem' || kind === 'question'

/**
 * Items a teacher can ask for by name on one page, with the area to crop for each.
 * exerciseMode carries from page to page: it starts at an exercises heading and ends at the next section,
 * exerciseSize is the size of that heading (0 when unknown).
 * answers carries the same way: the size of an "Answer Key" heading while inside it, else 0.
 * carry holds the items of the page before that ran off its bottom; continued says where each one goes on,
 * and open lists this page's items that run off its bottom, for the next page.
 */
export function detectAnchors(
  bookId: string,
  page: { index: number; lines: TextLine[]; exerciseMode: boolean; answers?: number; exerciseSize?: number; carry?: OpenItem[] },
  bodySize: number,
): { anchors: Anchor[]; exerciseMode: boolean; answers: number; exerciseSize: number; open: OpenItem[]; continued: Continued[] } {
  const all = [...(page.lines ?? [])].filter(line => line && typeof line.text === 'string' && line.box && Number.isFinite(line.size))
    .sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x)
  const body = bodySize > 0 ? bodySize : bodyFontSize(all)
  const edges = edgeLines(all, body, median(all.map(line => line.box.h), body * 1.2))
  const lines = all.filter(line => !edges.has(line))
  let exerciseMode = !!page.exerciseMode, answers = page.answers && page.answers > 0 ? page.answers : 0
  let exerciseSize = exerciseMode && page.exerciseSize && page.exerciseSize > 0 ? page.exerciseSize : 0
  const lineH = median(lines.map(line => line.box.h), body * 1.2)

  const footerTop = Math.min(1, ...all.filter(line => edges.has(line) && line.box.y > 0.5).map(line => line.box.y))
  const bodyBottom = footerTop < 1 ? footerTop - 0.3 * lineH : 0.95
  const headerBottom = Math.max(0, ...all.filter(line => edges.has(line) && line.box.y < 0.5).map(line => line.box.y + line.box.h))
  const pageLeft = lines.length ? Math.min(...lines.map(line => line.box.x)) : 0.1
  // math drawn as graphics has no text, so assume margins are about even
  const pageRight = Math.min(1, Math.max(1 - pageLeft, ...lines.map(line => line.box.x + line.box.w)))
  const spanning = lines.filter(line => line.box.x < 0.45 && line.box.x + line.box.w > 0.55).length
  const rightLines = lines.filter(line => line.box.x >= 0.45)
  const gutter = rightLines.length ? Math.min(...rightLines.map(line => line.box.x)) : 1
  const rightEdge = rightLines.filter(line => Math.abs(line.box.x - gutter) <= 0.01).length
  const twoColumns = spanning <= Math.max(1, lines.length * 0.03) && rightEdge >= 4
    && rightLines.reduce((n, line) => n + line.text.length, 0) >= 200
    && lines.filter(line => line.box.x + line.box.w <= 0.55).length >= 4
  const inRight = (line: TextLine) => twoColumns && line.box.x >= gutter - 0.01
  const columnLeft = (line: TextLine) => inRight(line) ? gutter : pageLeft
  const columnRight = (line: TextLine) => twoColumns && !inRight(line) ? gutter - 0.015 : pageRight

  // a table of contents or chapter outline is a tight list of "3.2 Title" lines, not checkpoints
  const listed = new Set<TextLine>()
  const numberedLines = lines.filter(line => /^\d{1,3}\.\d{1,3}\s+\S/.test(line.text))
  for (const line of numberedLines) {
    let run: TextLine[] = []
    for (const other of numberedLines.filter(entry => Math.abs(entry.box.x - line.box.x) <= 0.006)) {
      if (run.length && other.box.y - run[run.length - 1].box.y > 2.5 * lineH) { if (run.length >= 3) run.forEach(entry => listed.add(entry)); run = [] }
      run.push(other)
    }
    if (run.length >= 3) run.forEach(entry => listed.add(entry))
  }
  const pageNumbered = /[A-Za-z].*\s(\.\s*)*\d{1,4}$/
  if (lines.filter(line => pageNumbered.test(line.text)).length >= 5) numberedLines.forEach(line => { if (pageNumbered.test(line.text)) listed.add(line) })
  const found: Found[] = []
  const column = (line: TextLine) => ({ left: columnLeft(line), right: columnRight(line) })
  lines.forEach((line, order) => {
    const text = line.text.trim(), ratio = line.size / body
    if (ratio >= 1.25 && ANSWERS.test(text)) { answers = line.size; exerciseMode = false; exerciseSize = 0; return }
    if (answers) {
      // answer keys have their own chapter headings; only a heading as big as "Answer Key" ends them
      if (line.size >= answers * 0.95 && isHeading(line, body)) answers = 0
      else return
    }
    if (EXERCISES_ON.some(pattern => pattern.test(text)) && (ratio >= 1.1 || text === text.toUpperCase())) {
      exerciseMode = true; exerciseSize = isHeading(line, body) ? line.size : 0
      return
    }
    // a new section ends an exercise set: a big or numbered heading, "Section 2.3", or any heading as big as the one that started it
    if (exerciseMode && (ratio >= 1.6 || (ratio >= 1.25 && /^\d{1,3}\.\d{1,3}\s+\S/.test(text)) || (ratio >= 1.15 && EXERCISES_OFF.test(text))
      || (isHeading(line, body) && (SECTION_HEADING.test(text) || (exerciseSize > 0 && line.size >= exerciseSize * 0.97))))) { exerciseMode = false; exerciseSize = 0 }
    const match = matchLine(text, ratio, exerciseMode, sentenceBefore(lines, order, body, column))
    if (match && !((match.kind === 'checkpoint' || match.kind === 'section') && listed.has(line))) found.push({ ...match, line, order })
  })

  const pad = 0.35 * lineH, low = 0.004
  const bounders = found.filter(item => item.kind !== 'figure' && item.kind !== 'table')
  const bounding = new Set(bounders.map(item => item.line)), itemLines = new Set(found.map(item => item.line))
  const sameRow = (p: TextLine, q: TextLine) => Math.abs(p.box.y - q.box.y) <= 0.6 * lineH
  // exercises laid out in a grid: the next item on the same row ends a cell
  const cells = new Map<Found, { right: number; neighbor: number | null }>()
  for (const item of found) {
    const a = item.line
    let right = Math.max(a.box.x + a.box.w, columnRight(a)), neighbor: number | null = null
    for (const other of bounders) {
      if (other !== item && other.line.box.x > a.box.x + 0.03 && sameRow(other.line, a) && other.line.box.x - 0.012 < right) { right = other.line.box.x - 0.012; neighbor = other.line.box.x }
    }
    cells.set(item, { right, neighbor })
  }
  const bandOf = (left: number, right: number) => (line: TextLine) => line.box.x < right && (line.box.x >= left - 0.02 || line.box.x + line.box.w > left + 0.05)
  // exercises whose lines wrap in from their number
  let hang = 0, flush = 0
  for (const item of bounders) {
    if (!exerciseLike(item.kind)) continue
    const a = item.line, inBand = bandOf(a.box.x, cells.get(item)!.right)
    const next = lines.find((line, k) => k > item.order && line.box.y > a.box.y + 0.5 * lineH && inBand(line))
    if (!next || next.box.y - a.box.y > 1.8 * lineH || bounding.has(next)) continue
    if (next.box.x > a.box.x + 0.01) hang++
    else if (next.box.x <= a.box.x + low) flush++
  }
  const hanging = hang > flush
  // "For the following exercises, ..." with the rest of its row, which math splits into pieces; with hanging exercises any
  // unnumbered row back at the column margin starts the next group like that
  const instructions = new Set<TextLine>(), groupRows = new Set<TextLine>()
  // the margin is where the exercise numbers start (sub part letters may hang further left)
  const numberLeft = (line: TextLine) => Math.min(...bounders.filter(item => exerciseLike(item.kind) && columnLeft(item.line) === columnLeft(line)).map(item => item.line.box.x), columnRight(line))
  for (const line of lines) {
    if (bounding.has(line)) continue
    const instruction = INSTRUCTION.test(line.text.trim()), margin = line.box.x <= Math.max(columnLeft(line), Math.min(numberLeft(line), columnLeft(line) + 0.05)) + 0.01
    if (!instruction && !(margin && hanging)) continue
    for (const other of lines) {
      if (other.box.x < line.box.x || !sameRow(other, line) || columnLeft(other) !== columnLeft(line)) continue
      if (instruction) instructions.add(other)
      if (margin) groupRows.add(other)
    }
  }
  // hangs: the item's number sits at its column's margin on a page of hanging exercises, so a line back at that margin is not its own
  const ends = (kind: AnchorKind, line: TextLine, ax: number, gap: number, hangs: boolean) => {
    const text = line.text.trim()
    return bounding.has(line) || isHeading(line, body) || STOPPERS.test(text) || (exerciseLike(kind) && instructions.has(line))
      || (kind === 'example' && /^(Solution|Analysis)\b/.test(text))
      || (kind === 'theorem' && /^Proof\b/.test(text))
      || ((kind === 'checkpoint' || kind === 'theorem' || kind === 'definition') && (line.box.x < ax - low || itemLines.has(line)))
      // the next group's instructions, a line from further left, or text back at the number's margin
      || (exerciseLike(kind) && (line.box.x < ax - 0.02 || (line.box.x <= ax + low && (hangs || INSTRUCTION.test(text) || gap > 1.6 * lineH))))
  }
  // the rest of an item at the top of a column: down to the first line that ends it
  // bodyTop is where text starts on the page the item came from: a stop line about that high has nothing above it
  const rest = (item: { kind: AnchorKind; ax: number; x: number; w: number; hanging: boolean }, pool: TextLine[], top: number, bodyTop: number, right: number): PageBox | null => {
    const inBand = bandOf(item.ax, right)
    const cellOf = new Map(bounders.map(other => [other.line, other]))
    let last = top, texts = 0
    for (const line of pool) {
      if (line.box.y + line.box.h <= top) continue
      // an item whose cell reaches under this one, or a new group of exercises, ends it even when it starts further left
      const other = cellOf.get(line)
      const blocks = (other && Math.min(cells.get(other)!.right, right) - Math.max(line.box.x, item.ax) > 0.01) || (exerciseLike(item.kind) && groupRows.has(line))
      if (!blocks && !inBand(line)) continue
      if (blocks || ends(item.kind, line, item.ax, line.box.y - last, item.hanging)) {
        const end = line.box.y - 0.3 * lineH
        // nothing but the top margin, or too much to be the tail of one item
        if ((!texts && (line.box.y - bodyTop < 1.5 * lineH || end - top < 1.5 * lineH)) || end - top > 0.5) return null
        return roundBox({ x: item.x, y: top, w: right - item.x, h: end - top })
      }
      texts++; last = line.box.y + line.box.h
    }
    return null
  }
  const topLimit = headerBottom > 0 ? headerBottom + 0.2 * lineH : 0.02

  const continued: Continued[] = []
  const firstColumn = twoColumns ? lines.filter(line => !inRight(line)) : lines
  for (const open of page.carry ?? []) {
    if (!firstColumn.length) break
    const x = Math.max(0, pageLeft + open.boxDx), right = Math.min(twoColumns ? gutter - 0.005 : 1, x + open.w)
    const box = right - x > 0.05 ? rest({ kind: open.kind, ax: pageLeft + open.dx, x, w: right - x, hanging: open.hanging && open.dx <= 0.01 }, firstColumn, topLimit, Math.min(open.top, firstColumn[0].box.y), right) : null
    if (box) continued.push({ id: open.id, continues: { pageIndex: page.index, box } })
  }

  const anchors: Anchor[] = [], open: OpenItem[] = []
  const ids = new Map<string, number>(), textRights = new Map<Found, number>()
  for (const item of found) {
    const a = item.line
    const { right, neighbor } = cells.get(item)!
    const left = a.box.x
    const leftCell = bounders.find(other => other !== item && cells.get(other)!.neighbor === a.box.x && sameRow(other.line, a))
    // lines of a neighbouring grid cell on the left stay out, full width lines count
    const band = bandOf(left, right)
    const inBand = (line: TextLine) => band(line) && !(leftCell && line.box.x < left - low && line.box.x + line.box.w < left + 0.05)
    let top: number, bottom: number, minX = a.box.x, runsOff = false, textBottom = a.box.y + a.box.h
    const included: TextLine[] = [a]
    if (item.kind === 'figure' || item.kind === 'table') {
      // the graphic sits above its caption
      let above = headerBottom > 0 ? headerBottom + pad : 0.04
      for (const line of lines) {
        if (line.box.y + line.box.h > a.box.y - 0.25 * lineH) break
        if (line.box.x < right && line.box.x + line.box.w > Math.min(columnLeft(a), left) - 0.02) above = line.box.y + line.box.h + pad
      }
      top = Math.min(above, a.box.y - pad)
      bottom = a.box.y + a.box.h
      for (let k = item.order + 1; k < lines.length; k++) {
        const line = lines[k]
        if (!inBand(line) || Math.abs(line.box.y - a.box.y) <= 0.5 * lineH) continue
        if (line.box.y - bottom > 0.6 * lineH || itemLines.has(line)) break
        bottom = line.box.y + line.box.h; included.push(line)
      }
      bottom += pad
      minX = Math.min(minX, columnLeft(a))
    } else {
      top = a.box.y - pad
      bottom = a.box.y + a.box.h
      const onRow = (line: TextLine) => Math.abs(line.box.y - a.box.y) <= 0.5 * lineH
      for (const line of lines) {
        if (line !== a && onRow(line) && line.box.x > a.box.x && inBand(line)) { included.push(line); bottom = Math.max(bottom, line.box.y + line.box.h) }
      }
      // the nearest item below whose cell reaches under this one ends it, even when its number sits further left
      let limit = Infinity
      for (const other of bounders) {
        if (other === item || other.line.box.y <= a.box.y + 0.5 * lineH) continue
        if (Math.min(cells.get(other)!.right, right) - Math.max(other.line.box.x, left) > 0.01) limit = Math.min(limit, other.line.box.y)
      }
      let end: number | null = null, last = bottom
      for (let k = item.order + 1; k < lines.length; k++) {
        const line = lines[k]
        if (line.box.y >= limit - 0.3 * lineH) { end = limit - 0.3 * lineH; break }
        // a new group of exercises starts under this cell, or its instructions run in from the left
        if (exerciseLike(item.kind) && !onRow(line) && ((groupRows.has(line) && columnLeft(line) === columnLeft(a))
          || (instructions.has(line) && line.box.x < right && line.box.x + line.box.w > left + 0.005))) { end = line.box.y - 0.3 * lineH; break }
        if (!inBand(line) || onRow(line)) continue
        if (ends(item.kind, line, a.box.x, line.box.y - last, hanging && a.box.x - columnLeft(a) <= 0.01)) { end = line.box.y - 0.3 * lineH; break }
        included.push(line)
        minX = Math.min(minX, line.box.x)
        last = line.box.y + line.box.h
        bottom = Math.max(bottom, last)
      }
      textBottom = bottom
      runsOff = end === null && item.kind !== 'section'
      bottom = Math.max(bottom + 0.25 * lineH, end ?? bodyBottom)
    }
    const x = Math.max(0, Math.min(minX, left) - 0.01)
    // a grid cell widens to take in its own words that run past the next number, but never across that cell
    const textRight = Math.max(...included.map(line => line.box.x + line.box.w))
    textRights.set(item, textRight)
    const edge = neighbor === null ? Math.max(right + 0.01, textRight + 0.008) : Math.max(right, Math.min(textRight + 0.008, neighbor + 0.08))
    const box: PageBox = { x, y: Math.max(0, top), w: Math.min(1, edge) - x, h: 0 }
    box.h = Math.min(1, bottom) - box.y
    if (!(box.w > 0.01) || !(box.h > 0.005)) continue
    // words of the cell on the left, and the next cell's number and text, are painted out
    const own = new Set(included), mask: PageBox[] = []
    for (const line of item.kind === 'figure' || item.kind === 'table' ? [] : lines) {
      const x0 = line.box.x, x1 = line.box.x + line.box.w, mid = line.box.y + line.box.h / 2
      if (own.has(line) || mask.length >= 24 || mid <= box.y || mid >= box.y + box.h || x1 <= box.x || x0 >= box.x + box.w) continue
      // it starts left of this item's number (the cell on the left) or at the next cell's number
      if (x0 >= left - 0.005 && (neighbor === null || x0 < right - 0.002)) continue
      const y0 = Math.max(box.y, line.box.y - 0.1 * lineH), y1 = Math.min(box.y + box.h, line.box.y + line.box.h + 0.1 * lineH)
      let c0 = Math.max(box.x, x0 - 0.003), c1 = Math.min(box.x + box.w, x1 + 0.003)
      // never paint over the item's own words: stop short of them
      for (const mine of included) {
        if (mine.box.y >= y1 || mine.box.y + mine.box.h <= y0) continue
        if (x0 < left - 0.005) c1 = Math.min(c1, mine.box.x - 0.001)
        else c0 = Math.max(c0, mine.box.x + mine.box.w + 0.001)
      }
      if (c1 - c0 > 0.002) mask.push(roundBox({ x: c0, y: y0, w: c1 - c0, h: y1 - y0 }))
    }
    // when the cell on the left runs past this cell's number, everything left of this cell's own text under its first row goes (its math and graphs too)
    const spill = leftCell ? textRights.get(leftCell) ?? 0 : 0
    const below = included.filter(line => line.box.y > a.box.y + 0.5 * lineH)
    if (spill > box.x + 0.002 && below.length && mask.length < 24) {
      const edge = Math.min(...below.map(line => line.box.x)) - 0.004
      const y = Math.max(...included.filter(line => line.box.y <= a.box.y + 0.5 * lineH).map(line => line.box.y + line.box.h)) + 0.1 * lineH
      if (edge > box.x + 0.002 && box.y + box.h > y) mask.push(roundBox({ x: box.x, y, w: edge - box.x, h: box.y + box.h - y }))
    }
    const texts = rows(included, lineH)
    const heading = headingFor(texts)
    const base = `${bookId}#${page.index}:${item.kind}:${item.label}`
    const seen = (ids.get(base) ?? 0) + 1
    ids.set(base, seen)
    const anchor: Anchor = {
      id: seen > 1 ? `${base}:${seen}` : base,
      bookId, pageIndex: page.index, kind: item.kind, label: item.label,
      heading,
      box: roundBox(box),
      snippet: texts.join(' ').slice(0, 300),
      ...(mask.length ? { mask } : {}),
    }
    anchors.push(anchor)
    // text that reaches the foot of the page (or column) with nothing ending it goes on at the top of the next one
    if (!runsOff || textBottom < bodyBottom - 8 * lineH) continue
    if (twoColumns && !inRight(a)) {
      const right = pageRight + 0.01, x = gutter + box.x - pageLeft
      const pool = lines.filter(inRight)
      const top = Math.max(topLimit, lines[0].box.y - 1.2 * lineH)
      const tail = pool.length && right - x > 0.05 ? rest({ kind: item.kind, ax: gutter + left - pageLeft, x, w: Math.min(box.w, right - x), hanging: hanging && left - pageLeft <= 0.01 }, pool, top, lines[0].box.y, Math.min(right, x + box.w)) : null
      if (tail) anchor.continues = { pageIndex: page.index, box: tail }
    } else {
      const from = columnLeft(a)
      open.push({ id: anchor.id, kind: item.kind, dx: left - from, boxDx: box.x - from, w: box.w, top: lines[0].box.y, hanging })
    }
  }
  return { anchors, exerciseMode, answers, exerciseSize, open, continued }
}

/** Lines grouped into visual rows, left to right. */
function rows(lines: TextLine[], lineH: number): string[] {
  const sorted = [...lines].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x)
  const out: TextLine[][] = []
  for (const line of sorted) {
    const row = out[out.length - 1]
    if (row && Math.abs(line.box.y - row[0].box.y) <= 0.5 * lineH) row.push(line)
    else out.push([line])
  }
  return out.map(row => row.sort((p, q) => p.box.x - q.box.x).map(line => line.text.trim()).join(' ').replace(/\s+/g, ' '))
}

/** "EXAMPLE 3.2" alone gets the title under it: "EXAMPLE 3.2 The Slope of a Tangent Line Revisited". */
function headingFor(texts: string[]): string {
  let heading = texts[0] ?? ''
  if (texts[1] && /^\S+(\s+\S+)?\s*\.?$/.test(heading) && heading.length < 24) heading = `${heading} ${texts[1]}`
  return heading.slice(0, 160)
}

function roundBox(box: PageBox): PageBox {
  const r = (value: number) => Math.round(value * 10000) / 10000
  return { x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h) }
}
