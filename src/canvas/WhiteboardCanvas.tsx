import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw'
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { Editor, colorValue, getStrokeWidth, type TLShape } from './editor'
import { EditorProvider, useValue } from './context'
import { legacyText } from './content'
import { editorToExcalidrawScene, sceneToEditorChanges } from './excalidrawScene'
import { shapeOpacity } from './content'
import { isLiveContentShape, liveContentKey, renderLiveContentImage } from './liveContentImage'
import { flushSourceEdits } from '../board/liveSource'
import '@excalidraw/excalidraw/index.css'
import './canvas.css'

// Fonts are served and copied by the Vite asset plugin, including offline/local builds.
;(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw/`

export type WhiteboardCanvasProps = {
  onMount?: (editor: Editor) => void | (() => void)
  renderShape?: (shape: TLShape, editor: Editor) => ReactNode
  persistenceKey?: string
  children?: ReactNode
}

const inputSelector = 'input,textarea,select,button,[contenteditable=true],math-field,.marginalia-inline-editor,.ML__keyboard,.ML__keyboard-container'
const interfaceSelector = `${inputSelector},aside,nav,.command-dock,.popover,.board-options,.canvas-footer,.empty-board,.object-inspector,.history-panel,.notebook-switcher`
const uiOptions = { canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false as const, toggleTheme: false }, tools: { image: false } }
const initialData = { appState: { viewBackgroundColor: 'transparent', currentItemRoughness: 0, currentItemStrokeColor: '#202124', currentItemStrokeWidth: 3, currentItemFontFamily: 2, openSidebar: null } }
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])
const nativeTool = (tool: string): 'freedraw' | 'eraser' | 'hand' | 'selection' => tool.startsWith('draw') ? 'freedraw' : tool.startsWith('eraser') ? 'eraser' : tool.startsWith('hand') ? 'hand' : 'selection'

const LegacyShape = memo(function LegacyShape({ shape }: { shape: TLShape }) {
  if (shape.type === 'text') return <div style={{ width: shape.props.w || 300, minHeight: shape.props.h || 30, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: colorValue(shape.props.color || 'black'), fontSize: Number(shape.props.fontSize) || 24, fontFamily: 'Arial, sans-serif' }}>{legacyText(shape.props)}</div>
  if (shape.type !== 'geo') return null
  const w = shape.props.w || 100, h = shape.props.h || 100, color = colorValue(shape.props.color || 'black'), geometry = shape.props.geo
  const text = legacyText(shape.props)
  return <svg width={w} height={h} style={{ overflow: 'visible' }}><g fill={shape.props.fill === 'solid' ? color : 'none'} stroke={color} strokeWidth={2.5}>
    {geometry === 'ellipse' ? <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2}/> : geometry === 'triangle' ? <path d={`M${w / 2},0L${w},${h}L0,${h}Z`}/> : geometry === 'diamond' ? <path d={`M${w / 2},0L${w},${h / 2}L${w / 2},${h}L0,${h / 2}Z`}/> : <rect width={w} height={h}/>}
  </g>{text && <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="middle" fill={color} fontSize={20}>{text}</text>}</svg>
})

/** Excalidraw owns pointer interactions; Editor owns the portable document and shared AI/ink history. */
function CanvasScene({ editor, renderShape, children }: WhiteboardCanvasProps & { editor: Editor }) {
  const container = useRef<HTMLDivElement>(null)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const receiving = useRef(false)
  const engineReady = useRef(false)
  const pendingPush = useRef(false)
  const disposed = useRef(false)
  const pointer = useRef<PointerEvent | null>(null)
  const pointerActive = useRef(false)
  const gestureGeneration = useRef(0)
  const renderedImages = useRef(new Map<string, { key: string; file: BinaryFileData }>())
  const imageJobs = useRef(new Map<string, string>())
  const failedImages = useRef(new Map<string, string>())
  const [imageRevision, setImageRevision] = useState(0)
  const [renderError, setRenderError] = useState('')
  const syncRef = useRef<() => void>(() => {})
  const ingestRef = useRef<(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) => void>(() => {})
  const revision = useValue('Canvas revision', () => editor.getRevision(), [editor])
  const editing = editor.getEditingShapeId()
  const camera = editor.getCamera()
  const customShapes = editor.getCurrentPageShapesSorted().filter(isLiveContentShape)
  const nativeFiles = new Map(api?.getSceneElements().filter(element => element.type === 'image').map(element => [element.id, element.fileId]) ?? [])

  useEffect(() => {
    if (!editing) return
    // Keep source controls clear of the persistent inspector and command bar.
    const frame = requestAnimationFrame(() => {
      const bounds = editor.getShapePageBounds(editing), viewport = editor.getViewportScreenBounds()
      if (!bounds) return
      const inspector = container.current?.parentElement?.querySelector('.object-inspector')?.getBoundingClientRect()
      const left = 86, top = 85, right = inspector ? inspector.left - viewport.x - 20 : viewport.w - 30, bottom = viewport.h - 150
      const width = Math.max(160, right - left), height = Math.max(120, bottom - top)
      const current = editor.getCamera()
      const z = Math.max(.1, Math.min(current.z, width / (bounds.w + 40), height / (bounds.h + 70)))
      if (z !== current.z || (bounds.x + current.x) * z < left || (bounds.x + bounds.w + current.x) * z > right || (bounds.y + current.y) * z < top || (bounds.y + bounds.h + current.y) * z + 45 > bottom) {
        editor.setCamera({ x: (left + width / 2) / z - bounds.center.x, y: (top + height / 2) / z - bounds.center.y, z })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [editing, editor])

  const ingest = useCallback((elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) => {
    if (disposed.current || receiving.current) return
    // Excalidraw initializes its own scene asynchronously. Its first empty scene must never
    // replace the notebook that the application may already have restored from IndexedDB.
    if (!engineReady.current) {
      if (state.isLoading) return
      engineReady.current = true
      pendingPush.current = true
      queueMicrotask(() => { if (!disposed.current) syncRef.current() })
      return
    }
    if (pendingPush.current) return
    receiving.current = true
    try {
      const changes = sceneToEditorChanges(editor, elements, files)
      editor.run(() => {
        if (changes.assets.length) editor.createAssets(changes.assets)
        if (changes.creates.length) editor.createShapes(changes.creates)
        if (changes.updates.length) editor.updateShapes(changes.updates)
        if (changes.deletes.length) editor.deleteShapes(changes.deletes)
        const selected = Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id])
        if (!sameIds(editor.getSelectedShapeIds(), selected)) editor.select(...selected)
        const camera = editor.getCamera()
        if (camera.x !== state.scrollX || camera.y !== state.scrollY || camera.z !== state.zoom.value) editor.setCamera({ x: state.scrollX, y: state.scrollY, z: state.zoom.value })
      })
    } finally { receiving.current = false }
  }, [editor])
  ingestRef.current = ingest

  const sync = useCallback(() => {
    pendingPush.current = false
    if (!api || !engineReady.current || api.getAppState().isLoading || disposed.current || receiving.current) return
    const current = api.getSceneElements()
    const renderedFiles = new Map<string, BinaryFileData>()
    for (const shape of editor.getCurrentPageShapes().filter(isLiveContentShape)) {
      const entry = renderedImages.current.get(shape.id)
      if (entry && entry.key === liveContentKey(shape) && editor.getEditingShapeId() !== shape.id) renderedFiles.set(shape.id, entry.file)
    }
    const scene = editorToExcalidrawScene(editor, current, renderedFiles)
    const files = api.getFiles()
    const addedFiles = Object.values(scene.files).filter(file => files[file.id]?.dataURL !== file.dataURL)
    const state = api.getAppState(), camera = editor.getCamera(), styles = editor.getStyleForNextShapes()
    const selectedIds = editor.getSelectedShapeIds().filter(id => scene.elements.some(element => element.id === id))
    const currentIds = Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id])
    const color = colorValue(styles.color), width = getStrokeWidth({ size: styles.size })
    const appState: Partial<AppState> = {}
    if (state.scrollX !== camera.x || state.scrollY !== camera.y || state.zoom.value !== camera.z) Object.assign(appState, { scrollX: camera.x, scrollY: camera.y, zoom: { value: camera.z } })
    if (!sameIds(currentIds, selectedIds)) appState.selectedElementIds = Object.fromEntries(selectedIds.map(id => [id, true]))
    if (state.currentItemStrokeColor !== color) appState.currentItemStrokeColor = color
    if (state.currentItemStrokeWidth !== width) appState.currentItemStrokeWidth = width
    if (state.activeEmbeddable) appState.activeEmbeddable = null
    const changedElements = scene.elements.length !== current.length || scene.elements.some((element, index) => element !== current[index])
    receiving.current = true
    try {
      if (addedFiles.length) api.addFiles(addedFiles)
      if (changedElements || Object.keys(appState).length) api.updateScene({ ...(changedElements ? { elements: scene.elements } : {}), appState: appState as AppState, captureUpdate: CaptureUpdateAction.NEVER })
      const tool = nativeTool(editor.getCurrentToolId())
      if (state.activeTool.type !== tool) api.setActiveTool({ type: tool })
      // Application history includes both native gestures and AI commands. Never retain a second undo stack.
      api.history.clear()
    } finally { receiving.current = false }
  }, [api, editor])
  syncRef.current = sync

  const finishGesture = useCallback(() => {
    if (!api || disposed.current) return
    // A pending push means the application has newer state. updateScene's appState commit is
    // asynchronous, so reading it immediately after that push would restore stale selection/camera.
    if (!pendingPush.current) ingestRef.current(api.getSceneElements(), api.getAppState(), api.getFiles())
    editor.markHistoryStoppingPoint('After canvas gesture')
    pointerActive.current = false
    pointer.current = null
    queueMicrotask(() => { if (!disposed.current) { syncRef.current(); setImageRevision(value => value + 1) } })
  }, [api, editor])

  useEffect(() => {
    const shapes = editor.getCurrentPageShapes().filter(isLiveContentShape)
    const ids = new Set(shapes.map(shape => shape.id))
    for (const id of renderedImages.current.keys()) if (!ids.has(id)) renderedImages.current.delete(id)
    if (pointerActive.current) return
    // A bounded render queue avoids decoding many math/font SVGs at once on a tablet.
    for (const shape of shapes) {
      const key = liveContentKey(shape)
      if (renderedImages.current.get(shape.id)?.key === key || imageJobs.current.has(shape.id) || failedImages.current.get(shape.id) === key) continue
      if (imageJobs.current.size >= 2) break
      imageJobs.current.set(shape.id, key)
      void renderLiveContentImage(shape).then(file => {
        const latest = editor.getShape(shape.id)
        if (disposed.current || !latest || !isLiveContentShape(latest) || liveContentKey(latest) !== key) return
        renderedImages.current.set(shape.id, { key, file })
        failedImages.current.delete(shape.id)
        setRenderError('')
        if (!pointerActive.current) syncRef.current()
      }).catch(error => {
        if (!disposed.current) {
          failedImages.current.set(shape.id, key)
          setRenderError(`Could not prepare a canvas image. Your editable content is preserved. ${error instanceof Error ? error.message : ''}`)
        }
      }).finally(() => {
        imageJobs.current.delete(shape.id)
        if (!disposed.current) setImageRevision(value => value + 1)
      })
    }
  }, [editor, revision, imageRevision])

  useEffect(() => {
    disposed.current = false
    if (!api) return
    syncRef.current()
    const unsubscribe = editor.subscribe(() => {
      if (receiving.current || pendingPush.current) return
      pendingPush.current = true
      queueMicrotask(() => { if (pendingPush.current && !disposed.current) syncRef.current() })
    })
    const removeDown = api.onPointerDown((_tool, _state, event) => {
      pointer.current = event.nativeEvent
      pointerActive.current = true
      gestureGeneration.current++
    })
    const removeUp = api.onPointerUp(() => {
      // Excalidraw finalizes a freehand stroke after emitting pointerup.
      const generation = gestureGeneration.current
      queueMicrotask(() => { if (!disposed.current && pointerActive.current && generation === gestureGeneration.current) finishGesture() })
    })
    editor.setInteractionCompleter(() => {
      if (pointerActive.current && pointer.current) {
        const last = pointer.current
        // Finish the native gesture before AI, Undo, exports, or notebook switching read the scene.
        // Native window listeners remove themselves, so the physical pointerup cannot replay stale geometry.
        flushSync(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: last.pointerId, pointerType: last.pointerType, clientX: last.clientX, clientY: last.clientY, button: last.button, pressure: last.pressure, bubbles: true })))
      }
      finishGesture()
      // Invalidate pointerup's queued completion before the caller applies an AI edit or Undo.
      gestureGeneration.current++
    })
    return () => {
      disposed.current = true
      pendingPush.current = false
      gestureGeneration.current++
      unsubscribe(); removeDown(); removeUp(); editor.setInteractionCompleter(null)
    }
  }, [api, editor, finishGesture])

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { const b = element.getBoundingClientRect(); editor.setViewportScreenBounds({ x: b.x, y: b.y, w: b.width, h: b.height }) }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    window.addEventListener('resize', measure)
    return () => { resize.disconnect(); window.removeEventListener('resize', measure) }
  }, [editor])

  useEffect(() => {
    const stage = container.current?.parentElement
    if (!stage) return
    // The app's magic/text/math overlay sits above Excalidraw. Forward wheel camera controls there.
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(interfaceSelector) || container.current?.contains(event.target)) return
      event.preventDefault()
      const camera = editor.getCamera(), factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        const anchor = editor.screenToPage({ x: event.clientX, y: event.clientY }), bounds = editor.getViewportScreenBounds()
        const z = Math.min(8, Math.max(.1, camera.z * Math.exp(-event.deltaY * factor * .01)))
        editor.setCamera({ x: (event.clientX - bounds.x) / z - anchor.x, y: (event.clientY - bounds.y) / z - anchor.y, z })
      } else editor.setCamera({ ...camera, x: camera.x - (event.shiftKey ? event.deltaY : event.deltaX) * factor / camera.z, y: camera.y - (event.shiftKey ? 0 : event.deltaY) * factor / camera.z })
    }
    const move = (event: PointerEvent) => { if (pointerActive.current && pointer.current?.pointerId === event.pointerId) pointer.current = event }
    const up = () => {
      const generation = gestureGeneration.current
      if (pointerActive.current) queueMicrotask(() => { if (!disposed.current && generation === gestureGeneration.current && pointerActive.current) finishGesture() })
    }
    const cancel = () => { if (pointerActive.current) editor.completeInteraction() }
    stage.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => { stage.removeEventListener('wheel', wheel); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel) }
  }, [editor, finishGesture])

  const receiveApi = useCallback((value: ExcalidrawImperativeAPI) => { engineReady.current = false; setApi(value) }, [])

  return <div ref={container} className={`whiteboard-canvas excalidraw-host${editing ? ' is-editing' : ''}`} role="application" aria-label="Magic Whiteboard canvas"
    onContextMenuCapture={event => { if (!(event.target as Element).closest(inputSelector)) { event.preventDefault(); event.stopPropagation() } }}
    onPointerDownCapture={event => {
      if ((event.target as Element).closest(inputSelector)) return
      if (editing) {
        event.preventDefault(); event.stopPropagation(); flushSourceEdits(); editor.setEditingShape(null)
        const hit = editor.getShapeAtPoint(editor.screenToPage({ x: event.clientX, y: event.clientY }), { hitInside: true, filter: shape => !editor.isShapeOrAncestorLocked(shape) })
        if (hit) editor.select(hit.id); else editor.selectNone()
        return
      }
      if (pendingPush.current) syncRef.current()
      editor.markHistoryStoppingPoint('Canvas gesture')
      pointer.current = event.nativeEvent
      pointerActive.current = true
      gestureGeneration.current++
    }}
    onDoubleClickCapture={event => {
      if ((event.target as Element).closest(inputSelector)) return
      const hit = editor.getShapeAtPoint(editor.screenToPage({ x: event.clientX, y: event.clientY }), { hitInside: true, margin: 12 / editor.getZoomLevel(), filter: shape => !editor.isShapeOrAncestorLocked(shape) })
      if (hit?.type === 'magic' && hit.props.kind !== 'geometry') {
        event.preventDefault(); event.stopPropagation(); editor.completeInteraction(); editor.select(hit.id); editor.setEditingShape(hit.id); editor.setCurrentTool('select.editing_shape')
      } else { event.preventDefault(); event.stopPropagation() }
    }}
    onKeyDownCapture={event => {
      if ((event.target as Element).closest(inputSelector)) return
      // The application toolbar owns the tool set. Preserve native selection/clipboard/navigation shortcuts.
      if (!event.ctrlKey && !event.metaKey && /^[a-z0-9]$/i.test(event.key)) { event.preventDefault(); event.stopPropagation(); return }
      if (event.key === 'Escape') { editor.setEditingShape(null); editor.selectNone() }
      if (!event.repeat && (['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || ((event.ctrlKey || event.metaKey) && ['d', 'x', 'v', 'g', '[', ']'].includes(event.key.toLowerCase())))) editor.markHistoryStoppingPoint('Canvas keyboard edit')
    }}
    onKeyUpCapture={event => { if (!(event.target as Element).closest(inputSelector) && ['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) queueMicrotask(finishGesture) }}>
    <Excalidraw excalidrawAPI={receiveApi} initialData={initialData} onChange={ingest} UIOptions={uiOptions}
      theme="light" zenModeEnabled gridModeEnabled={false} handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false}
      validateEmbeddable={false}/>
    {editing && <div className="whiteboard-editing-shield" aria-hidden="true"/>}
    <div className="whiteboard-live-content" style={{ transform: `translate(${camera.x * camera.z}px,${camera.y * camera.z}px) scale(${camera.z})` }}>
      {customShapes.map(shape => <div key={shape.id} className={`whiteboard-live-shape${editing === shape.id ? ' is-editing' : ''}${editing !== shape.id && renderedImages.current.get(shape.id)?.key === liveContentKey(shape) && nativeFiles.get(shape.id) === renderedImages.current.get(shape.id)?.file.id ? ' is-rendered' : ''}`} data-shape-id={shape.id}
        style={{ transform: editor.getShapePageTransform(shape).toCssString(), width: shape.props.w || 100, height: shape.props.h || 100, opacity: shapeOpacity(editor, shape) }}>
        {shape.type === 'magic' ? renderShape?.(shape, editor) : <LegacyShape shape={shape}/>}
      </div>)}
    </div>
    {renderError && <div className="canvas-render-error" role="alert">{renderError}</div>}
    {children}
    <span className="whiteboard-accessibility">Use the pencil to draw, Select to move objects, and two fingers to zoom. Hold Space to pan. Double-click text or an equation to edit.</span>
  </div>
}

export function WhiteboardCanvas({ onMount, ...props }: WhiteboardCanvasProps) {
  const [editor] = useState(() => new Editor())
  const mount = useRef(onMount)
  mount.current = onMount
  useEffect(() => mount.current?.(editor), [editor])
  return <EditorProvider editor={editor}><CanvasScene {...props} editor={editor}/></EditorProvider>
}
