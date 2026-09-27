import { readdir, readFile } from 'node:fs/promises'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
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

// pdf.js fetches cmaps, standard fonts, color profiles and image decoders by URL at runtime.
// Serve them under /pdfjs in development and copy them into the production build.
function pdfjsAssets(): Plugin {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', 'pdfjs-dist')
  const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const [folder, file, extra] = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
        if (!folders.includes(folder) || !file || extra || !/^[\w.-]+$/.test(file)) return next()
        const target = path.join(base, folder, file)
        try { if (!statSync(target).isFile()) return next() } catch { return next() }
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        createReadStream(target).pipe(res)
      })
    },
    generateBundle() {
      for (const folder of folders) for (const file of readdirSync(path.join(base, folder))) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${file}`, source: readFileSync(path.join(base, folder, file)) })
      }
    },
  }
}

export default defineConfig({ plugins: [react(), excalidrawFonts(), pdfjsAssets()], server: { host: '127.0.0.1' }, build: { chunkSizeWarningLimit: 1800 } })
