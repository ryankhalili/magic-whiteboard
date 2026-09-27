import { BaseBoxShapeUtil, HTMLContainer, SVGContainer, T, useEditor, useIsEditing, type TLShape } from 'tldraw'
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import katex from 'katex'
import katexCss from 'katex/dist/katex.min.css?inline'
import { niceTicks, samplePlot } from './expression'
import { InlineEditor } from './InlineEditor'
import { getAxisMode, getPlotLayout } from './plotLayout'

export type MagicShapeProps = {
  w: number; h: number; kind: 'plot' | 'math' | 'text' | 'geometry'; expression: string; latex: string;
  text: string; title: string; color: string; xMin: number; xMax: number; yMin: number; yMax: number;
  geometry: 'triangle' | 'right_triangle' | 'rectangle' | 'ellipse' | 'arrow'; fontSize: number
}

declare module '@tldraw/tlschema' { interface TLGlobalShapePropsMap { magic: MagicShapeProps } }
export type MagicShape = TLShape<'magic'>
export const DEFAULT_MAGIC_PROPS: MagicShapeProps = {
  w: 420, h: 300, kind: 'plot', expression: 'sin(x)', latex: '', text: '', title: '', color: '#111111',
  xMin: -Math.PI * 2, xMax: Math.PI * 2, yMin: -1.35, yMax: 1.35, geometry: 'triangle', fontSize: 28,
}

function tickLabel(value: number) {
  if (value === 0) return '0'
  if (Math.abs(value) >= 10000 || Math.abs(value) < .001) return value.toExponential(1)
  return Number(value.toPrecision(4)).toString().replace('-', '−')
}

function prettyExpression(expression: string) {
  return expression.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³').replace(/\*/g, '·').replace(/\bpi\b/g, 'π')
}

export function PlotGraphic({ shape, hideExpression = false }: { shape: MagicShape; hideExpression?: boolean }) {
  const p = shape.props
  const { pad, width: pw, height: ph, X, Y, range } = getPlotLayout(p, getAxisMode(shape.meta))
  const id = `clip-${shape.id.replace(/[^a-zA-Z0-9]/g, '')}`
  let paths: string[] = [], error = ''
  try { paths = samplePlot(p.expression, range.xMin, range.xMax, range.yMin, range.yMax, pw, ph) } catch (e) { error = (e as Error).message }
  const xticks = niceTicks(range.xMin, range.xMax, Math.max(3, Math.floor(pw / 60)))
  const yticks = niceTicks(range.yMin, range.yMax, Math.max(3, Math.floor(ph / 40)))
  return <g>
    {p.title && <text x={pad.l} y={18} fontFamily="Arial, sans-serif" fontSize={13} fill="#111">{p.title}</text>}
    {!hideExpression && <text x={pad.l} y={p.title ? 43 : 23} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 20)} fill={p.color}>y = {prettyExpression(p.expression)}</text>}
    <g transform={`translate(${pad.l},${pad.t})`}>
      <defs><clipPath id={id}><rect width={pw} height={ph}/></clipPath></defs>
      {xticks.map(x => <g key={`x${x}`}><path d={`M${X(x)},0 V${ph}`} stroke="#e8e8e8"/><text x={X(x)} y={ph + 22} textAnchor="middle" fontFamily="Arial, sans-serif" fontSize={11} fill="#555">{tickLabel(x)}</text></g>)}
      {yticks.map(y => <g key={`y${y}`}><path d={`M0,${Y(y)} H${pw}`} stroke="#e8e8e8"/><text x={-12} y={Y(y) + 3} textAnchor="end" fontFamily="Arial, sans-serif" fontSize={11} fill="#555">{tickLabel(y)}</text></g>)}
      {range.yMin <= 0 && range.yMax >= 0 && <path d={`M0,${Y(0)} H${pw}`} stroke="#777" strokeWidth={1}/>}
      {range.xMin <= 0 && range.xMax >= 0 && <path d={`M${X(0)},0 V${ph}`} stroke="#777" strokeWidth={1}/>}
      <g clipPath={`url(#${id})`}>{paths.map((d, i) => <path key={i} d={d} fill="none" stroke={p.color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"/>)}</g>
      {error && <text x={pw / 2} y={ph / 2} textAnchor="middle" fontSize={11} fill="#b05746">Unable to display this function</text>}
      <text x={pw + 8} y={ph + 21} fontFamily="Arial, sans-serif" fontSize={11} fill="#333">x</text>
    </g>
  </g>
}

export function GeometryGraphic({ shape }: { shape: MagicShape }) {
  const p = shape.props, { w, h, color } = p, left = 24, right = w - 24, top = 25, bottom = h - 34
  const candidateLabels = p.text.split(',').map(label => label.trim())
  const hasCornerLabels = (p.geometry === 'triangle' || p.geometry === 'right_triangle') && candidateLabels.length === 3 && candidateLabels.every(label => label.length > 0 && label.length <= 12)
  const corners = hasCornerLabels ? candidateLabels : ['A', 'B', 'C']
  const fill = 'none'
  const line = { stroke: color, strokeWidth: 2.6, strokeLinejoin: 'round' as const, fill }
  const label = (x: number, y: number, text: string) => <text x={x} y={y} fill={color} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 22)} textAnchor="middle">{text}</text>
  return <g>
    {p.geometry === 'right_triangle' && <><path d={`M${left},${bottom} L${left},${top} L${right},${bottom} Z`} {...line}/><path d={`M${left},${bottom - 16} h16 v16`} fill="none" stroke={color} strokeWidth={1.5}/>{label(left - 12, top, corners[0])}{label(left, bottom + 24, corners[1])}{label(right + 6, bottom + 24, corners[2])}</>}
    {p.geometry === 'triangle' && <><path d={`M${w / 2},${top} L${right},${bottom} L${left},${bottom} Z`} {...line}/>{label(w / 2, top - 9, corners[0])}{label(left, bottom + 24, corners[1])}{label(right, bottom + 24, corners[2])}</>}
    {p.geometry === 'rectangle' && <rect x={left} y={top} width={Math.max(2, right - left)} height={Math.max(2, bottom - top)} rx={3} {...line}/>}
    {p.geometry === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={Math.max(1, w / 2 - 24)} ry={Math.max(1, h / 2 - 25)} {...line}/>}
    {p.geometry === 'arrow' && <><path d={`M${left},${h / 2} H${right}`} stroke={color} strokeWidth={3} fill="none"/><path d={`M${right - 17},${h / 2 - 10} L${right},${h / 2} L${right - 17},${h / 2 + 10}`} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round"/></>}
    {p.text && !hasCornerLabels && <text x={w / 2} y={h / 2 + (p.geometry === 'arrow' ? -15 : 10)} textAnchor="middle" fill={color} fontFamily="Arial, sans-serif" fontSize={Math.min(p.fontSize, 22)}>{p.text}</text>}
    {p.title && <text x={w / 2} y={h - 4} textAnchor="middle" fill="#7b8986" fontFamily="Arial, sans-serif" fontSize={11}>{p.title}</text>}
  </g>
}

function mathHtml(latex: string) {
  return katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 })
    .replace('class="katex-display"', 'class="katex-display" style="margin:0;text-align:left"')
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

function TextGraphic({ shape }: { shape: MagicShape }) {
  const p = shape.props
  return <div style={{ width: p.w, height: p.h, boxSizing: 'border-box', padding: 8, fontSize: p.fontSize, lineHeight: 1.4, color: p.color, fontFamily: 'Arial, Helvetica, sans-serif', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden' }}>{p.text}</div>
}

function MagicShapeComponent({ shape }: { shape: MagicShape }) {
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
  if (isEditing && shape.props.kind === 'plot') return <HTMLContainer style={{ pointerEvents: 'all', overflow: 'visible' }}><svg width={shape.props.w} height={shape.props.h} style={{ overflow }}><PlotGraphic shape={visible} hideExpression/></svg><InlineEditor shape={shape} preview={preview}/></HTMLContainer>
  if (isEditing && shape.props.kind !== 'geometry') return <HTMLContainer style={{ pointerEvents: 'all', overflow: 'visible' }}><InlineEditor shape={shape} preview={preview}/></HTMLContainer>
  if (shape.props.kind === 'math') return <HTMLContainer style={{ pointerEvents: 'all' }}><LiveMathGraphic shape={visible} allowResize={!preview}/></HTMLContainer>
  if (shape.props.kind === 'text') return <HTMLContainer style={{ pointerEvents: 'all' }}><TextGraphic shape={visible}/></HTMLContainer>
  return <SVGContainer style={{ overflow }}><svg width={visible.props.w} height={visible.props.h} viewBox={`0 0 ${visible.props.w} ${visible.props.h}`} style={{ overflow }}>{visible.props.kind === 'plot' ? <PlotGraphic shape={visible}/> : <GeometryGraphic shape={visible}/>}</svg></SVGContainer>
}

let exportCssPromise: Promise<string> | null = null
async function getExportCss(): Promise<string> {
  exportCssPromise ??= (async () => {
    // Raster exports need the math webfonts embedded in their SVG, rather than external URL references.
    const urls = [...new Set([...katexCss.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/^['"]|['"]$/g, '')))]
    let css = katexCss
    await Promise.all(urls.map(async url => {
      if (url.startsWith('data:')) return
      try {
        const res = await fetch(url)
        if (!res.ok) return
        const blob = await res.blob()
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(blob) })
        css = css.split(url).join(data)
      } catch { /* The live board still renders even if a font cannot be embedded. */ }
    }))
    return css
  })()
  return exportCssPromise
}

export class MagicShapeUtil extends BaseBoxShapeUtil<MagicShape> {
  static override type = 'magic' as const
  static override props = {
    w: T.positiveNumber, h: T.positiveNumber, kind: T.literalEnum('plot', 'math', 'text', 'geometry'),
    expression: T.string, latex: T.string, text: T.string, title: T.string, color: T.string,
    xMin: T.number, xMax: T.number, yMin: T.number, yMax: T.number,
    geometry: T.literalEnum('triangle', 'right_triangle', 'rectangle', 'ellipse', 'arrow'), fontSize: T.positiveNumber,
  }
  override getDefaultProps(): MagicShapeProps { return { ...DEFAULT_MAGIC_PROPS } }
  override canEdit(shape: MagicShape) { return shape.props.kind !== 'geometry' }
  override component(shape: MagicShape) { return <MagicShapeComponent shape={shape}/> }
  override getIndicatorPath(shape: MagicShape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path }
  override async toSvg(shape: MagicShape) {
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
}
