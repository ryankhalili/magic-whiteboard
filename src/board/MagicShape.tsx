import { useEditor, useIsEditing } from '../canvas/context'
import type { TLShape, MagicShapeProps } from '../canvas/editor'
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import katex from 'katex'
import katexCss from 'katex/dist/katex.min.css?inline'
import { InlineEditor } from './InlineEditor'
import { PlotGraphic } from './PlotGraphic'
import { GeometryGraphic } from './GeometryGraphic'
export { PlotGraphic } from './PlotGraphic'
export { GeometryGraphic } from './GeometryGraphic'

export type { MagicShapeProps } from '../canvas/editor'
export type MagicShape = TLShape<'magic'>
export const DEFAULT_MAGIC_PROPS: MagicShapeProps = {
  w: 420, h: 300, kind: 'plot', expression: 'sin(x)', latex: '', text: '', title: '', color: '#111111',
  xMin: -Math.PI * 2, xMax: Math.PI * 2, yMin: -1.35, yMax: 1.35, geometry: 'triangle', fontSize: 28,
}

function mathHtml(latex: string) {
  return katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 })
    .replace('class="katex-display"', 'class="katex-display" style="margin:0;text-align:left"')
    // KaTeX centers this child explicitly, so the outer wrapper cannot override it by inheritance.
    .replace('class="katex"', 'class="katex" style="text-align:left"')
}

const mathStyle = (p: MagicShapeProps): React.CSSProperties => ({
  width: p.w, height: p.h, padding: '8px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
  alignItems: 'flex-start', justifyContent: 'flex-start', color: p.color, fontSize: p.fontSize, overflow: 'hidden',
  background: 'transparent',
})

function MathGraphic({ shape, contentRef }: { shape: MagicShape; contentRef?: Ref<HTMLDivElement> }) {
  return <div style={mathStyle(shape.props)}>
    {shape.props.title && <div style={{ alignSelf: 'flex-start', fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#333', marginBottom: 8 }}>{shape.props.title}</div>}
    <div ref={contentRef} style={{ maxWidth: '100%', lineHeight: 1.25 }} dangerouslySetInnerHTML={{ __html: mathHtml(shape.props.latex) }}/>
  </div>
}

function LiveMathGraphic({ shape, allowResize }: { shape: MagicShape; allowResize: boolean }) {
  const editor = useEditor(), content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!allowResize || !content.current) return
    const element = content.current
    const fit = () => {
      const current = editor.getShape<MagicShape>(shape.id)
      if (!current || current.props.kind !== 'math' || current.meta?.literalBounds) return
      const w = Math.min(10000, Math.max(current.props.w, Math.ceil(element.scrollWidth + 16)))
      const h = Math.min(10000, Math.max(current.props.h, Math.ceil(element.scrollHeight + 16 + (current.props.title ? 29 : 0))))
      if (w > current.props.w + 1 || h > current.props.h + 1) {
        // Rendering measurement is layout housekeeping, not a separate user undo step.
        editor.run(() => editor.updateShape<MagicShape>({ id: current.id, type: 'magic', props: { w, h } }), { history: 'ignore' })
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [editor, shape.id, shape.props.latex, shape.props.fontSize, shape.props.title, allowResize])
  return <MathGraphic shape={shape} contentRef={content}/>
}

function TextGraphic({ shape, contentRef }: { shape: MagicShape; contentRef?: Ref<HTMLDivElement> }) {
  const p = shape.props
  return <div style={{ width: p.w, height: p.h, boxSizing: 'border-box', padding: 8, fontSize: p.fontSize, lineHeight: 1.4, color: p.color, fontFamily: 'Arial, Helvetica, sans-serif', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden' }}><div ref={contentRef}>{p.text}</div></div>
}

/** Box height that shows all of a text's lines (8 px padding above and below), or null when it already fits. */
export function grownTextHeight(height: number, contentHeight: number): number | null {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return null
  const needed = Math.min(10000, Math.ceil(contentHeight + 16))
  return needed > height + 1 ? needed : null
}

// text written by the assistant, dictation or the inspector grows its box like typing on the board does
function LiveTextGraphic({ shape, allowResize }: { shape: MagicShape; allowResize: boolean }) {
  const editor = useEditor(), content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!allowResize || !content.current) return
    const current = editor.getShape<MagicShape>(shape.id)
    if (!current || current.props.kind !== 'text' || current.meta?.literalBounds) return
    const h = grownTextHeight(current.props.h, content.current.scrollHeight)
    // layout housekeeping, not a separate undo step
    if (h) editor.run(() => editor.updateShape<MagicShape>({ id: current.id, type: 'magic', props: { h } }), { history: 'ignore' })
  }, [editor, shape.id, shape.props.text, shape.props.fontSize, shape.props.w, allowResize])
  return <TextGraphic shape={shape} contentRef={content}/>
}

export function MagicShapeView({ shape }: { shape: MagicShape }) {
  const isEditing = useIsEditing(shape.id)
  const [preview, setPreview] = useState<{ field: 'latex' | 'text' | 'expression'; value: string } | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail) { setPreview(null); return }
      if (detail.target === shape.id && ['latex', 'text', 'expression'].includes(detail.field) && typeof detail.value === 'string') setPreview({ field: detail.field, value: detail.value })
    }
    window.addEventListener('marginalia-content-preview', listener)
    return () => window.removeEventListener('marginalia-content-preview', listener)
  }, [shape.id])
  useEffect(() => { setPreview(null) }, [shape.props.latex, shape.props.text, shape.props.expression])
  const visible = preview ? { ...shape, props: { ...shape.props, [preview.field]: preview.value } } : shape
  const overflow = shape.meta?.literalBounds ? 'hidden' : 'visible'
  if (isEditing && shape.props.kind === 'plot') return <div className="magic-shape-content" style={{ pointerEvents: 'all', overflow: 'visible' }}><svg width={shape.props.w} height={shape.props.h} style={{ overflow }}><PlotGraphic shape={visible} hideExpression/></svg><InlineEditor shape={shape} preview={preview}/></div>
  if (isEditing && shape.props.kind !== 'geometry') return <div className="magic-shape-content" style={{ pointerEvents: 'all', overflow: 'visible' }}><InlineEditor shape={shape} preview={preview}/></div>
  if (shape.props.kind === 'math') return <div className="magic-shape-content"><LiveMathGraphic shape={visible} allowResize={!preview}/></div>
  if (shape.props.kind === 'text') return <div className="magic-shape-content"><LiveTextGraphic shape={visible} allowResize={!preview}/></div>
  return <svg width={visible.props.w} height={visible.props.h} viewBox={`0 0 ${visible.props.w} ${visible.props.h}`} style={{ overflow }}>{visible.props.kind === 'plot' ? <PlotGraphic shape={visible}/> : <GeometryGraphic shape={visible}/>}</svg>
}

/** Every browser that draws these images reads woff2, a quarter of the size of all three font formats. */
export function woff2FontsOnly(css: string): string {
  return css.replace(/,\s*url\([^)]*\)\s*format\(["']?(?:woff|truetype)["']?\)/g, '')
}

let exportCssPromise: Promise<string> | null = null
async function getExportCss(): Promise<string> {
  exportCssPromise ??= (async () => {
    // Raster exports need the math webfonts embedded in their SVG, rather than external URL references.
    const css = woff2FontsOnly(katexCss), embedded = new Map<string, string>()
    let missing = 0
    await Promise.all([...new Set(css.match(/url\([^)]+\)/g) ?? [])].map(async token => {
      const url = token.slice(4, -1).trim().replace(/^['"]|['"]$/g, '')
      if (url.startsWith('data:')) return
      try {
        const res = await fetch(url)
        if (!res.ok) { missing++; return }
        const blob = await res.blob()
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob) })
        embedded.set(token, `url(${data})`)
      } catch { missing++ } // the live board still renders even if a font cannot be embedded
    }))
    // a failed round is not kept, so the next render fetches the fonts again
    if (missing) exportCssPromise = null
    // whole url(...) tokens only, so one font's address never rewrites part of another's
    return css.replace(/url\([^)]+\)/g, token => embedded.get(token) ?? token)
  })()
  return exportCssPromise
}

export async function magicShapeToSvg(shape: MagicShape) {
    if (shape.props.kind === 'plot' || shape.props.kind === 'geometry') {
      const graphic = shape.props.kind === 'plot' ? <PlotGraphic shape={shape}/> : <GeometryGraphic shape={shape}/>
      if (shape.meta?.literalBounds) return <svg width={shape.props.w} height={shape.props.h} overflow="hidden">{graphic}</svg>
      return graphic
    }
    return <foreignObject width={shape.props.w} height={shape.props.h}>
      <div {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}>
        {shape.props.kind === 'math' && <style>{await getExportCss()}</style>}
        {shape.props.kind === 'math' ? <MathGraphic shape={shape}/> : <TextGraphic shape={shape}/>}
      </div>
    </foreignObject>
}
