// Explicit, manual diagnostic. Validates configuration; never starts media or prints credentials.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { realtimeConfig } from './realtime-config'

const key = process.env.OPENAI_API_KEY || (await readFile(fileURLToPath(new URL('../api.txt', import.meta.url)), 'utf8')).match(/sk-[A-Za-z0-9_-]+/)?.[0]
if (!key) throw new Error('No API key is configured.')
const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 60 }, session: realtimeConfig({
    focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 },
  }) }), signal: AbortSignal.timeout(20_000),
})
const data = await response.json() as { session?: { model?: string }; error?: { code?: string; message?: string } }
console.log(JSON.stringify({ status: response.status, model: data.session?.model,
  ...(response.ok ? { result: 'Realtime configuration accepted. No audio session started.' } : { error: data.error?.code, message: data.error?.message?.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') }),
}))
if (!response.ok) process.exitCode = 1
