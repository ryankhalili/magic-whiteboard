import { localRank, type RankRequest, type RankResult } from '../../shared/ranking'

function trimmed(req: RankRequest): RankRequest {
  return {
    task: req.task,
    query: String(req.query ?? '').slice(0, 500),
    items: req.items.slice(0, 255).map(item => ({
      id: String(item.id).slice(0, 120), text: String(item.text ?? '').slice(0, 400),
      ...(item.features ? { features: Object.fromEntries(Object.entries(item.features).filter(([, value]) => Number.isFinite(value))) } : {}),
    })),
    ...(req.context ? { context: String(req.context).slice(0, 2000) } : {}),
  }
}

function valid(data: unknown, ids: Set<string>): data is RankResult {
  const result = data as RankResult | null
  return !!result && Array.isArray(result.ranked) && result.ranked.length > 0 && typeof result.confident === 'boolean'
    && result.ranked.every(entry => entry && ids.has(entry.id) && typeof entry.p === 'number' && Number.isFinite(entry.p))
}

/** Ranks candidates on the server (Jev when a key is set); any failure falls back to the free local ranker. */
export async function rankItems(req: RankRequest): Promise<RankResult> {
  const body = trimmed(req)
  if (!body.items.length) return { ranked: [], confident: false, source: 'local', ms: 0 }
  const fallback = () => ({ ...localRank(body), note: 'offline' })
  try {
    const response = await fetch('/api/rank', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Marginalia': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(6_000),
    })
    if (!response.ok) return fallback()
    const data = await response.json()
    const ids = new Set(body.items.map(item => item.id))
    if (!valid(data, ids)) return fallback()
    // anything the server left out keeps its local order at the end
    const seen = new Set(data.ranked.map(entry => entry.id))
    const rest = localRank(body).ranked.filter(entry => !seen.has(entry.id)).map(entry => ({ id: entry.id, p: 0 }))
    return { ...data, ranked: [...data.ranked, ...rest] }
  } catch {
    return fallback()
  }
}
