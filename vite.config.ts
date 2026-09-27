import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Serve the package's fonts locally in development and include them in production. */
function excalidrawFonts(): Plugin {
  const root = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url))
  let base = '/'
  let fonts: Map<string, string>
  async function fontFiles() {
    if (!fonts) {
      fonts = new Map()
      for (const family of await readdir(root, { withFileTypes: true })) {
        if (!family.isDirectory()) continue
        for (const file of await readdir(`${root}${family.name}`)) {
          if (file.endsWith('.woff2')) fonts.set(`excalidraw/fonts/${family.name}/${file}`, `${root}${family.name}/${file}`)
        }
      }
    }
    return fonts
  }
  return {
    name: 'excalidraw-local-fonts',
    configResolved(config) { base = config.base },
    async configureServer(server) {
      const files = await fontFiles()
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const pathname = new URL(req.url || '/', 'http://localhost').pathname
        const file = files.get(pathname.slice(base.length))
        if (!pathname.startsWith(base) || !file) return next()
        try {
          const data = await readFile(file)
          res.setHeader('Content-Type', 'font/woff2')
          res.setHeader('Content-Length', data.length)
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.end(req.method === 'HEAD' ? undefined : data)
        } catch (error) { next(error) }
      })
    },
    async generateBundle() {
      for (const [fileName, path] of await fontFiles()) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(path) })
      }
    },
  }
}

export default defineConfig({ plugins: [react(), excalidrawFonts()], server: { host: '127.0.0.1' }, build: { chunkSizeWarningLimit: 1800 } })
