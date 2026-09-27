import express from 'express'
import OpenAI from 'openai'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { z } from 'zod'
import { contextSchema, requestSchema, withPlacementOptions, type CommandRequest } from './board-tools'
import { DEFAULT_TEXT_MODEL } from './model-config'
import { runBoardCommand, repairBoardCommand, repairRequestSchema, type CommandRecoveryOptions } from './command-repair'
import { classifyCommandFailure, CommandRecoveryError, publicCommandError } from './command-retry'
import { createOpenAIImageProvider, DEFAULT_IMAGE_MODEL, ImageJobError, ImageJobManager } from './image-generation'
import { configuredLimit, UsageLedger, UsageLedgerError } from './usage-ledger'
import { accessToken, attemptPairing, authorized, blockedPath, claimVoiceSlot, createVoiceLimiter, DEV_ALLOWED_HOSTS, grantAccess, isLocalBrowser, pairingCode, RateLimiter, sameOrigin } from './security'
import { realtimeConfig } from './realtime-config'
import { jevModel, readJevKey } from './jev'
import { rankItems, registerRankRoute, sharedJevBreaker, type RankUsage } from './rank'
import type { RankRequest } from '../shared/ranking'
import type { PlacementOption } from '../shared/board'
import { audioTranscriptionRequestSchema, createOpenAIAudioTranscriber, transcribeRecoveredAudio } from './audio-transcription'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = express()
const httpServer = createServer(app)
const port = Number(process.env.PORT || 3000)
const textModel = process.env.OPENAI_TEXT_MODEL || DEFAULT_TEXT_MODEL
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini'
const imageModel = process.env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL
const MAX_SESSION_MS = 5 * 60 * 1000
const MAX_VOICE_SECONDS = configuredLimit(process.env.OPENAI_VOICE_MINUTES_LIMIT, 180, 1440) * 60
const MAX_COMMANDS = configuredLimit(process.env.OPENAI_COMMAND_LIMIT, 200, 1_000_000)
const MAX_IMAGES = configuredLimit(process.env.OPENAI_IMAGE_LIMIT, 20, 1000)
const usagePath = path.join(root, '.local', 'usage.json')
const usage = await UsageLedger.open(usagePath)
if (!usage.snapshot()) console.warn('Saved usage counters are unreadable. Paid requests are disabled; existing counters have not been reset.')
// jev calls are counted apart from the paid OpenAI ledger
const jevUsagePath = path.join(root, '.local', 'jev-usage.json')
const jevUsage = { calls: 0, inputTokens: 0 }
try {
  const saved = JSON.parse(await readFile(jevUsagePath, 'utf8'))
  if (Number.isFinite(saved?.calls)) jevUsage.calls = saved.calls
  if (Number.isFinite(saved?.inputTokens)) jevUsage.inputTokens = saved.inputTokens
} catch { /* first launch */ }
let jevWrites = Promise.resolve()
function persistJevUsage() {
  jevWrites = jevWrites.then(async () => { await mkdir(path.dirname(jevUsagePath), { recursive: true }); await writeFile(jevUsagePath, JSON.stringify(jevUsage, null, 2)) }).catch(() => console.warn('Could not save Jev usage counters.'))
}

async function readKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try { return (await readFile(path.join(root, 'api.txt'), 'utf8')).match(/sk-[A-Za-z0-9_-]+/)?.[0] } catch { return undefined }
}
function sendFailure(res: express.Response, error: unknown) {
  if (res.destroyed || res.writableEnded) return
  if (error instanceof UsageLedgerError || error instanceof ImageJobError) {
    res.status(error.status).json({ error: error.message, code: error.code, retryable: false }); return
  }
  const safe = publicCommandError(error)
  const status = safe.code === 'invalid_request' ? 400 : safe.code.startsWith('local_') || safe.code === 'quota' ? 429 : safe.code === 'authentication' ? 502 : safe.code === 'usage_unavailable' ? 503 : 502
  res.status(status).json({ error: safe.message, code: safe.code, retryable: safe.retryable })
}
function requestLifetime(res: express.Response) {
  const controller = new AbortController()
  const disconnect = () => { if (!res.writableEnded) controller.abort(new DOMException('Browser disconnected.', 'AbortError')) }
  res.on('close', disconnect)
  if (res.destroyed && !res.writableEnded) disconnect()
  return { signal: controller.signal, dispose: () => res.off('close', disconnect) }
}
const imageJobs = new ImageJobManager({
  model: imageModel, limit: MAX_IMAGES, provider: createOpenAIImageProvider(readKey),
  reserve: async (_owner, request) => {
    try { await usage.reserveImage(request.requestId, MAX_IMAGES) }
    catch (error) { if (error instanceof UsageLedgerError) throw new ImageJobError(error.code, error.message, error.status); throw error }
  },
})

app.disable('x-powered-by')
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  if (blockedPath(req.originalUrl)) { res.status(404).end(); return }
  next()
})
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
app.use(express.json({ limit: '2300kb' }))

app.get('/api/status', async (req, res) => {
  if (!sameOrigin(req)) { res.status(403).json({ error: 'Use this application from its own tab.' }); return }
  const local = isLocalBrowser(req)
  if (local && !authorized(req)) grantAccess(req, res)
  const allowed = local || authorized(req)
  res.json({
    configured: Boolean(await readKey()), authorized: allowed, pairingRequired: !allowed,
    jev: { configured: Boolean(await readJevKey(root)), model: jevModel() },
    ...(local ? { pairingCode } : {}), models: { text: textModel, realtime: realtimeModel, image: imageModel },
    limits: { sessionMinutes: 5, inactivitySeconds: 90, commandLimit: MAX_COMMANDS, voiceMinutesLimit: MAX_VOICE_SECONDS / 60, imageLimit: MAX_IMAGES },
    ...(allowed ? { usage: { ...usage.snapshot(), available: Boolean(usage.snapshot()), images: imageJobs.getUsage(), jevCalls: jevUsage.calls, jevInputTokens: jevUsage.inputTokens, note: 'Cumulative local usage counters, not a dollar balance. OpenAI billing is authoritative.' } } : {}),
  })
})

const pairLimiter = new RateLimiter(10, 10 * 60_000)
const apiLimiter = new RateLimiter(15, 60_000)
const voiceLimiter = createVoiceLimiter()
const imageLimiter = new RateLimiter(15, 60_000)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && (!sameOrigin(req) || req.headers['x-marginalia'] !== '1')) {
    res.status(403).json({ error: 'Use the app controls to make this request.', code: 'origin_required', retryable: false }); return
  }
  next()
})
app.post('/api/pair', (req, res) => {
  const attempt = attemptPairing(req, pairLimiter)
  if (attempt.rotated) console.log(`Too many wrong pairing codes, so the code changed. New iPad pairing code: ${pairingCode}`)
  if (attempt.status !== 200) { res.status(attempt.status).json({ error: attempt.error }); return }
  grantAccess(req, res); res.json({ ok: true })
})
app.use('/api', (req, res, next) => {
  if (!authorized(req)) { res.status(401).json({ error: 'Pair this device using the six-digit code shown on the laptop.', code: 'pairing_required', retryable: false }); return }
  next()
})

function countJev({ calls, inputTokens }: RankUsage) {
  jevUsage.calls += calls; jevUsage.inputTokens += inputTokens; persistJevUsage()
}
// ranks placement or library candidates inside a command, with a short budget so a slow Jev never holds it up
async function rankForCommand(req: RankRequest, timeoutMs = 1500) {
  return rankItems(req, { key: await readJevKey(root), timeoutMs, onUsage: countJev, breaker: sharedJevBreaker })
}
// the route waits at most 2 s for Jev and shares its failure pause with the command ranking above
registerRankRoute(app, { readKey: () => readJevKey(root), onUsage: countJev, timeoutMs: 2000, breaker: sharedJevBreaker })

for (const mode of ['command', 'repair'] as const) app.post(`/api/${mode}`, async (req, res) => {
  const parsed = (mode === 'command' ? requestSchema : repairRequestSchema).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'The board request is incomplete or too large.', code: 'invalid_request', retryable: false }); return }
  if (!apiLimiter.take(accessToken(req))) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Please wait a moment before sending more commands.', code: 'local_rate_limit', retryable: true }); return }
  const key = await readKey()
  if (!key) { res.status(503).json({ error: 'Add your OpenAI API key to api.txt on the laptop.', code: 'missing_key', retryable: false }); return }
  const lifetime = requestLifetime(res)
  try {
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 20_000 })
    const options: CommandRecoveryOptions = {
      model: textModel, signal: lifetime.signal,
      createResponse: async (params, options) => {
        options.signal.throwIfAborted()
        try { await usage.reserveCommand(MAX_COMMANDS) }
        catch (error) { if (error instanceof UsageLedgerError) throw new CommandRecoveryError(error.message, error.code); throw error }
        options.signal.throwIfAborted()
        const response = await client.responses.create(params, { ...options, maxRetries: 0 })
        if (response.usage) {
          try { await usage.recordTokens(response.usage.input_tokens, response.usage.output_tokens) }
          catch (error) { if (error instanceof UsageLedgerError) throw new CommandRecoveryError(error.message, error.code); throw error }
        }
        return response
      },
    }
    // placement candidates are ranked (Jev or local, 1.5 s budget) into options A, B, C inside this same request
    let placementOptions: PlacementOption[] | undefined
    let input: unknown = parsed.data
    if (mode === 'command') {
      const placed = await withPlacementOptions(parsed.data as CommandRequest, rankRequest => rankForCommand(rankRequest))
      input = placed.input; placementOptions = placed.placementOptions
    }
    const result = await (mode === 'command' ? runBoardCommand(input, options) : repairBoardCommand(parsed.data, options))
    if (!lifetime.signal.aborted && !res.destroyed) res.json(placementOptions ? { ...result, placementOptions } : result)
  } catch (error) { sendFailure(res, error) }
  finally { lifetime.dispose() }
})

app.post('/api/realtime/transcribe', async (req, res) => {
  const parsed = audioTranscriptionRequestSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'That audio could not be read. Repeat a short phrase or type it.', code: 'invalid_request', retryable: false }); return }
  if (!apiLimiter.take(accessToken(req))) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Please wait a moment before retrying transcription.', code: 'local_rate_limit', retryable: true }); return }
  const key = await readKey()
  if (!key) { res.status(503).json({ error: 'Add your OpenAI API key to api.txt on the laptop.', code: 'missing_key', retryable: false }); return }
  const lifetime = requestLifetime(res)
  try {
    const result = await transcribeRecoveredAudio(parsed.data, {
      provider: createOpenAIAudioTranscriber(key), signal: lifetime.signal,
      reserve: () => usage.reserveCommand(MAX_COMMANDS),
      recordTokens: (input, output) => usage.recordTokens(input, output),
    })
    if (!lifetime.signal.aborted && !res.destroyed) res.json(result)
  } catch (error) { sendFailure(res, error) }
  finally { lifetime.dispose() }
})

app.post('/api/images', async (req, res) => {
  if (!imageLimiter.take(accessToken(req))) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Wait before confirming another image request.', code: 'local_rate_limit', retryable: true }); return }
  if (!await readKey()) { res.status(503).json({ error: 'Add an OpenAI API key on the laptop.', code: 'missing_key', retryable: false }); return }
  try { res.status(202).json(await imageJobs.submit(accessToken(req), req.body)) }
  catch (error) { sendFailure(res, error) }
})
app.get('/api/images/:id', (req, res) => {
  const id = req.params.id
  const job = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id) ? imageJobs.get(accessToken(req), id) : null
  if (!job) { res.status(404).json({ error: 'This image request was not found for this device.', code: 'image_not_found', retryable: false }); return }
  res.json(job)
})

type LiveCall = { owner: string; tab?: string; started: number; reserved: number; timeout: NodeJS.Timeout; key: string; closing?: Promise<boolean> }
const calls = new Map<string, LiveCall>()
const pendingOwners = new Set<string>()
async function closeCall(id: string): Promise<boolean> {
  const call = calls.get(id)
  if (!call) return true
  if (call.closing) return call.closing
  clearTimeout(call.timeout)
  call.closing = (async () => {
    try {
      const closed = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(id)}/hangup`, {
        method: 'POST', headers: { Authorization: `Bearer ${call.key}` }, signal: AbortSignal.timeout(8000),
      })
      if (!closed.ok && closed.status !== 404 && closed.status !== 410) return false
      calls.delete(id)
      // Count through confirmed closure, including hangup latency. Never reclaim on an uncertain close.
      const elapsed = Math.max(0, Math.ceil((Date.now() - call.started) / 1000))
      try { await usage.settleVoice(call.reserved, elapsed) }
      catch { console.warn('Voice closed, but usage could not be settled. Paid requests remain disabled.') }
      return true
    } catch { return false }
    finally {
      call.closing = undefined
      if (calls.has(id)) {
        call.timeout = setTimeout(() => { void closeCall(id) }, 8000)
        call.timeout.unref()
      }
    }
  })()
  return call.closing
}
const voiceRequest = z.object({ sdp: z.string().min(20).max(40_000), context: contextSchema, spokenReplies: z.boolean().optional(), tab: z.string().max(100).optional() })
app.post('/api/realtime/session', async (req, res) => {
  const parsed = voiceRequest.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'The voice session request is incomplete.', code: 'invalid_request', retryable: false }); return }
  const owner = accessToken(req)
  const refusal = await claimVoiceSlot(owner, {
    starting: pendingOwners, close: closeCall, limiter: voiceLimiter,
    callsOf: who => [...calls].filter(([, call]) => call.owner === who).map(([id, call]) => ({ id, tab: call.tab })),
  }, parsed.data.tab)
  if (refusal) {
    if (res.destroyed) return
    if (refusal.retryAfter) res.setHeader('Retry-After', refusal.retryAfter)
    res.status(refusal.status).json(refusal.body); return
  }
  const key = await readKey()
  if (!key) { pendingOwners.delete(owner); res.status(503).json({ error: 'Add your OpenAI API key to api.txt on the laptop.', code: 'missing_key', retryable: false }); return }
  const lifetime = requestLifetime(res)
  let reservation = 0, started = 0
  try {
    reservation = await usage.reserveVoice(MAX_SESSION_MS / 1000, MAX_VOICE_SECONDS)
    if (lifetime.signal.aborted) { await usage.settleVoice(reservation, 0); return }
    const form = new FormData()
    form.set('sdp', parsed.data.sdp)
    form.set('session', JSON.stringify(realtimeConfig(parsed.data.context, parsed.data.spokenReplies !== false, realtimeModel)))
    started = Date.now()
    const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]),
    })
    if (!upstream.ok) {
      await usage.settleVoice(reservation, 0); reservation = 0
      const data = await upstream.json().catch(() => ({})) as { error?: { code?: string; type?: string; message?: string } }
      const failure = { status: upstream.status, headers: upstream.headers, error: data.error }
      const classification = classifyCommandFailure(failure)
      const safe = publicCommandError(failure)
      if (classification.retryAfterMs !== undefined) res.setHeader('Retry-After', String(Math.ceil(classification.retryAfterMs / 1000)))
      if (!res.destroyed) res.status(classification.code === 'rate_limit' || classification.code === 'quota' ? 429 : 502).json({ error: safe.message, code: classification.code, retryable: classification.retryable })
      return
    }
    const sessionId = upstream.headers.get('location')?.split('/').pop()
    if (!sessionId || !/^rtc_[A-Za-z0-9_-]+$/.test(sessionId)) {
      // No trustworthy ID to hang up: preserve the allowance instead of assuming no charge.
      if (!res.destroyed) res.status(502).json({ error: 'OpenAI returned an incomplete voice session. Its allowance remains reserved.', code: 'invalid_voice_session', retryable: false })
      return
    }
    const timeout = setTimeout(() => { void closeCall(sessionId) }, Math.max(1, reservation * 1000 - (Date.now() - started)))
    timeout.unref()
    calls.set(sessionId, { owner, tab: parsed.data.tab, started, reserved: reservation, timeout, key })
    try {
      const sdp = await upstream.text()
      if (lifetime.signal.aborted || res.destroyed) { await closeCall(sessionId); return }
      res.json({ sdp, sessionId, maxDurationSeconds: Math.max(1, Math.floor((reservation * 1000 - (Date.now() - started)) / 1000)) })
    } catch (error) { await closeCall(sessionId); throw error }
  } catch (error) {
    // A timed-out network call can have reached the provider. Keep its reservation,
    // unless the laptop could not reach the provider at all.
    const code = (error as { cause?: { code?: string } })?.cause?.code ?? ''
    if (reservation && (!started || ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code))) await usage.settleVoice(reservation, 0).catch(() => {})
    sendFailure(res, error)
  } finally { pendingOwners.delete(owner); lifetime.dispose() }
})
app.post('/api/realtime/stop', async (req, res) => {
  const id = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
  if (calls.get(id)?.owner === accessToken(req) && !await closeCall(id)) {
    res.status(502).json({ error: 'Voice shutdown is still being retried. The microphone is paused; unused allowance will be released after the provider confirms closure.', code: 'voice_close_pending', retryable: true }); return
  }
  res.json({ ok: true })
})
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API endpoint.' }) })

if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')))
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root, server: { middlewareMode: true, hmr: { server: httpServer }, allowedHosts: DEV_ALLOWED_HOSTS,
      fs: { deny: ['**/api.txt', '**/jev.txt', '**/.env', '**/.env.*', '**/.git/**', '**/.local/**', '**/server/**', '**/*.{crt,pem,key}'] },
    }, appType: 'spa',
  })
  app.use(vite.middlewares)
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error instanceof SyntaxError ? 'The request could not be read.' : 'The request could not be completed.', code: 'invalid_request', retryable: false })
})
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Chalkpal is ready at http://localhost:${port}`)
  console.log(`iPad pairing code: ${pairingCode}. Voice segments last up to 5 minutes; configured voice allowance is ${MAX_VOICE_SECONDS / 60} minutes.`)
})
process.on('SIGINT', () => {
  imageJobs.dispose(); httpServer.close()
  void Promise.allSettled([...calls.keys()].map(closeCall)).then(() => usage.flush()).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
})
