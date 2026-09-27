import express from 'express'
import OpenAI from 'openai'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { z } from 'zod'
import { boardTools, commandSchema, contextInstructions, contextSchema, requestSchema } from './board-tools'
import { accessToken, authorized, blockedPath, grantAccess, isLocalBrowser, pairingCode, RateLimiter, sameOrigin, validPairCode } from './security'
import { realtimeConfig } from './realtime-config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = express()
const httpServer = createServer(app)
const port = Number(process.env.PORT || 3000)
const textModel = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini'
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini'
const MAX_SESSION_MS = 5 * 60 * 1000
const MAX_VOICE_SECONDS = 30 * 60
const MAX_COMMANDS = 200
const usagePath = path.join(root, '.local', 'usage.json')
let previewHost: string | undefined
try {
  const candidate = (await readFile(path.join(root, '.local', 'preview-host.txt'), 'utf8')).trim()
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(candidate)) previewHost = candidate
} catch { /* No temporary iPad preview is running. */ }
let usage = { commands: 0, inputTokens: 0, outputTokens: 0, voiceSecondsReserved: 0 }
try { usage = { ...usage, ...JSON.parse(await readFile(usagePath, 'utf8')) } } catch { /* First launch. */ }
let writeQueue = Promise.resolve()
function persistUsage() {
  writeQueue = writeQueue.then(async () => { await mkdir(path.dirname(usagePath), { recursive: true }); await writeFile(usagePath, JSON.stringify(usage, null, 2)) }).catch(() => console.warn('Could not save usage counters.'))
}

async function readKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try { return (await readFile(path.join(root, 'api.txt'), 'utf8')).match(/sk-[A-Za-z0-9_-]+/)?.[0] } catch { return undefined }
}
function friendlyError(error: unknown) {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return 'The hackathon API key is invalid or expired. Replace api.txt with an active key.'
    if (error.status === 429) return 'OpenAI reports a rate or credit limit. Wait briefly or check the project balance.'
    if (error.status === 403 || error.status === 404) return 'This OpenAI project cannot access the selected model.'
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'The AI request timed out. Please try again.' : 'The AI request could not finish. Please try again.'
}

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
    ...(local ? { pairingCode } : {}), models: { text: textModel, realtime: realtimeModel },
    limits: { sessionMinutes: 5, inactivitySeconds: 90, commandLimit: MAX_COMMANDS, voiceMinutesLimit: MAX_VOICE_SECONDS / 60 },
    ...(allowed ? { usage: { ...usage, note: 'Local usage counters, not a dollar balance. OpenAI billing is authoritative.' } } : {}),
  })
})

const pairLimiter = new RateLimiter(10, 10 * 60_000)
const apiLimiter = new RateLimiter(15, 60_000)
const voiceLimiter = new RateLimiter(6, 10 * 60_000)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && (!sameOrigin(req) || req.headers['x-marginalia'] !== '1')) {
    res.status(403).json({ error: 'Use the app controls to make this request.' }); return
  }
  next()
})
app.post('/api/pair', (req, res) => {
  const address = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'remote')
  // A global bucket also limits spoofed proxy headers.
  if (!pairLimiter.take('all') || !pairLimiter.take(address)) { res.status(429).json({ error: 'Too many pairing attempts. Try again in ten minutes.' }); return }
  if (!validPairCode(req.body?.code)) { res.status(401).json({ error: 'That pairing code is not correct. Check the code on the laptop.' }); return }
  grantAccess(req, res); res.json({ ok: true })
})
app.use('/api', (req, res, next) => {
  if (!authorized(req)) { res.status(401).json({ error: 'Pair this device using the six-digit code shown on the laptop.', code: 'pairing_required' }); return }
  next()
})

app.post('/api/command', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'The board request is incomplete or too large.' }); return }
  if (!apiLimiter.take(accessToken(req))) { res.status(429).json({ error: 'Please wait a moment before sending more commands.' }); return }
  if (usage.commands >= MAX_COMMANDS) { res.status(429).json({ error: 'The prototype command allowance has been reached. Check OpenAI billing before increasing it.' }); return }
  const key = await readKey()
  if (!key) { res.status(503).json({ error: 'Add your OpenAI API key to api.txt on the laptop.' }); return }
  usage.commands++; persistUsage()
  try {
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 25_000 })
    const response = await client.responses.create({
      model: textModel, instructions: contextInstructions(parsed.data.context),
      input: [...(parsed.data.history ?? []).slice(-8).map(m => ({ role: m.role, content: m.text })), {
        role: 'user', content: parsed.data.image ? [
          { type: 'input_text', text: parsed.data.text },
          { type: 'input_image', image_url: parsed.data.image, detail: 'low' },
        ] : parsed.data.text,
      }],
      tools: [{ ...boardTools[0], strict: false }],
      tool_choice: { type: 'function', name: 'apply_board_operations' },
      parallel_tool_calls: false, max_output_tokens: 1500, store: false,
    })
    usage.inputTokens += response.usage?.input_tokens ?? 0
    usage.outputTokens += response.usage?.output_tokens ?? 0
    persistUsage()
    const call = response.output.find(o => o.type === 'function_call' && o.name === 'apply_board_operations')
    if (!call || call.type !== 'function_call') { res.status(502).json({ error: 'The assistant did not produce a complete board edit. Try rephrasing.' }); return }
    const command = commandSchema.safeParse(JSON.parse(call.arguments))
    if (!command.success) { res.status(502).json({ error: 'The assistant returned an invalid board edit. Try a shorter instruction.' }); return }
    res.json(command.data)
  } catch (error) { res.status(502).json({ error: friendlyError(error) }) }
})

type LiveCall = { owner: string; started: number; timeout: NodeJS.Timeout; key: string }
const calls = new Map<string, LiveCall>()
const pendingOwners = new Set<string>()
async function closeCall(id: string) {
  const call = calls.get(id)
  if (!call) return
  calls.delete(id); clearTimeout(call.timeout)
  const elapsed = Math.min(MAX_SESSION_MS / 1000, Math.ceil((Date.now() - call.started) / 1000))
  usage.voiceSecondsReserved = Math.max(0, usage.voiceSecondsReserved - (MAX_SESSION_MS / 1000 - elapsed)); persistUsage()
  try {
    await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(id)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${call.key}` }, signal: AbortSignal.timeout(8000),
    })
  } catch { /* Closing the browser peer also terminates its media session. */ }
}
const voiceRequest = z.object({ sdp: z.string().min(20).max(40_000), context: contextSchema, spokenReplies: z.boolean().optional() })
app.post('/api/realtime/session', async (req, res) => {
  const parsed = voiceRequest.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'The voice session request is incomplete.' }); return }
  const owner = accessToken(req)
  if (!voiceLimiter.take(owner)) { res.status(429).json({ error: 'Please wait before opening another voice session.' }); return }
  if (pendingOwners.has(owner) || [...calls.values()].some(call => call.owner === owner)) { res.status(409).json({ error: 'Stop your existing voice session before starting another.' }); return }
  if (usage.voiceSecondsReserved + MAX_SESSION_MS / 1000 > MAX_VOICE_SECONDS) { res.status(429).json({ error: 'The 30-minute prototype voice allowance has been used. Check billing before increasing it.' }); return }
  const key = await readKey()
  if (!key) { res.status(503).json({ error: 'Add your OpenAI API key to api.txt on the laptop.' }); return }
  pendingOwners.add(owner)
  usage.voiceSecondsReserved += MAX_SESSION_MS / 1000; persistUsage()
  try {
    const form = new FormData()
    form.set('sdp', parsed.data.sdp)
    form.set('session', JSON.stringify(realtimeConfig(parsed.data.context, parsed.data.spokenReplies !== false, realtimeModel)))
    const upstream = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(25_000) })
    if (!upstream.ok) {
      usage.voiceSecondsReserved -= MAX_SESSION_MS / 1000; persistUsage()
      const data = await upstream.json().catch(() => ({})) as { error?: { code?: string } }
      const message = upstream.status === 401 ? 'The hackathon API key is invalid or expired.' : upstream.status === 429 ? 'OpenAI reports a voice rate or credit limit. Check the project balance.' : `OpenAI could not start voice (${upstream.status}${data.error?.code ? `, ${data.error.code}` : ''}). Typed commands remain available.`
      res.status(502).json({ error: message }); return
    }
    const sdp = await upstream.text()
    const sessionId = upstream.headers.get('location')?.split('/').pop()
    if (!sessionId || !/^rtc_[A-Za-z0-9_-]+$/.test(sessionId)) {
      // A timer still closes the browser at five minutes; retain the usage reservation.
      res.status(502).json({ error: 'OpenAI returned an incomplete session. Please try voice again.' }); return
    }
    const timeout = setTimeout(() => { void closeCall(sessionId) }, MAX_SESSION_MS)
    calls.set(sessionId, { owner, started: Date.now(), timeout, key })
    res.json({ sdp, sessionId, maxDurationSeconds: MAX_SESSION_MS / 1000 })
  } catch {
    usage.voiceSecondsReserved -= MAX_SESSION_MS / 1000; persistUsage()
    res.status(502).json({ error: 'Voice could not connect. Check your connection, then try again.' })
  } finally { pendingOwners.delete(owner) }
})
app.post('/api/realtime/stop', async (req, res) => {
  const id = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
  if (calls.get(id)?.owner === accessToken(req)) await closeCall(id)
  res.json({ ok: true })
})
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API endpoint.' }) })

if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')))
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root, server: { middlewareMode: true, hmr: { server: httpServer }, allowedHosts: previewHost ? [previewHost] : [],
      fs: { deny: ['**/api.txt', '**/.env', '**/.env.*', '**/.git/**', '**/.local/**', '**/server/**', '**/*.{crt,pem,key}'] },
    }, appType: 'spa',
  })
  app.use(vite.middlewares)
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error instanceof SyntaxError ? 'The request could not be read.' : 'The request could not be completed.' })
})
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Magic Whiteboard is ready at http://localhost:${port}`)
  console.log(`iPad pairing code: ${pairingCode}. Voice stops after 5 minutes or 90 seconds of inactivity.`)
})
process.on('SIGINT', () => { for (const id of calls.keys()) void closeCall(id); httpServer.close(); setTimeout(() => process.exit(0), 1000).unref() })
