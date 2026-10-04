import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Box, type Editor, type TLShapeId } from '../canvas/editor'
import { colorValue, getStrokeWidth, strokePoints, type Matrix2d } from '../canvas/geometry'
import type { Bounds } from '../../shared/board'
import { inkOutlinePath } from '../canvas/ink'
import { isDisconnectedInk } from '../canvas/disconnectedInk'
import { nativeInkSvgPath } from '../canvas/nativeInkRenderer'
import { legacyText, shapeOpacity } from '../canvas/content'
import { ImageGraphic } from '../canvas/ImageGraphic'
import type { ImageExportOptions, ImageExportResult, TLShape } from '../canvas/types'
import { magicShapeToSvg } from '../board/MagicShape'
import { MAX_EXPORT_PIXELS, exportTimeout } from './exportTimeout'

async function graphic(editor: Editor, shape: TLShape): Promise<ReactNode> {
  if (shape.type === 'magic') return magicShapeToSvg(shape)
  if (shape.type === 'group') return null
  if (shape.type === 'image') {
    const asset = editor.getAsset(shape.props.assetId)
    if (!asset) throw new Error('A screenshot asset is missing. Open a saved project backup before exporting.')
    return <ImageGraphic src={asset.props.src} props={shape.props}/>
  }
  if (shape.type === 'draw') {
    if (!isDisconnectedInk(shape)) return <path fill={colorValue(shape.props.color)} d={nativeInkSvgPath(shape.props)}/>
    const segments = shape.props.segments?.length ? shape.props.segments.map(segment => segment.points) : [strokePoints(shape.props)]
    return <g fill={colorValue(shape.props.color)}>
      {segments.map((points, index) => <path key={index} d={inkOutlinePath(points, getStrokeWidth(shape.props))}/>) }
    </g>
  }
  const p = shape.props
  const width = p.w || 240, height = p.h || 80
  const text = legacyText(p)
  const color = colorValue(p.color || '#202124')
  if (shape.type === 'text') return <foreignObject width={width} height={height}>
    <div {...{ xmlns: 'http://www.w3.org/1999/xhtml' }} style={{ color, fontFamily: 'Arial, sans-serif', fontSize: typeof p.fontSize === 'number' ? p.fontSize : 24, whiteSpace: 'pre-wrap' }}>{text}</div>
  </foreignObject>
  return <g stroke={color} strokeWidth={2} fill={p.fill === 'solid' ? color : 'none'}>
    {p.geo === 'ellipse' ? <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2}/>
      : p.geo === 'triangle' ? <polygon points={`${width / 2},0 ${width},${height} 0,${height}`}/>
        : <rect width={width} height={height}/>}
    {text && <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle" stroke="none" fill={color} fontFamily="Arial, sans-serif" fontSize={24}>{text}</text>}
  </g>
}

/** Build self-contained SVG using our document model, including locked images and parent transforms. */
export type SceneExportOptions = ImageExportOptions & { sceneTransform?: Matrix2d; clip?: Bounds }
export async function renderShapesToSvg(editor: Editor, ids: TLShapeId[], options: SceneExportOptions = {}): Promise<{ svg: string; bounds: Box; width: number; height: number }> {
  const selected = new Set(ids)
  const shapes = editor.getCurrentPageShapesSorted().filter(shape => {
    if (selected.has(shape.id)) return true
    let parent = editor.getShape(shape.parentId)
    while (parent) { if (selected.has(parent.id)) return true; parent = editor.getShape(parent.parentId) }
    return false
  })
  const bounds = options.bounds ? new Box(options.bounds.x, options.bounds.y, options.bounds.w, options.bounds.h)
    : Box.Common(shapes.map(shape => editor.getShapePageBounds(shape)).filter((box): box is Box => !!box))
  const padding = options.padding ?? 0
  bounds.x -= padding; bounds.y -= padding; bounds.w = Math.max(1, bounds.w + padding * 2); bounds.h = Math.max(1, bounds.h + padding * 2)
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) throw new Error('The export area is invalid.')
  const requestedScale = (options.scale ?? 1) * (options.pixelRatio ?? 1)
  const scale = Math.min(Math.max(0.001, requestedScale), 8192 / bounds.w, 8192 / bounds.h, Math.sqrt(MAX_EXPORT_PIXELS / (bounds.w * bounds.h)))
  const width = Math.max(1, Math.round(bounds.w * scale)), height = Math.max(1, Math.round(bounds.h * scale))
  const graphics = await Promise.all(shapes.map(async shape => {
    const content = await graphic(editor, shape)
    if (!content) return null
    return <g key={shape.id} transform={editor.getShapePageTransform(shape).toCssString()} opacity={shapeOpacity(editor, shape)}>{content}</g>
  }))
  const svg = renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}>
    {options.background && <rect x={bounds.x} y={bounds.y} width={bounds.w} height={bounds.h} fill="#ffffff"/>}
    {options.clip && <defs><clipPath id="worksheet-page-clip"><rect x={options.clip.x} y={options.clip.y} width={options.clip.w} height={options.clip.h}/></clipPath></defs>}
    <g clipPath={options.clip ? 'url(#worksheet-page-clip)' : undefined}><g transform={options.sceneTransform?.toCssString()}>{graphics}</g></g>
  </svg>)
  return { svg, bounds, width, height }
}

export async function renderShapesToImage(editor: Editor, ids: TLShapeId[], options: SceneExportOptions = {}): Promise<ImageExportResult> {
  const { svg, width, height } = await exportTimeout(renderShapesToSvg(editor, ids, options), 'preparing math and fonts')
  const image = await exportTimeout(new Promise<HTMLImageElement>((resolve, reject) => {
    const result = new Image()
    result.onload = () => resolve(result)
    result.onerror = () => reject(new Error('The board could not be rendered for export. Try again after the math fonts finish loading.'))
    // Inline SVG keeps embedded foreignObject math origin-clean in supporting browsers.
    result.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }), 'decoding the board image')
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image export is unavailable in this browser.')
  try {
    context.drawImage(image, 0, 0, width, height)
    const blob = await exportTimeout(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The board image could not be saved.')), 'image/png')), 'saving the board image')
    return { blob, width, height }
  } finally {
    // Long worksheet exports should not retain a large canvas backing store for every page.
    canvas.width = 0; canvas.height = 0
  }
}
