// temporary, account-free iPad https preview on any platform; no service and no autostart
// usage: node server/start-tunnel.mjs (set PORT when the app does not run on 3000)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.local')
const port = Number(process.env.PORT || 3000)
const windows = process.platform === 'win32'

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be a port number, not "${process.env.PORT}".`)
mkdirSync(dir, { recursive: true })
const saved = path.join(dir, windows ? 'cloudflared.exe' : 'cloudflared')
const binary = existsSync(saved) ? saved : 'cloudflared'
const log = path.join(dir, `tunnel-${Date.now()}.log`)
const output = openSync(log, 'a')
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
  cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output, output],
})
let exited = false
tunnel.on('error', () => fail('cloudflared was not found. Install it or save it in .local, then try again. See the README.'))
tunnel.on('exit', () => { exited = true })

let url = null
for (let attempt = 0; attempt < 40 && !url; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 500))
  if (exited) fail(`The tunnel exited. Inspect ${log}`)
  url = readFileSync(log, 'utf8').match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/)?.[0] ?? null
}
if (!url) {
  tunnel.kill()
  fail('No preview URL was returned within 20 seconds.')
}
writeFileSync(path.join(dir, 'preview-host.txt'), new URL(url).host)
tunnel.unref()
console.log(`iPad URL: ${url}`)
console.log(`Tunnel PID: ${tunnel.pid}. Stop it with: ${windows ? `Stop-Process -Id ${tunnel.pid}` : `kill ${tunnel.pid}`}`)
console.log(`Start the app with npm run dev (PORT ${port}) if it is not running yet. Get the pairing code from Help on the laptop.`)
process.exit(0)
