import type { Express, Request } from 'express'
import { z } from 'zod'
import { isConfident, localRank, type RankItem, type RankRequest, type RankResult, type RankTask } from '../shared/ranking'
import { callJev, probabilityOf, type JevQuestion, type JevResponse } from './jev'
import { accessToken, authorized, RateLimiter, sameOrigin } from './security'

export const rankRequestSchema = z.object({
  task: z.enum(['library', 'placement', 'book']),
  query: z.string().max(500),
  items: z.array(z.object({
    id: z.string().min(1).max(120),
    text: z.string().max(400),
    features: z.record(z.string().max(60), z.number()).refine(f => Object.keys(f).length <= 32).optional(),
  })).min(1).max(255),
  context: z.string().max(2000).optional(),
})

export type RankUsage = { calls: number; inputTokens: number }
export type RankDeps = { key?: string; fetcher?: typeof fetch; timeoutMs?: number; model?: string; baseUrl?: string; onUsage?: (usage: RankUsage) => void }

const JEV_WEIGHT = .7
const DEFAULT_TIMEOUT_MS = 5000
// 'none' takes the last of the 255 choice options
const CHUNK_ITEMS = 254
// options appear in state and criteria, keep each call far below the 32k token state budget
const CHUNK_CHARS = 30_000
const WINNERS_PER_CHUNK = 3
const MAX_JEV_ITEMS = 1000
const MIN_CALL_MS = 200
const NONE = 'none'

const PICK: Record<RankTask, string> = {
  library: 'Which option is the textbook item or page the teacher asked for in `request`?',
  placement: 'Which option is the best free spot on the whiteboard for the new content described in `request`? Prefer the spot a teacher would naturally write in next.',
  book: 'Which option is the book the teacher means in `request`?',
}
const EXISTS = 'One of the `options` is what the teacher asked for in `request`.'

type Entry = { item: RankItem; index: number; local: number }
type Asked = { ok: true; jev: number[]; data: JevResponse } | { ok: false; error: string }

const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) : text
const optionText = (item: RankItem) => clip((item.text ?? '').replace(/\s+/g, ' ').trim(), 400) || clip(item.id, 120)
const cost = (item: RankItem) => optionText(item).length + 12

function normalize(values: number[]) {
  const total = values.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0)
  return total > 1e-12 ? values.map(v => Number.isFinite(v) && v > 0 ? v / total : 0) : values.map(() => 1 / Math.max(1, values.length))
}

function chunk(entries: Entry[]): Entry[][] {
  const groups: Entry[][] = []
  let group: Entry[] = [], chars = 0
  for (const entry of entries) {
    const c = cost(entry.item)
    if (group.length && (group.length >= CHUNK_ITEMS || chars + c > CHUNK_CHARS)) { groups.push(group); group = []; chars = 0 }
    group.push(entry); chars += c
  }
  if (group.length) groups.push(group)
  return groups
}

function blend(entries: Entry[], jev: number[]) {
  const local = normalize(entries.map(e => e.local))
  const p = normalize(entries.map((_, i) => JEV_WEIGHT * jev[i] + (1 - JEV_WEIGHT) * local[i]))
  return entries.map((entry, i) => ({ entry, p: p[i] })).sort((a, b) => b.p - a.p || a.entry.index - b.entry.index)
}

async function ask(req: RankRequest, entries: Entry[], withExists: boolean, deps: RankDeps & { key: string }, deadline: number, usage: RankUsage): Promise<Asked> {
  const remaining = deadline - Date.now()
  if (remaining < MIN_CALL_MS) return { ok: false, error: 'Jev timed out.' }
  const aliases = entries.map((_, i) => `o${i + 1}`)
  const options = Object.fromEntries(entries.map((e, i) => [aliases[i], optionText(e.item)]))
  const questions: Record<string, JevQuestion> = { pick: { type: 'choice', instructions: PICK[req.task], criteria: { ...options, [NONE]: 'None of these match the request' } } }
  if (withExists) questions.exists = { type: 'noul', instructions: EXISTS }
  const state = { request: req.query, ...(req.context ? { context: req.context } : {}), options }
  usage.calls++
  const result = await callJev(deps.key, { state, questions, model: deps.model }, { fetcher: deps.fetcher, timeoutMs: remaining, baseUrl: deps.baseUrl })
  if (!result.ok) return { ok: false, error: result.error }
  usage.inputTokens += result.data.usage?.input_tokens ?? 0
  return { ok: true, jev: normalize(aliases.map(a => probabilityOf(result.data.answers.pick, a))), data: result.data }
}

async function rankWithJev(req: RankRequest, deps: RankDeps & { key: string }, started: number, usage: RankUsage): Promise<RankResult | { error: string }> {
  const deadline = started + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const localP = new Map(localRank(req).ranked.map(r => [r.id, r.p]))
  const entries: Entry[] = req.items.map((item, index) => ({ item, index, local: localP.get(item.id) ?? 0 }))
  let pool = entries.length > MAX_JEV_ITEMS ? [...entries].sort((a, b) => b.local - a.local || a.index - b.index).slice(0, MAX_JEV_ITEMS) : entries
  // too many options for one choice: rank chunks, then rank the winners
  for (let groups = chunk(pool); groups.length > 1; groups = chunk(pool)) {
    const results = await Promise.all(groups.map(group => ask(req, group, false, deps, deadline, usage)))
    const failed = results.find(r => !r.ok)
    if (failed && !failed.ok) return { error: failed.error }
    pool = groups.flatMap((group, i) => { const r = results[i]; return r.ok ? blend(group, r.jev).slice(0, WINNERS_PER_CHUNK).map(b => b.entry) : [] })
      .sort((a, b) => a.index - b.index)
  }
  const final = await ask(req, pool, req.task === 'library', deps, deadline, usage)
  if (!final.ok) return { error: final.error }
  const jevP = new Map(pool.map((e, i) => [e.item.id, final.jev[i]]))
  const p = normalize(entries.map(e => JEV_WEIGHT * (jevP.get(e.item.id) ?? 0) + (1 - JEV_WEIGHT) * e.local))
  const ranked = entries.map((e, i) => ({ id: e.item.id, p: p[i], index: e.index }))
    .sort((a, b) => b.p - a.p || a.index - b.index).map(({ id, p }) => ({ id, p }))
  const pick = final.data.answers.pick, exists = final.data.answers.exists
  const sure = pick.type === 'choice' && pick.choice !== NONE && pick.confidence >= .5
  const found = !exists || exists.type !== 'noul' || exists.noul >= .5
  return { ranked, confident: isConfident(ranked) && sure && found, source: 'jev', model: final.data.model, ms: Date.now() - started }
}

/** Jev when a key is present (blended with the local score), else the local ranker. Never throws. */
export async function rankItems(req: RankRequest, deps: RankDeps = {}): Promise<RankResult> {
  const started = Date.now()
  const seen = new Set<string>()
  const items = (req.items ?? []).filter(item => item && typeof item.id === 'string' && !seen.has(item.id) && seen.add(item.id))
  const clean: RankRequest = { ...req, query: String(req.query ?? '').slice(0, 2000), items }
  const local = (note: string) => ({ ...localRank(clean), ms: Date.now() - started, note })
  if (!items.length) return local('no items')
  if (!deps.key) return local('jev not configured')
  const usage: RankUsage = { calls: 0, inputTokens: 0 }
  try {
    const result = await rankWithJev(clean, { ...deps, key: deps.key }, started, usage)
    return 'error' in result ? local(result.error) : result
  } catch {
    return local('Jev could not be used.')
  } finally {
    if (usage.calls) try { deps.onUsage?.(usage) } catch { /* counters only */ }
  }
}

export type RankRouteDeps = Omit<RankDeps, 'key'> & { readKey: () => Promise<string | undefined>; limiter?: RateLimiter; authorize?: (req: Request) => boolean }

/** POST /api/rank, guarded like the other api routes even when mounted behind the auth gate. */
export function registerRankRoute(app: Pick<Express, 'post'>, deps: RankRouteDeps) {
  const limiter = deps.limiter ?? new RateLimiter(60, 60_000)
  const allowed = deps.authorize ?? authorized
  app.post('/api/rank', async (req, res) => {
    if (!sameOrigin(req) || req.headers['x-marginalia'] !== '1') { res.status(403).json({ error: 'Use the app controls to make this request.' }); return }
    if (!allowed(req)) { res.status(401).json({ error: 'Pair this device using the six-digit code shown on the laptop.', code: 'pairing_required' }); return }
    const parsed = rankRequestSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'The ranking request is incomplete or too large.' }); return }
    if (!limiter.take(accessToken(req))) { res.status(429).json({ error: 'Please wait a moment before ranking more items.' }); return }
    let key: string | undefined
    try { key = await deps.readKey() } catch { key = undefined }
    try { res.json(await rankItems(parsed.data, { ...deps, key })) }
    catch { res.json({ ...localRank(parsed.data), note: 'Jev could not be used.' }) }
  })
}
