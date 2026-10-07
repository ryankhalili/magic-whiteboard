import type { PageRecord, TextLine } from './types'

const normalized = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** Contents page numbers are often separate PDF text runs, far from their titles. */
export function contentsRows(lines: TextLine[]): string[] {
  const rows: { y: number; h: number; parts: TextLine[] }[] = []
  for (const line of [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const row = rows.find(row => Math.abs(row.y - line.box.y) < .4 * Math.min(row.h, line.box.h)
      && row.parts.every(part => part.box.x + part.box.w <= line.box.x + .005))
    if (row) row.parts.push(line)
    else rows.push({ y: line.box.y, h: line.box.h, parts: [line] })
  }
  return rows.map(row => row.parts.sort((a, b) => a.box.x - b.box.x).map(line => normalized(line.text)).join(' '))
}

export function isContentsPage(page: Pick<PageRecord, 'text' | 'lines'>): boolean {
  const rows = page.lines.length ? contentsRows(page.lines) : page.text.split('\n')
  return rows.slice(0, 8).some(row => /^(?:[ivxlcdm]+\s+|\d+\s+)?(?:table of )?contents(?:\s+(?:continued|[ivxlcdm]+|\d+))?$/i.test(row.trim()))
    || rows.filter(row => /(?:[.·]\s*){2,}(?:\d+|[ivxlcdm]+)\s*$/i.test(row)).length >= 3
}

/** Repeated running heads use body-size fonts in many books, including Sakurai. */
export function repeatedMargins(pages: Pick<PageRecord, 'lines'>[]): Set<string> {
  const counts = new Map<string, number>()
  for (const page of pages) {
    const unique = new Set(page.lines.filter(line => line.box.y < .07 || line.box.y > .93).map(line => normalized(line.text)))
    for (const text of unique) counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return new Set([...counts].filter(([text, count]) => count >= 2 && /[A-Za-z]{2}/.test(text)).map(([text]) => text))
}

export function isRepeatedMargin(line: TextLine, repeated: Set<string>): boolean {
  return (line.box.y < .07 || line.box.y > .93) && repeated.has(normalized(line.text))
}
