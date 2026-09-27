import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { autoYRange, realPow, samplePlot, validateExpression } from '../src/board/expression'
import { mathFieldLatex, validateLatex } from '../src/board/latex'
import { grownTextHeight, woff2FontsOnly, type MagicShape } from '../src/board/MagicShape'

const at = (expression: string, x: number) => validateExpression(expression).evaluate(x)

describe('graph functions', () => {
  it('plots odd roots of negative numbers', () => {
    expect(at('x^(1/3)', -8)).toBeCloseTo(-2)
    expect(at('x^(2/3)', -8)).toBeCloseTo(4)
    expect(at('cbrt(x)', -27)).toBeCloseTo(-3)
    expect(at('pow(x, 1/5)', -32)).toBeCloseTo(-2)
    expect(at('x^0.5', -4)).toBeNaN()
    expect(realPow(-2, 3)).toBe(-8)
    expect(realPow(2, 101)).toBeNaN()
    // the whole cube root curve is drawn, not only x >= 0
    const [yMin, yMax] = autoYRange('x^(1/3)', -8, 8)
    expect(yMin).toBeLessThan(-2)
    expect(samplePlot('x^(1/3)', -8, 8, yMin, yMax, 440, 320)[0].startsWith('M0.00,')).toBe(true)
  })

  it('knows sec, csc, cot, arcsin, arccos, arctan and |x|', () => {
    expect(at('sec(x)', 0)).toBeCloseTo(1)
    expect(at('csc(x)', Math.PI / 2)).toBeCloseTo(1)
    expect(at('cot(x)', Math.PI / 4)).toBeCloseTo(1)
    expect(at('arcsin(x)', 1)).toBeCloseTo(Math.PI / 2)
    expect(at('arccos(x)', 1)).toBeCloseTo(0)
    expect(at('arctan(x)', 1)).toBeCloseTo(Math.PI / 4)
    expect(validateExpression('|x|').expression).toBe('abs(x)')
    expect(at('|x - 2|', -1)).toBe(3)
    expect(at('||x|-1|', -3)).toBe(2)
    expect(validateExpression('y=|x|+|x-1|').evaluate(3)).toBe(5)
    // log stays the natural log; log10 is base 10
    expect(at('log(x)', Math.E)).toBeCloseTo(1)
    expect(at('log10(x)', 100)).toBeCloseTo(2)
  })
})

describe('visual math editor commits', () => {
  // [mf.value, mf.getValue('latex-expanded')] from MathLive in the running app
  const cases: [string, string, string][] = [
    ['2\\differentialD x', '2\\mathrm{d}x', '2\\mathrm{d}x'],
    ['\\int_{\\placeholder{}}^{\\placeholder{}}xdx', '\\int_{\\placeholder{}}^{\\placeholder{}}xdx', '\\int_{{}}^{{}}xdx'],
    ['f^{\\doubleprime}(x)=-f(x)+1', 'f^{\\doubleprime}(x)=-f(x)+1', 'f^{\\prime\\prime}(x)=-f(x)+1'],
    ['\\exponentialE^{x}', '\\mathrm{e}^{x}', '\\mathrm{e}^{x}'],
    ['\\imaginaryI', '\\imaginaryI', '\\mathrm{i}'],
    ['\\lim_{\\placeholder{}}', '\\lim_{\\placeholder{}}', '\\lim_{{}}'],
    // f'' typed on the board
    ['f^{\\prime}^{\\prime}(x)+1', 'f^{\\prime}^{\\prime}(x)+1', 'f^{\\prime\\prime}(x)+1'],
    ['y^{\\prime}^{\\prime}^{\\prime}=0', 'y^{\\prime}^{\\prime}^{\\prime}=0', 'y^{\\prime\\prime\\prime}=0'],
  ]
  it('valid LaTeX for every MathLive only command, so the edit is not lost', () => {
    for (const [value, expanded, committed] of cases) {
      expect(() => validateLatex(value)).toThrow()
      expect(mathFieldLatex(value, () => expanded)).toBe(committed)
      expect(() => validateLatex(committed)).not.toThrow()
    }
  })
  it('keeps valid source exactly as written', () => {
    const table = '\\begin{array}{|c|c|} \\hline x & y \\\\ \\hline 1 & 2 \\\\ \\hline \\end{array}+1'
    const expanded = vi.fn(() => '\\begin{array}{|c|c|}\\hline x & y\\\\ \\hline1 & 2\\\\ \\hline & \\placeholder{}\\end{array}+1')
    expect(mathFieldLatex(table, expanded)).toBe(table)
    expect(expanded).not.toHaveBeenCalled()
  })
})

describe('text boxes', () => {
  it('grow to show every line and never shrink', () => {
    expect(grownTextHeight(150, 196)).toBe(212)
    expect(grownTextHeight(150, 120)).toBeNull()
    expect(grownTextHeight(150, 0)).toBeNull()
    expect(grownTextHeight(150, 50_000)).toBe(10000)
  })
  it('export the same text inside the box', () => {
    const editor = new Editor()
    const controller = createBoardController(editor, () => ({ focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1400, h: 900 } }))
    const id = controller.applyOperations([{ type: 'create_text', text: 'Photosynthesis turns light into chemical energy.' }]).ids[0]
    return import('../src/board/MagicShape').then(async ({ magicShapeToSvg }) => {
      const html = renderToStaticMarkup(await magicShapeToSvg(editor.getShape<MagicShape>(id as MagicShape['id'])!))
      expect(html).toContain('Photosynthesis turns light into chemical energy.</div></div>')
    })
  })
})

// the test runner does not load stylesheets, so the math images read KaTeX's own file
vi.mock('katex/dist/katex.min.css?inline', async () => ({ default: (await import('node:fs')).readFileSync(`${process.cwd()}/node_modules/katex/dist/katex.min.css`, 'utf8') }))

describe('math fonts in images and exports', () => {
  const font = (url: string) => readFileSync(`${process.cwd()}/node_modules/katex/dist/fonts/${url.split('/').pop()}`)
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const shape = { id: 'shape:m', type: 'magic', props: { w: 400, h: 100, kind: 'math', latex: '\\Bigg( x \\Bigg)', text: '', title: '', color: '#111', fontSize: 28 }, meta: {} } as unknown as MagicShape
  function stubs(online: () => boolean) {
    const calls: string[] = []
    vi.stubGlobal('FileReader', class { result = ''; onload?: () => void; onerror?: () => void
      readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:font/woff2;base64,${Buffer.from(buffer).toString('base64')}`; this.onload?.() }) } })
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (!online()) throw new TypeError('Failed to fetch')
      return new Response(font(url))
    })
    return calls
  }

  it('embed only the woff2 fonts', async () => {
    const calls = stubs(() => true)
    const { magicShapeToSvg } = await import('../src/board/MagicShape')
    const svg = renderToStaticMarkup(await magicShapeToSvg(shape))
    expect(calls.length).toBe(20)
    expect(calls.every(url => url.endsWith('.woff2'))).toBe(true)
    expect(svg).not.toMatch(/format\("(woff|truetype)"\)/)
    expect(svg.match(/url\(data:font\/woff2;base64,/g)).toHaveLength(20)
    expect(svg.length).toBeLessThan(450_000)
    // every embedded font is whole base64
    for (const [, data] of svg.matchAll(/url\(data:font\/woff2;base64,([^)]*)\)/g)) expect(data.length % 4).toBe(0)
    expect(woff2FontsOnly('src:url(a.woff2) format("woff2"),url(a.woff) format("woff"),url(a.ttf) format("truetype")')).toBe('src:url(a.woff2) format("woff2")')
  })

  it('fetch the fonts again after a failed round', async () => {
    let online = false
    const calls = stubs(() => online)
    const { magicShapeToSvg } = await import('../src/board/MagicShape')
    const first = renderToStaticMarkup(await magicShapeToSvg(shape))
    expect(first).not.toContain('url(data:')
    online = true
    const second = renderToStaticMarkup(await magicShapeToSvg(shape))
    expect(calls.length).toBe(40)
    expect(second.match(/url\(data:/g)).toHaveLength(20)
    // a complete round is kept
    renderToStaticMarkup(await magicShapeToSvg(shape))
    expect(calls.length).toBe(40)
  })
})
