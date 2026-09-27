export type RankTask = 'library' | 'placement' | 'book'
export type RankItem = { id: string; text: string; features?: Record<string, number> }
export type RankRequest = { task: RankTask; query: string; items: RankItem[]; context?: string }
export type RankResult = { ranked: { id: string; p: number }[]; confident: boolean; source: 'jev' | 'local'; model?: string; ms: number; note?: string }

/** Feature weights for the local ranker. Features are expected in 0..1 and missing ones count as 0. */
export const FEATURE_WEIGHTS: Record<RankTask, Record<string, number>> = {
  library: { exactLabel: 3, kindMatch: 2, kindPrior: 1.5, textMatch: 1.5, sameChapter: .5, early: .2, inSection: 3, nearChapter: 1, nearSection: .5 },
  placement: { inView: 2, readingOrder: 1.5, workSpace: 1.5, nearFocus: 1, centered: .5, aligned: .7 },
  book: { titleMatch: 3, recent: 1 },
}

const TEMPERATURE = 1
// used only when no item carries a known feature, so plain titles still rank sensibly
const TEXT_WEIGHT = 3
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'or', 'for', 'from', 'with', 'is', 'it', 'me', 'my', 'this', 'that', 'book', 'please'])

const clamp01 = (v: number) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
const tokens = (text: string) => (text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? []).filter(t => t.length > 1 && !STOPWORDS.has(t))

function featureScore(weights: Record<string, number>, features: Record<string, number> | undefined): number | null {
  if (!features) return null
  let score = 0, known = false
  for (const [name, weight] of Object.entries(weights)) {
    const value = features[name]
    if (typeof value !== 'number') continue
    known = true
    score += weight * clamp01(value)
  }
  return known ? score : null
}

function textOverlap(query: string[], text: string): number {
  if (!query.length) return 0
  const have = new Set(tokens(text))
  return query.filter(t => have.has(t)).length / query.length
}

/** Softmax over scores with max subtraction; an all equal list becomes uniform. */
export function softmax(scores: number[], temperature = TEMPERATURE): number[] {
  if (!scores.length) return []
  const max = Math.max(...scores)
  const exps = scores.map(s => Math.exp((s - max) / temperature))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map(e => e / total)
}

/** Top probability is high and clearly ahead of the runner up. */
export function isConfident(ranked: { p: number }[]): boolean {
  if (!ranked.length) return false
  const ps = ranked.map(r => Number.isFinite(r.p) ? r.p : 0).sort((a, b) => b - a)
  if (ps.length === 1) return ps[0] >= .5
  return ps[0] >= .6 && ps[0] - ps[1] >= .25
}

/** Free ranker: weighted feature sum, softmax, best first, ties keep input order. */
export function localRank(req: RankRequest): RankResult {
  const started = Date.now()
  const weights = FEATURE_WEIGHTS[req.task] ?? {}
  const items = req.items ?? []
  const featureScores = items.map(item => featureScore(weights, item.features))
  const useText = featureScores.every(s => s === null)
  const query = useText ? tokens(req.query ?? '') : []
  const scores = items.map((item, i) => useText ? TEXT_WEIGHT * textOverlap(query, item.text ?? '') : featureScores[i] ?? 0)
  const ps = softmax(scores)
  const ranked = items.map((item, i) => ({ id: item.id, p: ps[i], score: scores[i], i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ id, p }) => ({ id, p }))
  return { ranked, confident: isConfident(ranked), source: 'local', ms: Date.now() - started }
}
