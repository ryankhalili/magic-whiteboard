import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Editor, colorValue, getStrokeWidth, strokePoints, type TLShape } from './editor'
import { EditorProvider, useValue } from './context'
import { CanvasInteractions, selectionFrame, type CanvasPointer, type InteractionView, type ResizeHandle } from './interactions'
import { inkOutlinePath } from './ink'
import { legacyText, shapeOpacity } from './content'
import { ImageGraphic } from './ImageGraphic'
import './canvas.css'

export type WhiteboardCanvasProps = {
  onMount?: (editor: Editor) => void | (() => void)
  renderShape?: (shape: TLShape, editor: Editor) => ReactNode
  persistenceKey?: string
  children?: ReactNode
}

const inputSelector = 'input,textarea,select,button,[contenteditable=true],math-field,.marginalia-inline-editor,.ML__keyboard,.ML__keyboard-container'
const interfaceSelector = `${inputSelector},aside,nav,.command-dock,.popover,.board-options,.canvas-footer,.empty-board,.object-inspector,.history-panel,.notebook-switcher`

function pointer(event: PointerEvent | React.PointerEvent, handle?: string): CanvasPointer {
  return { id: event.pointerId, x: event.clientX, y: event.clientY, pointerType: event.pointerType, pressure: event.pressure, button: event.button, shift: event.shiftKey, handle: handle as CanvasPointer['handle'] }
}
function elementTarget(event: Event | React.SyntheticEvent): Element | null {
  return event.target instanceof Element ? event.target : null
}
function shapeTransform(editor: Editor, shape: TLShape): string {
  const matrix = editor.getShapePageTransform(shape), origin = matrix.applyToPoint({ x: 0, y: 0 }), x = matrix.applyToPoint({ x: 1, y: 0 }), y = matrix.applyToPoint({ x: 0, y: 1 })
  return `matrix(${x.x - origin.x},${x.y - origin.y},${y.x - origin.x},${y.y - origin.y},${origin.x},${origin.y})`
}

const DefaultShape = memo(function DefaultShape({ shape, editor }: { shape: TLShape; editor: Editor }) {
  if (shape.type === 'draw') {
    const width = getStrokeWidth(shape.props)
    const strokes = shape.props.segments?.length ? shape.props.segments.map(segment => segment.points) : [strokePoints(shape.props)]
    return <svg className="whiteboard-ink" width={Math.max(1, shape.props.w || 1)} height={Math.max(1, shape.props.h || 1)} aria-label="Pen stroke">{strokes.map((points, index) => <path key={index} d={inkOutlinePath(points, width)} fill={colorValue(shape.props.color || 'black')}/>)}</svg>
  }
  if (shape.type === 'image') {
    const asset = shape.props.assetId ? editor.getAsset(shape.props.assetId) : null
    return asset?.props.src ? <ImageGraphic src={asset.props.src} props={shape.props} label={shape.props.altText || asset.props.name || 'Imported image'}/> : <div className="whiteboard-missing-image" style={{ width: shape.props.w, height: shape.props.h }}>Image unavailable</div>
  }
  if (shape.type === 'text') return <div style={{ width: shape.props.w || 300, minHeight: shape.props.h || 30, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: colorValue(shape.props.color || 'black'), fontSize: Number(shape.props.fontSize) || 24, fontFamily: 'Arial, sans-serif' }}>{legacyText(shape.props)}</div>
  if (shape.type === 'geo') {
    const w = shape.props.w || 100, h = shape.props.h || 100, color = colorValue(shape.props.color || 'black'), geometry = shape.props.geo
    const text = legacyText(shape.props)
    return <svg width={w} height={h} style={{ overflow: 'visible' }}><g fill={shape.props.fill === 'solid' ? color : 'none'} stroke={color} strokeWidth={2.5}>
      {geometry === 'ellipse' ? <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2}/> : geometry === 'triangle' ? <path d={`M${w / 2},0L${w},${h}L0,${h}Z`}/> : geometry === 'diamond' ? <path d={`M${w / 2},0L${w},${h / 2}L${w / 2},${h}L0,${h / 2}Z`}/> : <rect width={w} height={h}/>}
    </g>{text && <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="middle" fill={color} fontSize={20}>{text}</text>}</svg>
  }
  return null
})

function CanvasScene({ editor, renderShape, children }: WhiteboardCanvasProps & { editor: Editor }) {
  const container = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<InteractionView>({ marquee: null, active: null })
  const interactions = useMemo(() => new CanvasInteractions(editor, setView), [editor])
  useValue('Canvas revision', () => editor.getRevision(), [editor])
  const camera = editor.getCamera(), shapes = editor.getCurrentPageShapesSorted()
  const selected = editor.getSelectedShapes().filter(shape => !editor.isShapeOrAncestorLocked(shape))
  const frame = selectionFrame(editor, selected)
  const editing = editor.getEditingShapeId()
  const tool = editor.getCurrentToolId().split('.')[0]
  const z = camera.z

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { const b = element.getBoundingClientRect(); editor.setViewportScreenBounds({ x: b.x, y: b.y, w: b.width, h: b.height }) }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { resize.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [editor])

  useEffect(() => {
    const containerElement = container.current
    if (!containerElement) return
    const stage = containerElement.parentElement || containerElement
    editor.setInteractionCompleter(() => interactions.complete())
    const onWheel = (event: WheelEvent) => {
      if (elementTarget(event)?.closest(interfaceSelector)) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? containerElement.clientHeight : 1
      interactions.wheel({ x: event.clientX, y: event.clientY, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, zoom: event.ctrlKey || event.metaKey, shift: event.shiftKey })
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || elementTarget(event)?.closest(inputSelector)) return
      if (event.code === 'Space') { event.preventDefault(); interactions.setSpacePressed(true); containerElement.classList.add('whiteboard-space-pan'); return }
      if (event.code === 'Escape') { interactions.cancel(); editor.setEditingShape(null).selectNone(); return }
      if ((event.ctrlKey || event.metaKey) && ['KeyZ', 'KeyY'].includes(event.code)) {
        event.preventDefault(); interactions.complete()
        if (event.code === 'KeyY' || event.shiftKey) editor.redo(); else editor.undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyA') {
        event.preventDefault(); editor.select(...editor.getCurrentPageShapes().filter(shape => !editor.isShapeOrAncestorLocked(shape) && shape.type !== 'group').map(shape => shape.id)); return
      }
      const selected = editor.getSelectedShapes().filter(shape => !editor.isShapeOrAncestorLocked(shape))
      if (!selected.length || editor.getEditingShapeId()) return
      if (event.code === 'Delete' || event.code === 'Backspace') {
        event.preventDefault(); interactions.complete(); editor.markHistoryStoppingPoint('Delete selection'); editor.deleteShapes(selected.map(shape => shape.id)); editor.markHistoryStoppingPoint('After delete'); return
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault(); interactions.complete()
        const step = event.shiftKey ? 10 : 1, dx = event.code === 'ArrowLeft' ? -step : event.code === 'ArrowRight' ? step : 0, dy = event.code === 'ArrowUp' ? -step : event.code === 'ArrowDown' ? step : 0
        if (!event.repeat) editor.markHistoryStoppingPoint('Nudge selection')
        editor.updateShapes(selected.map(shape => ({ id: shape.id, type: shape.type, x: shape.x + dx, y: shape.y + dy })))
      }
    }
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') { interactions.setSpacePressed(false); containerElement.classList.remove('whiteboard-space-pan') }
      if (event.code.startsWith('Arrow') && !elementTarget(event)?.closest(inputSelector)) editor.markHistoryStoppingPoint('After nudge')
    }
    const blur = () => { interactions.cancel(); containerElement.classList.remove('whiteboard-space-pan') }
    stage.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    return () => { editor.setInteractionCompleter(null); stage.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); interactions.cancel() }
  }, [editor, interactions])

  const handles: Array<[ResizeHandle, number, number]> = frame ? [['nw', 0, 0], ['n', frame.w / 2, 0], ['ne', frame.w, 0], ['e', frame.w, frame.h / 2], ['se', frame.w, frame.h], ['s', frame.w / 2, frame.h], ['sw', 0, frame.h], ['w', 0, frame.h / 2]] : []
  const showHandles = frame && !editing && tool === 'select' && view.active !== 'marquee'
  return <div ref={container} className={`whiteboard-canvas tool-${tool}${view.active ? ` is-${view.active}` : ''}`} role="application" aria-label="Magic Whiteboard canvas" tabIndex={0}
    onPointerDown={event => {
      if (elementTarget(event)?.closest(inputSelector) && !elementTarget(event)?.closest('[data-resize-handle]')) return
      const handle = elementTarget(event)?.closest('[data-resize-handle]')?.getAttribute('data-resize-handle') || undefined
      if (interactions.pointerDown(pointer(event, handle))) {
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    }}
    onPointerMove={event => {
      const coalesced = event.nativeEvent.getCoalescedEvents?.() || []
      if (coalesced.length) coalesced.forEach(sample => interactions.pointerMove(pointer(sample)))
      else interactions.pointerMove(pointer(event))
    }}
    onPointerUp={event => { interactions.pointerUp(pointer(event)); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => interactions.cancel()}
    onLostPointerCapture={event => { if (event.buttons) interactions.cancel() }}
    onDoubleClick={event => { if (!elementTarget(event)?.closest(inputSelector)) interactions.doubleClick({ x: event.clientX, y: event.clientY }) }}
    onContextMenu={event => { if (!elementTarget(event)?.closest(inputSelector)) event.preventDefault() }}>
    <div className="whiteboard-world" style={{ transform: `translate(${camera.x * z}px,${camera.y * z}px) scale(${z})` }}>
      {shapes.filter(shape => shape.type !== 'group').map(shape => <div key={shape.id} className={`whiteboard-shape shape-${shape.type}${shape.isLocked ? ' is-locked' : ''}${editing === shape.id ? ' is-editing' : ''}`} data-shape-id={shape.id}
        style={{ transform: shapeTransform(editor, shape), width: Math.max(1, shape.props.w || 1), height: Math.max(1, shape.props.h || 1), opacity: shapeOpacity(editor, shape) } as CSSProperties}>
        {shape.type === 'magic' ? renderShape?.(shape, editor) : <DefaultShape shape={shape} editor={editor}/>}
      </div>)}
      {showHandles && <div className="whiteboard-selection" style={{ transform: `translate(${frame.x}px,${frame.y}px) rotate(${frame.rotation}rad)`, width: frame.w, height: frame.h, borderWidth: 1 / z }}>
        <div className="whiteboard-rotation-stem" style={{ left: frame.w / 2, height: 25 / z, top: -25 / z, width: 1 / z }}/>
        <button tabIndex={-1} aria-label="Rotate selection" className="whiteboard-handle rotate" data-resize-handle="rotate" style={{ left: frame.w / 2, top: -29 / z, width: 10 / z, height: 10 / z, borderWidth: 1 / z }}/>
        {handles.map(([name, x, y]) => <button tabIndex={-1} key={name} aria-label={`Resize ${name}`} className={`whiteboard-handle handle-${name}`} data-resize-handle={name} style={{ left: x, top: y, width: 9 / z, height: 9 / z, borderWidth: 1 / z }}/>) }
      </div>}
      {view.marquee && <div className="whiteboard-marquee" style={{ left: view.marquee.x, top: view.marquee.y, width: view.marquee.w, height: view.marquee.h, borderWidth: 1 / z }}/>} 
    </div>
    {children}
    <span className="whiteboard-accessibility">Use the pencil to draw, Select to move objects, and two fingers to zoom. Hold Space to pan. Double-click text or an equation to edit.</span>
  </div>
}

export function WhiteboardCanvas({ onMount, ...props }: WhiteboardCanvasProps) {
  const [editor] = useState(() => new Editor())
  const mount = useRef(onMount)
  mount.current = onMount
  useEffect(() => {
    const cleanup = mount.current?.(editor)
    return () => { cleanup?.() }
  }, [editor])
  return <EditorProvider editor={editor}><CanvasScene {...props} editor={editor}/></EditorProvider>
}
