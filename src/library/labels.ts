const ROMAN = /^(?=[ivxl])(xl|l?x{0,3})(ix|iv|v?i{0,3})$/
const ROMAN_DIGITS: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 }

/** 'xii' -> 12 for lowercase roman numerals up to lxxx, else null */
export function romanValue(text: string): number | null {
  if (!ROMAN.test(text)) return null
  let total = 0
  for (let i = 0; i < text.length; i++) {
    const value = ROMAN_DIGITS[text[i]], next = ROMAN_DIGITS[text[i + 1]] ?? 0
    total += value < next ? -value : value
  }
  return total >= 1 && total <= 80 ? total : null
}

export function toRoman(value: number): string {
  let out = '', rest = Math.floor(value)
  for (const [n, s] of [[50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) {
    while (rest >= n) { out += s; rest -= n }
  }
  return out
}

function arabicValue(text: string): number | null {
  return /^[1-9]\d{0,3}$/.test(text) ? Number(text) : null
}

/** Numbers that look like a printed page number at the start or end of a header or footer line. */
export function printedNumberCandidates(edgeLines: string[]): string[] {
  const out: string[] = []
  for (const raw of edgeLines) {
    const line = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (!line || line.length > 160) continue
    // "22 1 • Functions and Graphs" or "1.1 • Review of Functions 23", but not "23." or "4.10"
    const start = /^(\d{1,4}|[ivxl]{1,7})(?=$| (?![.):,;]))/.exec(line)
    const end = /(?:^|\s)(\d{1,4}|[ivxl]{1,7})$/.exec(line)
    for (const match of [start, end]) {
      const token = match?.[1]
      if (token && (arabicValue(token) !== null || romanValue(token) !== null) && !out.includes(token)) out.push(token)
    }
  }
  return out
}

type Run = { offset: number; pages: number[] }

/** Offsets (index - number) that repeat across pages become runs of consistently numbered pages. */
function runsFor(votes: Map<number, number[]>, total: number): Run[] {
  const count = new Map<number, number>()
  for (const offsets of votes.values()) for (const offset of offsets) count.set(offset, (count.get(offset) ?? 0) + 1)
  const minSupport = total <= 2 ? 1 : total <= 12 ? 2 : 3
  const chosen: { index: number; offset: number }[] = []
  for (const [index, offsets] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
    let best: number | null = null
    for (const offset of offsets) {
      const n = count.get(offset) ?? 0
      if (n >= minSupport && (best === null || n > (count.get(best) ?? 0))) best = offset
    }
    if (best !== null) chosen.push({ index, offset: best })
  }
  // a lone page that disagrees with the pages on both sides is noise
  const smooth = chosen.filter((entry, k) => !(k > 0 && k < chosen.length - 1 && entry.offset !== chosen[k - 1].offset && chosen[k - 1].offset === chosen[k + 1].offset))
  const runs: Run[] = []
  for (const entry of smooth) {
    const last = runs[runs.length - 1]
    if (last && last.offset === entry.offset) last.pages.push(entry.index)
    else runs.push({ offset: entry.offset, pages: [entry.index] })
  }
  const minRun = total <= 2 ? 1 : 2
  return runs.filter(run => run.pages.length >= minRun)
}

function fillRuns(labels: (string | null)[], runs: Run[], format: (value: number) => string | null) {
  const claimed = labels.map(label => label !== null)
  for (const run of runs) {
    const first = run.pages[0], last = run.pages[run.pages.length - 1]
    for (let index = first; index <= last; index++) {
      if (claimed[index]) continue
      labels[index] = format(index - run.offset)
      claimed[index] = true
    }
  }
  // unnumbered pages right next to a run (a chapter opener) continue it
  for (const run of runs) {
    const first = run.pages[0], last = run.pages[run.pages.length - 1]
    for (const [from, step] of [[first - 1, -1], [last + 1, 1]] as const) {
      for (let index = from, k = 0; k < 2 && index >= 0 && index < labels.length && !claimed[index]; index += step, k++) {
        const label = format(index - run.offset)
        if (label === null) break
        labels[index] = label; claimed[index] = true
      }
    }
  }
}

/**
 * Printed page labels from header and footer numbers. edges are the first 2 and last 3 lines of each page.
 * The PDF's own labels are used only when they say more than 1..N and agree with the pages, or when the pages show nothing.
 */
export function assignPrintedLabels(pages: { index: number; edges: string[] }[], pdfLabels?: (string | null)[] | null): (string | null)[] {
  const total = Math.max(pages.length, ...pages.map(page => page.index + 1), 0)
  const labels: (string | null)[] = new Array(total).fill(null)
  const arabic = new Map<number, number[]>(), roman = new Map<number, number[]>()
  for (const page of pages) {
    if (!Number.isInteger(page.index) || page.index < 0) continue
    for (const token of printedNumberCandidates(page.edges ?? [])) {
      const a = arabicValue(token), r = romanValue(token)
      if (a !== null) arabic.set(page.index, [...new Set([...(arabic.get(page.index) ?? []), page.index - a])])
      else if (r !== null) roman.set(page.index, [...new Set([...(roman.get(page.index) ?? []), page.index - r])])
    }
  }
  fillRuns(labels, runsFor(arabic, total), value => value >= 1 ? String(value) : null)
  for (const index of [...roman.keys()]) if (labels[index] !== null) roman.delete(index)
  fillRuns(labels, runsFor(roman, total), value => value >= 1 && value <= 80 ? toRoman(value) : null)

  const own = Array.isArray(pdfLabels) && pdfLabels.length
    ? Array.from({ length: total }, (_, i) => { const label = pdfLabels[i]; return typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : null })
    : null
  if (!own) return labels
  const evidence = labels.filter(label => label !== null).length
  if (!evidence) return own
  const trivial = own.every((label, i) => label === String(i + 1))
  if (trivial) return labels
  let compared = 0, agree = 0
  labels.forEach((label, i) => { if (label !== null && own[i] !== null) { compared++; if (label === own[i]) agree++ } })
  return compared && agree / compared >= 0.8 ? own.map((label, i) => label ?? labels[i]) : labels
}

/** File page index for a printed label: exact first, then case insensitive for roman numerals. */
export function findPageIndex(labels: (string | null)[], label: string): number | null {
  const wanted = String(label ?? '').trim()
  if (!wanted) return null
  const exact = labels.indexOf(wanted)
  if (exact >= 0) return exact
  const lower = wanted.toLowerCase()
  if (romanValue(lower) !== null) {
    const index = labels.findIndex(item => item !== null && item.toLowerCase() === lower)
    if (index >= 0) return index
  }
  return null
}
