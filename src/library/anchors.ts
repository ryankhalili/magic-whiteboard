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

const EXERCISES_ON = [
  /^SECTION\s+\d+(\.\d+)*\s+(EXERCISES|PROBLEMS)$/i,
  /^(EXERCISES|PROBLEMS|PRACTICE PROBLEMS|PRACTICE EXERCISES|REVIEW EXERCISES|CHAPTER REVIEW EXERCISES|REVIEW PROBLEMS|PROBLEM SET|HOMEWORK PROBLEMS)$/i,
  /^(EXERCISES|PROBLEMS)\s+(FOR\s+)?(SECTION\s+)?\d+(\.\d+)*$/i,
]
const EXERCISES_OFF = /^(chapter review|key terms|key equations|key concepts|summary|chapter summary|glossary|references|further reading|index)$/i
const ANSWERS = /^(answer key|answers|answers to (selected |odd.numbered )?(exercises|problems)|solutions to (selected )?(exercises|problems))$/i
const STOPPERS = /^(Rule:|Problem-Solving Strategy|MEDIA$|STUDENT PROJECT|Learning Objectives$)/
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

/** The nearest line just above, in the same column. */
function previousLine(lines: TextLine[], order: number): TextLine | null {
  const line = lines[order]
  for (let k = order - 1; k >= 0; k--) {
    const other = lines[k]
    if (line.box.y - other.box.y > 2.2 * line.box.h) return null
    if (other.box.y < line.box.y - 0.3 * line.box.h && other.box.x < line.box.x + line.box.w && other.box.x + other.box.w > line.box.x) return other
  }
  return null
}

function isHeading(line: TextLine, body: number) {
  return line.size >= body * 1.15 && /[A-Za-z]{2}/.test(line.text) && line.text.length <= 140
}

/** Running headers and footers: small print or page numbers in the top and bottom margins. */
function edgeLines(lines: TextLine[], body: number): Set<TextLine> {
  const edges = new Set<TextLine>()
  for (const line of lines) {
    const top = line.box.y < 0.07, bottom = line.box.y + line.box.h > 0.93
    if (!top && !bottom) continue
    if (line.size < body * 0.93 || /access for free at|^page \d+/i.test(line.text) || printedNumberCandidates([line.text]).length) edges.add(line)
  }
  return edges
}

function median(values: number[], fallback: number) {
  if (!values.length) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Items a teacher can ask for by name on one page, with the area to crop for each.
 * exerciseMode carries from page to page: it starts at an exercises heading and ends at the next section.
 * answers carries the same way: the size of an "Answer Key" heading while inside it, else 0.
 */
export function detectAnchors(
  bookId: string,
  page: { index: number; lines: TextLine[]; exerciseMode: boolean; answers?: number },
  bodySize: number,
): { anchors: Anchor[]; exerciseMode: boolean; answers: number } {
  const all = [...(page.lines ?? [])].filter(line => line && typeof line.text === 'string' && line.box && Number.isFinite(line.size))
    .sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x)
  const body = bodySize > 0 ? bodySize : bodyFontSize(all)
  const edges = edgeLines(all, body)
  const lines = all.filter(line => !edges.has(line))
  let exerciseMode = !!page.exerciseMode, answers = page.answers && page.answers > 0 ? page.answers : 0
  const lineH = median(lines.map(line => line.box.h), body * 1.2)
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
  lines.forEach((line, order) => {
    const text = line.text.trim(), ratio = line.size / body
    if (ratio >= 1.25 && ANSWERS.test(text)) { answers = line.size; exerciseMode = false; return }
    if (answers) {
      // answer keys have their own chapter headings; only a heading as big as "Answer Key" ends them
      if (line.size >= answers * 0.95 && isHeading(line, body)) answers = 0
      else return
    }
    if (EXERCISES_ON.some(pattern => pattern.test(text)) && (ratio >= 1.1 || text === text.toUpperCase())) { exerciseMode = true; return }
    if (exerciseMode && (ratio >= 1.6 || (ratio >= 1.25 && /^\d{1,3}\.\d{1,3}\s+\S/.test(text)) || (ratio >= 1.15 && EXERCISES_OFF.test(text)))) exerciseMode = false
    const match = matchLine(text, ratio, exerciseMode, previousLine(lines, order)?.text.trim() ?? '')
    if (match && !((match.kind === 'checkpoint' || match.kind === 'section') && listed.has(line))) found.push({ ...match, line, order })
  })

  if (!found.length) return { anchors: [], exerciseMode, answers }

  const footerTop = Math.min(1, ...all.filter(line => edges.has(line) && line.box.y > 0.5).map(line => line.box.y))
  const bodyBottom = footerTop < 1 ? footerTop - 0.3 * lineH : 0.95
  const headerBottom = Math.max(0, ...all.filter(line => edges.has(line) && line.box.y < 0.5).map(line => line.box.y + line.box.h))
  const pageLeft = Math.min(...lines.map(line => line.box.x))
  // math drawn as graphics has no text, so assume margins are about even
  const pageRight = Math.min(1, Math.max(1 - pageLeft, ...lines.map(line => line.box.x + line.box.w)))
  const spanning = lines.filter(line => line.box.x < 0.45 && line.box.x + line.box.w > 0.55).length
  const rightLines = lines.filter(line => line.box.x >= 0.45)
  const gutter = rightLines.length ? Math.min(...rightLines.map(line => line.box.x)) : 1
  const rightEdge = rightLines.filter(line => Math.abs(line.box.x - gutter) <= 0.01).length
  const twoColumns = spanning <= Math.max(1, lines.length * 0.03) && rightEdge >= 4
    && rightLines.reduce((n, line) => n + line.text.length, 0) >= 200
    && lines.filter(line => line.box.x + line.box.w <= 0.55).length >= 4
  const columnLeft = (line: TextLine) => twoColumns && line.box.x >= gutter - 0.01 ? gutter : pageLeft
  const pad = 0.35 * lineH, low = 0.004
  const bounders = found.filter(item => item.kind !== 'figure' && item.kind !== 'table')
  const bounding = new Set(bounders.map(item => item.line)), itemLines = new Set(found.map(item => item.line))

  const anchors: Anchor[] = []
  const ids = new Map<string, number>()
  for (const item of found) {
    const a = item.line
    let right = Math.max(a.box.x + a.box.w, twoColumns && a.box.x < gutter - 0.01 ? gutter - 0.015 : pageRight), cell = false
    for (const other of bounders) {
      // exercises laid out in a grid: the next item on the same row bounds this one
      if (other !== item && other.line.box.x > a.box.x + 0.03 && Math.abs(other.line.box.y - a.box.y) <= 0.6 * lineH && other.line.box.x - 0.012 < right) {
        right = other.line.box.x - 0.012; cell = true
      }
    }
    const left = a.box.x
    // lines of a neighbouring grid cell on the left stay out, full width lines count
    const inBand = (line: TextLine) => line.box.x < right && (line.box.x >= left - 0.02 || line.box.x + line.box.w > left + 0.05)
    let top: number, bottom: number, minX = a.box.x
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
      const sameRow = (line: TextLine) => Math.abs(line.box.y - a.box.y) <= 0.5 * lineH
      for (const line of lines) {
        if (line !== a && sameRow(line) && line.box.x > a.box.x && inBand(line)) { included.push(line); bottom = Math.max(bottom, line.box.y + line.box.h) }
      }
      let end: number | null = null, last = bottom
      for (let k = item.order + 1; k < lines.length; k++) {
        const line = lines[k]
        if (!inBand(line) || sameRow(line)) continue
        const text = line.text.trim()
        const stop = bounding.has(line) || isHeading(line, body) || STOPPERS.test(text)
          || (item.kind === 'example' && /^(Solution|Analysis)\b/.test(text))
          || (item.kind === 'theorem' && /^Proof\b/.test(text))
          || ((item.kind === 'checkpoint' || item.kind === 'theorem' || item.kind === 'definition') && line.box.x < a.box.x - low)
          || ((item.kind === 'exercise' || item.kind === 'problem' || item.kind === 'question') && line.box.x <= a.box.x + low && line.box.y - last > 1.6 * lineH)
        if (stop) { end = line.box.y - 0.3 * lineH; break }
        included.push(line)
        minX = Math.min(minX, line.box.x)
        last = line.box.y + line.box.h
        bottom = Math.max(bottom, last)
      }
      bottom = Math.max(bottom + 0.25 * lineH, end ?? bodyBottom)
    }
    const x = Math.max(0, Math.min(minX, left) - 0.01)
    const box: PageBox = { x, y: Math.max(0, top), w: Math.min(1, cell ? right : right + 0.01) - x, h: 0 }
    box.h = Math.min(1, bottom) - box.y
    if (!(box.w > 0.01) || !(box.h > 0.005)) continue
    const texts = rows(included, lineH)
    const heading = headingFor(texts)
    const base = `${bookId}#${page.index}:${item.kind}:${item.label}`
    const seen = (ids.get(base) ?? 0) + 1
    ids.set(base, seen)
    anchors.push({
      id: seen > 1 ? `${base}:${seen}` : base,
      bookId, pageIndex: page.index, kind: item.kind, label: item.label,
      heading,
      box: roundBox(box),
      snippet: texts.join(' ').slice(0, 300),
    })
  }
  return { anchors, exerciseMode, answers }
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
