import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export default defineConfig({ plugins: [react(), pdfjsAssets()], server: { host: '127.0.0.1' }, build: { chunkSizeWarningLimit: 1800 } })
