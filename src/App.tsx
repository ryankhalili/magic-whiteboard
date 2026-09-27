import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { DefaultColorStyle, DefaultSizeStyle, type Editor, type TLShapeId } from './canvas/editor'
import { WhiteboardCanvas } from './canvas/WhiteboardCanvas'
import { ArrowUp, Check, ChevronDown, CircleHelp, Download, Eraser, FileImage, FileUp, Hand, ImagePlus, Keyboard, LoaderCircle, Maximize, Mic, MicOff, Minus, MousePointer2, Pencil, Plus, Redo2, RotateCcw, RotateCw, Save, Scan, Settings2, Sparkles, Trash2, Type, Sigma, Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { createBoardController, getPlacementBounds, MagicShapeView } from './board'
import { finishPointerFollow, focusFromGesture, movePointerFollow, startPointerFollow, type PointerFollow } from './board/interactions'
import { createRealtimeClient, checkVoiceConnection, type ContentPreview } from './ai/realtime'
import { NotebookSwitcher, useNotebookLibrary, saveNotebookSnapshot, loadNotebookSnapshot, type NotebookLibrary } from './notebooks'
import { sendBoardCommand, pairDevice } from './ai/commands'
import { downloadOriginalNotebook, exportBoard, importImageFile, installBoardImageExporter, loadProject, saveProject } from './files/boardFiles'
import { captureBoardContext } from './files/capture'
import { ObjectInspector, objectLabel } from './board/ObjectInspector'
import { flushSourceEdits, snapshotWithPendingSource } from './board/liveSource'
import { DEFAULT_SETTINGS, type AppSettings, type BoardContext, type BoardOperation, type BoardResult, type Bounds, type Focus, type Point } from '../shared/board'

type Tool = 'magic' | 'select' | 'draw' | 'eraser' | 'hand' | 'text' | 'math'
type Message = { id: number; role: 'user' | 'assistant' | 'event'; text: string }
type ApiStatus = { configured: boolean; authorized: boolean; pairingRequired: boolean; pairingCode?: string; models?: { text: string; realtime: string } }
const COLORS = ['#202124', '#2563eb', '#dc2626', '#15803d', '#7c3aed']
const INK_COLORS = ['black', 'blue', 'red', 'green', 'violet'] as const
let messageId = 0

export default function App() {
  const library = useNotebookLibrary()
  return <NotebookWorkspace key={library.activeNotebook.id} library={library}/>
}

function NotebookWorkspace({ library }: { library: NotebookLibrary }) {
  const notebook = library.activeNotebook
  const editorRef = useRef<Editor | null>(null)
  const controller = useRef<ReturnType<typeof createBoardController> | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<Focus | null>(null)
  const pointerRef = useRef<Point | null>(null)
  const gestureRef = useRef<BoardContext['gesture']>(null)
  const followRef = useRef<PointerFollow | null>(null)
  const pathRef = useRef<Point[]>([])
  const pendingNewContent = useRef<string | null>(null)
  const touches = useRef(new Map<number, Point>())
  const pinch = useRef<{ distance: number; zoom: number; anchor: Point } | null>(null)
  const voiceRef = useRef<ReturnType<typeof createRealtimeClient> | null>(null)
  const voiceOrbRef = useRef<HTMLButtonElement>(null)
  const contentSelectionRef = useRef<BoardContext['contentSelection']>(undefined)
  const dictationRef = useRef<'assistant' | 'math' | 'text'>('assistant')
  const inputRef = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const importAsBackground = useRef(true)
  const snapshotReady = useRef(false)
  const snapshotFailed = useRef(false)
  const snapshotLoad = useRef<Promise<void>>(Promise.resolve())
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const settings = notebook.settings
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const setSettings = useCallback((update: React.SetStateAction<AppSettings>) => {
    const next = typeof update === 'function' ? update(settingsRef.current) : update
    settingsRef.current = next
    library.updateNotebookSettings(notebook.id, next)
  }, [library.updateNotebookSettings, notebook.id])
  const focusModeRef = useRef<'reference' | 'literal'>(notebook.settings.focusMode ?? 'reference')
  focusModeRef.current = settings.focusMode ?? 'reference'
  const [tool, setTool] = useState<Tool>('magic')
  const [color, setColor] = useState(COLORS[0])
  const [inkSize, setInkSize] = useState<'s' | 'm'>('m')
  const [ready, setReady] = useState(false)
  const [tick, setTick] = useState(0)
  const [path, setPath] = useState<Point[]>([])
  const [focus, setFocusState] = useState<Focus | null>(null)
  const [following, setFollowing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('idle')
  const [voiceMode, setVoiceMode] = useState(false)
  const [dictationMode, setDictationMode] = useState<'assistant' | 'math' | 'text'>('assistant')
  const [contentPreview, setContentPreview] = useState<ContentPreview | null>(null)
  const [spokenReplies, setSpokenReplies] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<'paper' | 'export' | 'help' | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [api, setApi] = useState<ApiStatus | null>(null)
  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [checkingVoice, setCheckingVoice] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [selectedContent, setSelectedContent] = useState('')
  const [saveState, setSaveState] = useState('Opening notebook…')

  const notify = useCallback((text: string) => { setToast(text) }, [])
  const addMessage = useCallback((role: Message['role'], text: string) => {
    if (text.trim()) setMessages(prev => [...prev.slice(-29), { id: ++messageId, role, text }])
  }, [])
  const setFocus = useCallback((next: Focus | null) => { focusRef.current = next; setFocusState(next) }, [])
  const getContext = useCallback((): BoardContext => {
    const editor = editorRef.current
    const vp = editor?.getViewportPageBounds()
    const gestureFocus = editor && gestureRef.current?.active ? focusFromGesture(editor, gestureRef.current) : null
    const chosenFocus = gestureFocus ?? focusRef.current
    const currentFocus = chosenFocus ? { ...chosenFocus, targetIds: chosenFocus.targetIds.filter(id => editor?.getShape(id as TLShapeId)) } : null
    const selectedIds = gestureFocus?.targetIds.length ? gestureFocus.targetIds : editor?.getSelectedShapeIds() as string[] || []
    const important = new Set([...selectedIds, ...(currentFocus?.targetIds || []), ...(controller.current?.lastCreatedIds || [])])
    const boardObjects = controller.current?.getObjects() || []
    const relevantObjects = [...boardObjects.filter(o => important.has(o.id)), ...boardObjects.filter(o => !important.has(o.id)).reverse()].slice(0, 120)
    return {
      focus: currentFocus,
      focusMode: focusModeRef.current,
      pointer: pointerRef.current,
      selectedIds,
      lastCreatedIds: controller.current?.lastCreatedIds || [],
      viewport: vp ? { x: vp.x, y: vp.y, w: vp.w, h: vp.h } : { x: 0, y: 0, w: 1200, h: 800 },
      objects: relevantObjects, gesture: gestureRef.current,
      dictationMode: dictationRef.current,
      contentSelection: contentSelectionRef.current && selectedIds.includes(contentSelectionRef.current.shapeId) ? contentSelectionRef.current : undefined,
    }
  }, [])
  const getVisualContext = useCallback(async () => {
    if (!editorRef.current) return null
    flushSourceEdits({ finishHistory: false })
    return captureBoardContext(editorRef.current, getContext().focus)
  }, [getContext])

  const stopFollowing = useCallback(() => {
    const follower = followRef.current
    followRef.current = null; setFollowing(false)
    if (follower && editorRef.current) finishPointerFollow(editorRef.current, follower)
  }, [])
  const execute = useCallback((ops: BoardOperation[]): BoardResult => {
    if (!controller.current) return { ok: false, message: 'The board is still loading.', ids: [] }
    const editor = editorRef.current!
    flushSourceEdits()
    editor.completeInteraction()
    // Finish an earlier drag before the next edit changes its geometry or history.
    stopFollowing()
    const followMark = ops.some(o => o.followPointer) ? editor.markHistoryStoppingPoint('Follow pointer instruction') : null
    const result = controller.current.applyOperations(ops)
    if (result.ok) {
      notify(result.message)
      if (followMark && result.ids.length) {
        const p = pointerRef.current || { x: 0, y: 0 }
        const context = getContext()
        const constraint = context.focusMode === 'literal' && context.focus?.kind === 'region' ? context.focus.bounds : undefined
        followRef.current = startPointerFollow(editor, result.ids, p, followMark, constraint)
        setFollowing(followRef.current.ids.length > 0)
        // Following must remain placeable even if the command was issued in another tool.
        setTool('magic'); editor.setCurrentTool('select')
      }
    } else setError(result.message)
    return result
  }, [notify, stopFollowing, getContext])
  const executeManual = useCallback((ops: BoardOperation[]): BoardResult => {
    const ed = editorRef.current
    if (!ed) return { ok: false, message: 'The board is still loading.', ids: [] }
    flushSourceEdits()
    ed.completeInteraction(); stopFollowing()
    // Explicit inspector controls follow their selected object, independently of the AI focus cue.
    const manualController = createBoardController(ed, () => ({ ...getContext(), focus: null, focusMode: 'reference' }))
    const result = manualController.applyOperations(ops)
    if (result.ok) notify(result.message); else setError(result.message)
    return result
  }, [getContext, notify, stopFollowing])

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4200); return () => clearTimeout(id) }, [toast])
  useEffect(() => { fetch('/api/status').then(r => r.json()).then(setApi).catch(() => setError('The local AI server is not reachable. Drawing still works.')) }, [])
  useEffect(() => () => voiceRef.current?.disconnect(), [])
  useEffect(() => { voiceRef.current?.updateContext() }, [settings.focusMode])
  useEffect(() => {
    const onSelection = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail?.shapeId || !['text', 'latex', 'expression'].includes(detail.field)) { contentSelectionRef.current = undefined; setSelectedContent(''); return }
      contentSelectionRef.current = { shapeId: detail.shapeId, field: detail.field, text: detail.text || '', coordinateSpace: detail.coordinateSpace, ...(detail.coordinateSpace === 'text' ? { start: detail.start, end: detail.end } : {}) }
      setSelectedContent(detail.text || '')
      voiceRef.current?.updateContext()
    }
    window.addEventListener('marginalia-content-selection', onSelection)
    return () => window.removeEventListener('marginalia-content-selection', onSelection)
  }, [])

  const flushNotebook = useCallback(async () => {
    if (busy) throw new Error('Wait for the current instruction or import to finish before switching notebooks.')
    await snapshotLoad.current
    const ed = editorRef.current
    if (snapshotFailed.current) {
      voiceRef.current?.disconnect()
      stopFollowing()
      return // Keep the unreadable saved notebook intact; allow opening another notebook.
    }
    if (!ed || !snapshotReady.current) throw new Error('Wait for the notebook to finish opening before switching.')
    flushSourceEdits()
    ed.completeInteraction()
    voiceRef.current?.disconnect()
    stopFollowing()
    clearTimeout(snapshotTimer.current)
    setSaveState('Saving…')
    try { await saveNotebookSnapshot(notebook.id, ed.getSnapshot()); setSaveState('Saved on this device') }
    catch (error) { setSaveState('Not saved'); throw error }
  }, [notebook.id, busy, stopFollowing])

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    installBoardImageExporter(editor)
    controller.current = createBoardController(editor, getContext)
    editor.user.updateUserPreferences({ colorScheme: 'light' })
    editor.setCurrentTool('select')
    editor.updateInstanceState({ isGridMode: false })
    editor.setStyleForNextShapes(DefaultColorStyle, 'black')
    let disposed = false, frame = 0
    let unlisten = () => {}, unpersist = () => {}
    snapshotReady.current = false
    snapshotFailed.current = false
    setReady(false)
    const initialize = async () => {
      const saved = await loadNotebookSnapshot(notebook.id, notebook.persistenceKey)
      if (disposed) return
      if (saved) editor.loadSnapshot(saved)
      editor.setEditingShape(null); editor.setCurrentTool('select')
    // Normalize the earlier prototype theme once, preserving all object content and positions.
    const migrationKey = `marginalia-plain-theme:${notebook.id}`
    try {
      if (!localStorage.getItem(migrationKey)) {
        const oldColors = new Set(['#325d4b', '#187e77', '#bc684d', '#2e3850', '#6961a6', '#c09835'])
        editor.run(() => editor.updateShapes(editor.getCurrentPageShapes().filter(s => s.type === 'magic' && oldColors.has(s.props.color)).map(s => ({ id: s.id, type: 'magic' as const, props: { color: '#202124' } }))), { history: 'ignore' })
        localStorage.setItem(migrationKey, '1')
      }
    } catch { /* Editing remains available if local preferences cannot be stored. */ }
      snapshotReady.current = true
      setReady(true); setSaveState('Saved on this device')
      unlisten = editor.store.listen(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick(n => n + 1) })
      })
      unpersist = editor.store.listen(() => {
        clearTimeout(snapshotTimer.current); setSaveState('Saving…')
        snapshotTimer.current = setTimeout(() => {
          const snapshot = snapshotWithPendingSource(editor, { finishHistory: false })
          // A flushed edit may schedule another checkpoint; this snapshot already includes it.
          clearTimeout(snapshotTimer.current)
          void saveNotebookSnapshot(notebook.id, snapshot).then(() => { if(!disposed) setSaveState('Saved on this device') }).catch(error => { if(!disposed) {setSaveState('Not saved');setError((error as Error).message)} })
        }, 150)
      }, { scope: 'document' })
      await saveNotebookSnapshot(notebook.id, editor.getSnapshot())
    }
    snapshotLoad.current = initialize().catch(error => {
      if (!disposed) {
        // A restored board whose first checkpoint failed still needs a successful
        // save before switching; only a failed restore can skip saving safely.
        snapshotFailed.current = !snapshotReady.current
        setSaveState(snapshotReady.current ? 'Not saved' : 'Could not restore notebook')
        setError((error as Error).message)
      }
    })
    return () => {
      disposed = true; unlisten(); unpersist(); cancelAnimationFrame(frame); clearTimeout(snapshotTimer.current)
      if (snapshotReady.current) void saveNotebookSnapshot(notebook.id, snapshotWithPendingSource(editor, { silent: true })).catch(() => {})
      snapshotReady.current = false
    }
  }, [getContext, notebook.id])
  useEffect(() => {
    const saveBeforeLeaving = () => { if(snapshotReady.current && editorRef.current) void saveNotebookSnapshot(notebook.id,snapshotWithPendingSource(editorRef.current, { silent: true })).catch(()=>{}) }
    const restoreAfterLeaving = () => { flushSourceEdits({ finishHistory: false }) }
    window.addEventListener('pagehide',saveBeforeLeaving)
    window.addEventListener('pageshow',restoreAfterLeaving)
    return () => { window.removeEventListener('pagehide',saveBeforeLeaving); window.removeEventListener('pageshow',restoreAfterLeaving) }
  },[notebook.id])

  const chooseTool = useCallback((next: Tool) => {
    flushSourceEdits()
    setTool(next); stopFollowing()
    editorRef.current?.setEditingShape(null)
    editorRef.current?.setCurrentTool(['magic', 'math', 'text'].includes(next) ? 'select' : next)
  }, [stopFollowing])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement
      if (el.closest('input,textarea,[contenteditable=true],math-field,.marginalia-inline-editor')) return
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyZ' || event.code === 'KeyY')) {
        event.preventDefault(); event.stopImmediatePropagation()
        execute([{ type: event.code === 'KeyY' || event.shiftKey ? 'redo' : 'undo' }]); return
      }
      if (event.code === 'Escape') { stopFollowing(); setFocus(null); setMenu(null); setError('') }
      if (event.code === 'KeyM' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); chooseTool('magic') }
      if (event.code === 'KeyP' && !event.ctrlKey && !event.metaKey) chooseTool('draw')
      if (event.code === 'KeyV' && !event.ctrlKey && !event.metaKey) chooseTool('select')
      if (event.code === 'KeyE' && !event.ctrlKey && !event.metaKey) chooseTool('eraser')
      if (event.code === 'KeyH' && !event.ctrlKey && !event.metaKey) chooseTool('hand')
      if (event.code === 'KeyT' && !event.ctrlKey && !event.metaKey) chooseTool('text')
      if (event.code === 'KeyQ' && !event.ctrlKey && !event.metaKey) chooseTool('math')
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') { event.preventDefault(); inputRef.current?.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [chooseTool, stopFollowing, setFocus, execute])

  const editor = editorRef.current
  const objects = useMemo(() => ready ? controller.current?.getObjects() || [] : [], [ready, editor, tick])
  const selectedIds = editor?.getSelectedShapeIds() || []
  const selected = objects.find(o => selectedIds.includes(o.id as TLShapeId))
  const selectedRecord = selected ? editor?.getShape(selected.id as TLShapeId) : undefined
  const shapeCount = objects.length
  const camera = editor?.getCamera()
  const zoom = camera?.z || 1
  const editingShapeId = editor?.getEditingShapeId()
  useEffect(() => { if (selected?.id) setInspectorOpen(true) }, [selected?.id])

  const pageToLocal = (p: Point): Point => {
    const b = stageRef.current?.getBoundingClientRect()
    const v = editor?.pageToScreen(p) || p
    return { x: v.x - (b?.left || 0), y: v.y - (b?.top || 0) }
  }
  const localBounds = (b: Bounds) => { const p = pageToLocal(b); return { left: p.x, top: p.y, width: b.w * zoom, height: b.h * zoom } }

  const pointerMove = (event: React.PointerEvent) => {
    if (!editorRef.current) return
    if ((event.target as HTMLElement).closest('button,input,textarea,aside,nav,.command-dock,.popover,.board-options,.canvas-footer,.empty-board')) return
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pinch.current && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        const z = Math.max(.1, Math.min(5, pinch.current.zoom * distance / pinch.current.distance))
        const viewport = editorRef.current.getViewportScreenBounds()
        editorRef.current.setCamera({ x: ((a.x + b.x) / 2 - viewport.x) / z - pinch.current.anchor.x, y: ((a.y + b.y) / 2 - viewport.y) / z - pinch.current.anchor.y, z })
        return
      }
    }
    const point = editorRef.current.screenToPage({ x: event.clientX, y: event.clientY })
    pointerRef.current = point
    const follower = followRef.current
    if (follower) movePointerFollow(editorRef.current, follower, point)
    if (!gestureRef.current?.active) return
    pathRef.current.push(point)
    const xs = pathRef.current.map(p => p.x), ys = pathRef.current.map(p => p.y)
    const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    gestureRef.current = { ...gestureRef.current, current: point, bounds: b }
    setPath([...pathRef.current])
  }
  const magicDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !editorRef.current || !ready) return
    if (tool === 'text' || tool === 'math') {
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      const point = editorRef.current.screenToPage({ x: event.clientX, y: event.clientY })
      const result = execute([{ type: tool === 'math' ? 'create_math' : 'create_text', latex: '', text: '', bounds: { ...point, w: 400, h: tool === 'math' ? 100 : 140 }, fontSize: tool === 'math' ? 28 : 22, color }])
      if (result.ok && result.ids[0]) pendingNewContent.current = result.ids[0]
      return
    }
    contentSelectionRef.current = undefined; setSelectedContent('')
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()]
        pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: editorRef.current.getZoomLevel(), anchor: editorRef.current.screenToPage({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) }
        gestureRef.current = null; setPath([]); event.currentTarget.setPointerCapture(event.pointerId); return
      }
    }
    if (followRef.current) {
      const destination = editorRef.current.screenToPage({ x: event.clientX, y: event.clientY })
      pointerRef.current = destination
      movePointerFollow(editorRef.current, followRef.current, destination)
      stopFollowing(); notify('Placed here.'); voiceRef.current?.updateContext(); return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = editorRef.current.screenToPage({ x: event.clientX, y: event.clientY })
    pointerRef.current = point; pathRef.current = [point]; setPath([point])
    gestureRef.current = { active: true, bounds: { ...point, w: 0, h: 0 }, start: point, current: point }
  }
  const magicUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pendingNewContent.current) {
      event.preventDefault(); event.stopPropagation()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      const id = pendingNewContent.current; pendingNewContent.current = null
      beginEditing(id)
      return
    }
    touches.current.delete(event.pointerId)
    if (pinch.current) { if (touches.current.size < 2) pinch.current = null; gestureRef.current = null; return }
    const g = gestureRef.current; const ed = editorRef.current
    if (!g?.active || !ed) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const nextFocus = focusFromGesture(ed, g)
    if (nextFocus.targetIds.length) ed.select(...nextFocus.targetIds as TLShapeId[])
    setFocus(nextFocus)
    gestureRef.current = null; pathRef.current = []; setPath([])
    voiceRef.current?.updateContext()
  }

  const runPrompt = async (text = prompt) => {
    if (!text.trim() || busy) return
    if (api?.pairingRequired && !api.authorized) { setError('Enter the pairing code shown in Help on your laptop to connect this device.'); return }
    setPrompt(''); setError(''); addMessage('user', text); setBusy(true)
    try {
      if (voiceRef.current?.isConnected()) { voiceRef.current.sendText(text); return }
      const needsImage = editorRef.current?.getCurrentPageShapes().some(s => s.type === 'image' || s.type === 'draw')
      const visual = needsImage ? await getVisualContext() : null
      const result = await sendBoardCommand(text, getContext(), messages.filter(m => m.role !== 'event').slice(-8).map(m => ({ role: m.role as 'user' | 'assistant', text: m.text })), visual || undefined)
      const applied = result.operations.length ? execute(result.operations) : null
      addMessage('assistant', applied && !applied.ok ? applied.message : result.message || applied?.message || 'Done.')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const toggleVoice = async () => {
    if (voiceStatus !== 'idle') { voiceRef.current?.disconnect(); setVoiceStatus('idle'); setLiveTranscript(''); return }
    setError('')
    if (api?.pairingRequired && !api.authorized) { setError('Connect this device with the laptop pairing code before starting voice.'); return }
    if (!window.isSecureContext) { setError('Microphone access needs HTTPS on your iPad. Use the secure preview address; localhost works on this computer.'); return }
    setVoiceMode(true)
    try {
      const client = createRealtimeClient({
        getContext, getVisualContext, applyOperations: execute,
        onAudioLevel: level => voiceOrbRef.current?.style.setProperty('--mic-level', String(level)),
        onContentPreview: handleContentPreview,
        onStatus: setVoiceStatus,
        onTranscript: (text: string, final: boolean) => { setLiveTranscript(text); if (final) addMessage('user', text) },
        onAssistant: (text: string, final: boolean) => { if (final) { addMessage('assistant', text); setLiveTranscript('') } },
        onError: (text: string) => setError(text), spokenReplies,
      })
      voiceRef.current = client
      await client.connect()
      chooseTool('magic')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setVoiceStatus('idle') }
  }

  const pair = async () => {
    setPairing(true); setError('')
    try {
      await pairDevice(pairCode)
      setApi(await (await fetch('/api/status')).json())
    } catch (e) { setError((e as Error).message) }
    finally { setPairing(false) }
  }
  const handleContentPreview = useCallback((preview: ContentPreview | null) => {
    if (!preview) { setContentPreview(null); window.dispatchEvent(new CustomEvent('marginalia-content-preview', { detail: null })); return }
    const context = getContext()
    const isUpdate = preview.operationType === 'update_object' || preview.operationType === 'edit_content'
    const target = isUpdate ? preview.target && !['selected', 'focus', 'last'].includes(preview.target) ? preview.target
      : context.contentSelection?.shapeId || context.selectedIds[0] || context.focus?.targetIds[0] || context.lastCreatedIds[0] : undefined
    if (target) {
      window.dispatchEvent(new CustomEvent('marginalia-content-preview', { detail: { ...preview, target } })); setContentPreview(null)
    } else { setContentPreview(preview) }
  }, [getContext])
  const beginEditing = (id: string) => {
    const ed = editorRef.current
    const shape = ed?.getShape(id as TLShapeId)
    if (!ed || shape?.type !== 'magic' || shape.props.kind === 'geometry') return
    flushSourceEdits()
    stopFollowing(); setTool('select'); ed.setCurrentTool('select'); ed.select(shape.id)
    ed.setEditingShape(shape.id); ed.setCurrentTool('select.editing_shape', {})
    setFocus(null)
    setInspectorOpen(true); setShowHistory(false)
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('marginalia-focus-editor', { detail: { shapeId: shape.id } })))
  }
  const editAtPointer = (event: React.MouseEvent) => {
    const ed = editorRef.current
    if (!ed) return
    const point = ed.screenToPage({ x: event.clientX, y: event.clientY })
    const hit = ed.getShapeAtPoint(point, { hitInside: true, margin: 12 / ed.getZoomLevel(), filter: s => !s.isLocked })
    if (hit) beginEditing(hit.id)
  }
  const changeDictation = (mode: 'assistant' | 'math' | 'text') => {
    dictationRef.current = mode; setDictationMode(mode); voiceRef.current?.updateContext()
  }
  const formalizeSelection = () => void runPrompt('Clean up the handwriting in my focused region into editable text and LaTeX, preserving the original meaning and position. Use separate text and math objects where appropriate. Replace only the selected handwritten ink after creating the clean objects successfully; keep any background image. If the writing is unclear, ask me instead of guessing.')
  const testVoice = async () => {
    setCheckingVoice(true); setError('')
    try { await checkVoiceConnection(getContext()); notify('Voice connection verified. The microphone was not activated.') }
    catch (e) { setError((e as Error).message) }
    finally { setCheckingVoice(false) }
  }
  const doExport = async (format: 'png' | 'pdf') => {
    if (!editor) return
    flushSourceEdits(); editor.completeInteraction(); stopFollowing()
    setMenu(null); setBusy(true)
    try { await exportBoard(editor, format, settings); notify(`${format.toUpperCase()} exported.`) } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const importImage = async (file: File) => {
    if (!editorRef.current) return
    flushSourceEdits(); editorRef.current.completeInteraction()
    stopFollowing()
    setBusy(true)
    try {
      await importImageFile(editorRef.current, file, { asBackground: importAsBackground.current, mode: settings.mode, focus: focusRef.current?.bounds })
      notify(importAsBackground.current ? 'Background added. You can write over it.' : 'Image added.'); setMenu(null)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,[contenteditable=true],math-field,.marginalia-inline-editor')) return
      const image = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith('image/'))
      if (image) { event.preventDefault(); event.stopImmediatePropagation(); importAsBackground.current = true; void importImage(image) }
    }
    window.addEventListener('paste', paste, true)
    return () => window.removeEventListener('paste', paste, true)
  }, [settings.mode])

  const example = () => {
    const ed = editorRef.current
    if (!ed) return
    const result = execute([
      { type: 'create_text', text: 'A study in waves', title: 'Notes', bounds: { x: 110, y: 70, w: 360, h: 100 }, fontSize: 30, color: '#202124' },
      { type: 'create_plot', expression: 'sin(x)', title: '', xMin: 0, xMax: 4 * Math.PI, yMin: -1.5, yMax: 1.5, bounds: { x: 110, y: 190, w: 650, h: 380 }, color: '#202124' },
      { type: 'create_math', latex: '\\int_0^{2\\pi} \\sin(x)\\,dx = 0', bounds: { x: 800, y: 220, w: 390, h: 140 } },
      { type: 'create_geometry', geometry: 'right_triangle', bounds: { x: 850, y: 410, w: 210, h: 170 }, color: '#202124' },
    ])
    if (!result.ok) return
    ed.selectNone(); ed.zoomToBounds({ x: -70, y: -100, w: 1530, h: 900 }, { animation: { duration: 350 } }); setFocus(null)
    setSettings(s => ({ ...s, name: 'A study in waves' })); notify('Example objects added. Select one and make it your own.')
  }
  const worksheetExample = async () => {
    const ed = editorRef.current
    if (!ed || busy) return
    flushSourceEdits(); ed.completeInteraction()
    stopFollowing(); setBusy(true); setError('')
    try {
      const response = await fetch('/sample-homework.png')
      if (!response.ok) throw new Error('The sample worksheet could not be loaded.')
      const file = new File([await response.blob()], 'Sample homework.png', { type: 'image/png' })
      await importImageFile(ed, file, { asBackground: true, mode: 'page' })
      setSettings(s => ({ ...s, name: 'A little algebra', mode: 'page' })); setFocus(null); setMenu(null)
      notify('A sample homework page. Circle a question and ask about it.')
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const removeBackground = () => {
    if (!editor) return
    flushSourceEdits(); editor.completeInteraction()
    stopFollowing(); editor.markHistoryStoppingPoint('Remove background')
    editor.run(() => editor.deleteShapes(editor.getCurrentPageShapes().filter(s => s.meta.marginaliaBackground === true).map(s => s.id)), { ignoreShapeLock: true })
    setMenu(null); notify('Background removed. Undo will restore it.')
  }
  const save = () => { if (editor) { flushSourceEdits(); editor.completeInteraction(); stopFollowing(); saveProject(editor, settings); notify('Editable notebook downloaded.') } }
  const downloadOriginal = async () => {
    try { await downloadOriginalNotebook(notebook.id, settings); notify('Original notebook backup downloaded. Your current board is unchanged.') }
    catch (error) { setError((error as Error).message) }
  }
  const changeMode = (mode: AppSettings['mode']) => {
    setSettings(s => ({ ...s, mode })); setMenu(null)
    if (mode === 'page') editor?.zoomToBounds({ x: -100, y: -70, w: 994, h: 1313 }, { animation: { duration: 350 } })
  }
  const changeFocusMode = (mode: 'reference' | 'literal') => {
    stopFollowing()
    focusModeRef.current = mode
    setSettings(s => ({ ...s, focusMode: mode }))
    setError('')
    notify(mode === 'literal' ? 'Literal: AI changes stay inside your selected area.' : 'Reference: your selection guides placement; content can extend beyond it.')
  }
  const resetGraphSize = () => {
    if (selected?.kind !== 'plot') return
    const size = getPlacementBounds({ type: 'create_plot', placement: 'auto' }, { ...getContext(), focusMode: 'reference' }, 'plot')
    const bounds = { x: selected.bounds.x + (selected.bounds.w - size.w) / 2, y: selected.bounds.y + (selected.bounds.h - size.h) / 2, w: size.w, h: size.h }
    executeManual([{ type: 'update_object', target: selected.id, bounds, axisMode: 'equal' }])
  }

  const origin = pageToLocal({ x: 0, y: 0 })
  const paperStyle = { '--paper-color': settings.backgroundColor, '--grid-step': `${(settings.paper === 'ruled' ? 32 : 24) * zoom}px`, '--paper-x': `${origin.x}px`, '--paper-y': `${origin.y}px` } as React.CSSProperties
  const isEditing = !!editingShapeId
  const selectionHasInk = editor?.getSelectedShapes().some(s => s.type === 'draw') || false
  const previewContext = contentPreview ? getContext() : null
  let previewBounds: Bounds | null = null
  if (previewContext && contentPreview) {
    try {
      const kind = contentPreview.field === 'latex' ? 'math' : contentPreview.field === 'expression' ? 'plot' : 'text'
      previewBounds = getPlacementBounds({ type: `create_${kind}` as BoardOperation['type'], bounds: contentPreview.bounds }, previewContext, kind)
    } catch { /* Wait for validated final bounds when a partial instruction cannot fit. */ }
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="header-left"><span className="brand">Magic Whiteboard</span><NotebookSwitcher library={library} beforeChange={flushNotebook}/></div>
      <div className="document-title"><input aria-label="Notebook title" value={settings.name} onChange={e => setSettings(s => ({ ...s, name: e.target.value }))}/><span><Check size={12}/>{saveState}</span></div>
      <div className="header-actions">
        <button aria-label={voiceMode ? 'Type' : 'Voice mode'} className={`plain-button voice-mode-toggle ${voiceMode ? 'active' : ''}`} onClick={() => { if (voiceMode) setVoiceMode(false); else { setVoiceMode(true); if (voiceStatus === 'idle') void toggleVoice() } }}>{voiceMode ? <Keyboard size={18}/> : <Mic size={18}/>}<span>{voiceMode ? 'Type' : 'Voice mode'}</span></button>
        <button aria-label="Background" className="plain-button hide-small" onClick={() => { importAsBackground.current = true; imageInput.current?.click() }}><ImagePlus size={17}/><span>Background</span></button>
        <button aria-label="Export" className="export-button" onClick={() => setMenu(menu === 'export' ? null : 'export')}><Download size={16}/><span>Export</span><ChevronDown size={13}/></button>
      </div>
    </header>

    <main ref={stageRef} className={`board-stage paper-${settings.paper} mode-${settings.mode}`} style={paperStyle} onPointerMoveCapture={pointerMove} onDragOver={e => e.preventDefault()} onDropCapture={e => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); e.stopPropagation(); importAsBackground.current = true; void importImage(f) } }}>
      <div className="paper-pattern"/>
      {ready && settings.mode === 'page' && <div className="page-boundary" style={localBounds({ x: 0, y: 0, w: 794, h: 1123 })}><span>A4</span></div>}
      <WhiteboardCanvas persistenceKey={notebook.persistenceKey} onMount={onMount} renderShape={shape => shape.type === 'magic' ? <MagicShapeView shape={shape}/> : null}/>
      {!ready && <div className="notebook-loading">Opening notebook…</div>}
      {['magic', 'text', 'math'].includes(tool) && <div className={`magic-surface ${following ? 'is-following' : ''}`} onPointerDown={magicDown} onPointerUp={magicUp} onDoubleClick={editAtPointer} onPointerCancel={() => { gestureRef.current = null; pathRef.current = []; touches.current.clear(); pinch.current = null; setPath([]) }}/>}
      <svg className="gesture-overlay" aria-hidden="true">{path.length > 1 && <path d={path.map((p, i) => { const v = pageToLocal(p); return `${i ? 'L' : 'M'} ${v.x} ${v.y}` }).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}</svg>
      {focus && !path.length && !isEditing && <div className={`magic-focus ${focus.kind} focus-${settings.focusMode ?? 'reference'}`} style={focus.kind === 'region' ? localBounds(focus.bounds) : { left: pageToLocal(focus.bounds).x - 12, top: pageToLocal(focus.bounds).y - 12 }}><span>{focus.kind === 'region' ? `Work here · ${settings.focusMode === 'literal' ? 'Literal' : 'Reference'}` : settings.focusMode === 'literal' ? 'Circle an area for Literal mode' : 'Reference point'}</span></div>}
      {contentPreview && previewBounds && <div className="streaming-preview" style={{...localBounds(previewBounds), fontSize: 28 * zoom, ...(settings.focusMode === 'literal' ? {overflow:'hidden'} : {})}}>{contentPreview.field === 'latex' ? <span dangerouslySetInnerHTML={{ __html: katex.renderToString(contentPreview.value, {throwOnError:false,trust:false,maxExpand:300,strict:'ignore'}) }}/> : <span>{contentPreview.field === 'expression' ? 'y = ' : ''}{contentPreview.value}</span>}<span className="streaming-caret"/></div>}

      <div className="board-options"><button onClick={() => setMenu(menu === 'paper' ? null : 'paper')}><Settings2 size={14}/>{settings.mode === 'page' ? 'A4 page' : 'Infinite canvas'}<ChevronDown size={12}/></button><label className="work-area-control" title={settings.focusMode === 'literal' ? 'AI changes must fit within the selected region.' : 'Use the selected region as a location cue, with room to grow.'}>Work here<select aria-label="Work area mode" value={settings.focusMode ?? 'reference'} onChange={e=>changeFocusMode(e.target.value as 'reference' | 'literal')}><option value="reference">Reference</option><option value="literal">Literal</option></select></label>{objects.length > 0 && <select className="object-picker" aria-label="Choose board object" value={selected?.id || ''} onChange={event => { if (!event.target.value || !editor) return; editor.completeInteraction(); chooseTool('select'); editor.select(event.target.value); setInspectorOpen(true); setShowHistory(false) }}><option value="">Objects ({objects.length})</option>{objects.map(object => <option key={object.id} value={object.id}>{object.locked ? '🔒 ' : ''}{objectLabel(object)}</option>)}</select>}<button aria-label="Help and pairing" title="Help and pairing" onClick={() => { setMenu(menu === 'help' ? null : 'help'); void fetch('/api/status').then(r=>r.json()).then(setApi) }}><CircleHelp size={16}/></button></div>
      <nav className="tool-rail" aria-label="Drawing tools">
        {([{ id: 'magic', label: 'Magic pen', key: 'M', icon: Sparkles }, { id: 'draw', label: 'Pencil', key: 'P', icon: Pencil }, { id: 'select', label: 'Select & move', key: 'V', icon: MousePointer2 }, { id: 'text', label: 'Text', key: 'T', icon: Type }, { id: 'math', label: 'Math', key: 'Q', icon: Sigma }, { id: 'eraser', label: 'Eraser', key: 'E', icon: Eraser }, { id: 'hand', label: 'Pan', key: 'H', icon: Hand }] as const).map(({ id, label, key, icon: Icon }) => <button key={id} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} className={tool === id ? 'active' : ''} onClick={() => chooseTool(id)}><Icon size={21}/><span className="tool-tip">{label}<kbd>{key}</kbd></span></button>)}
        <div className="rail-divider"/>
        <div className="color-stack">{COLORS.map((c, i) => <button aria-label={`Ink color ${INK_COLORS[i]}`} key={c} className={color === c ? 'chosen' : ''} style={{ '--ink': c } as React.CSSProperties} onClick={() => { setColor(c); editor?.setStyleForNextShapes(DefaultColorStyle, INK_COLORS[i]); if (selectedRecord?.type === 'magic') execute([{ type: 'update_object', target: selected!.id, color: c }]); else editor?.setStyleForSelectedShapes(DefaultColorStyle, INK_COLORS[i]) }}/>)}</div>
        <div className="rail-divider"/><button title={`${inkSize === 's' ? 'Thin' : 'Medium'} ink · click to change`} aria-label="Change ink width" onClick={() => { const size = inkSize === 's' ? 'm' : 's'; setInkSize(size); editor?.setStyleForNextShapes(DefaultSizeStyle, size); notify(`${size === 's' ? 'Thin' : 'Medium'} ink selected.`) }}><span className="stroke-preview" style={{ height: inkSize === 's' ? 2 : 3 }}/></button>
      </nav>
      {['math','text'].includes(tool) && <div className="tool-instruction">Tap anywhere to write {tool === 'math' ? 'an equation' : 'text'}.</div>}
      {!shapeCount && ready && !['text','math'].includes(tool) && <div className="empty-board"><h1>Blank notebook</h1><p>Write with the pencil, type a note, or circle an area and ask for something.</p><div className="example-actions"><button onClick={example}>Try an example</button><button onClick={() => void worksheetExample()} disabled={busy}>Try a homework page</button></div></div>}

      {selected && selectedRecord && editor && !showHistory && inspectorOpen && <ObjectInspector key={selected.id} editor={editor} object={selected} shape={selectedRecord} editing={editingShapeId === selected.id} busy={busy} execute={executeManual}
        onCollapse={() => setInspectorOpen(false)} onDeselect={() => { flushSourceEdits(); editor.setEditingShape(null); editor.selectNone(); contentSelectionRef.current = undefined; setSelectedContent('') }}
        onEdit={() => beginEditing(selected.id)} onNaturalSize={resetGraphSize} onCleanInk={formalizeSelection}
        onPlotInk={() => void runPrompt('Read the function in the selected handwriting and plot it nearby. Keep the original handwriting. If unclear, ask me.')}/>}
      {selected && !showHistory && !inspectorOpen && <button className="reopen-inspector" onClick={() => setInspectorOpen(true)}><Settings2 size={15}/>Object controls</button>}
      {showHistory && <aside className="history-panel"><div className="inspector-heading"><span>Conversation</span><button aria-label="Close conversation" onClick={() => setShowHistory(false)}><X size={16}/></button></div><div className="messages">{messages.length ? messages.map(m => <div className={`message ${m.role}`} key={m.id}><span>{m.role === 'user' ? 'You' : 'Assistant'}</span><p>{m.text}</p></div>) : <p className="quiet">Your instructions and replies will appear here.</p>}</div></aside>}

      {menu === 'paper' && <div className="popover paper-popover"><div className="popover-heading">Page settings<button aria-label="Close page settings" onClick={()=>setMenu(null)}><X size={16}/></button></div><span className="field-caption">Layout</span><div className="segmented"><button className={settings.mode === 'infinite' ? 'selected' : ''} onClick={() => changeMode('infinite')}>Infinite</button><button className={settings.mode === 'page' ? 'selected' : ''} onClick={() => changeMode('page')}>A4 page</button></div><span className="field-caption">Paper</span><div className="paper-swatches">{(['plain','dots', 'grid', 'ruled'] as const).map(p => <button aria-label={`${p} paper`} title={p} key={p} className={`swatch-${p} ${settings.paper === p ? 'selected' : ''}`} onClick={() => setSettings(s => ({ ...s, paper: p }))}/>)}</div><div className="paper-colors">{['#ffffff', '#f8f9fa', '#fffde7', '#eef5ff'].map(c => <button key={c} aria-label={`Paper color ${c}`} style={{ background: c }} className={settings.backgroundColor === c ? 'selected' : ''} onClick={() => setSettings(s => ({ ...s, backgroundColor: c }))}/>)}</div><button className="menu-row" onClick={() => { importAsBackground.current = true; imageInput.current?.click() }}><ImagePlus size={17}/>Set image background</button><button className="menu-row" onClick={() => { importAsBackground.current = false; imageInput.current?.click() }}><FileImage size={17}/>Insert movable image</button><button className="menu-row" onClick={() => projectInput.current?.click()}><FileUp size={17}/>Open notebook file</button><button className="menu-row" onClick={() => { save(); setMenu(null) }}><Save size={17}/>Save editable notebook</button>{editor?.getCurrentPageShapes().some(s => s.meta.marginaliaBackground === true) && <button className="menu-row" onClick={removeBackground}><Trash2 size={17}/>Remove background</button>}</div>}
      {menu === 'export' && <div className="popover export-popover"><div className="popover-heading">Export<button aria-label="Close export" onClick={()=>setMenu(null)}><X size={16}/></button></div><button className="menu-row" onClick={() => void doExport('png')}><FileImage size={18}/><span>PNG image<small>Include the whole board</small></span></button><button className="menu-row" onClick={() => void doExport('pdf')}><Download size={18}/><span>PDF<small>{settings.mode === 'page' ? 'A4 portrait page' : 'Fitted to your canvas'}</small></span></button><button className="menu-row" onClick={() => {save();setMenu(null)}}><Save size={18}/><span>Editable notebook<small>Keep the objects and images</small></span></button></div>}
      {menu === 'help' && <div className="popover help-popover"><div className="popover-heading">Help & iPad connection<button aria-label="Close help" onClick={() => setMenu(null)}><X size={16}/></button></div><p><b>Magic pen:</b> tap near an object or loosely circle an area, then speak or type. Double-click an equation or text to edit its characters.</p><p><b>Work here:</b> Reference uses your selection as a location cue and allows content to grow beyond it. Literal keeps AI changes inside the selected region; circle an area first.</p><p><b>Graphs:</b> Equal units keeps x and y spacing the same. Natural graph size restores a comfortable width and height.</p><p><b>Voice mode:</b> hides the typing bar. The microphone circle responds to your actual voice. Choose Assistant, Dictate math, or Dictate text.</p><p><b>Notebooks:</b> each notebook saves separately on this device. Download a notebook file to transfer it to another device.</p>{api?.pairingCode ? <div className="pair-code"><span>iPad pairing code</span><strong>{api.pairingCode}</strong><p>Open the HTTPS preview in iPad Safari and enter this code. It permits AI use through this laptop. It changes when the server restarts.</p></div> : <p>Find the pairing code in Help on the laptop at <b>localhost:3000</b>. This device does not display the code.</p>}<button className="menu-row" onClick={testVoice} disabled={checkingVoice || voiceStatus !== 'idle'}>{checkingVoice ? <LoaderCircle className="spin" size={15}/> : <Mic size={15}/>}Check voice connection</button><button className="menu-row" onClick={() => void worksheetExample()} disabled={busy}><FileImage size={16}/>Try a sample homework background</button><button className="menu-row" onClick={() => void downloadOriginal()}><Download size={16}/>Download original notebook backup</button>{api?.models && <p className="model-details"><b>AI models</b><br/>Voice: {api.models.realtime}<br/>Typed instructions: {api.models.text}</p>}<small>Voice uses your API credit. Five-minute session limit. Typed instructions work without a microphone.</small><p><a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">Third-party licenses</a></p></div>}

      {api?.pairingRequired && !api.authorized && <form className="pair-banner" onSubmit={e=>{e.preventDefault();void pair()}}><div><b>Connect your iPad to AI</b><span>On your laptop, open Help & iPad connection to find the code.</span></div><input aria-label="Pairing code" placeholder="6-digit code" value={pairCode} onChange={e => setPairCode(e.target.value)} inputMode="numeric" maxLength={6}/><button disabled={pairing}>{pairing?'Connecting…':'Connect'}</button></form>}
      <div className="canvas-footer"><span className="canvas-status">{settings.mode === 'page' ? 'A4 portrait' : 'Infinite canvas'}<span className="footer-separator">·</span>{shapeCount} {shapeCount === 1 ? 'object' : 'objects'}</span><div className="history-buttons"><button aria-label="Undo" title="Undo" onClick={() => execute([{type:'undo'}])}><Undo2 size={17}/></button><button aria-label="Redo" title="Redo" onClick={() => execute([{type:'redo'}])}><Redo2 size={17}/></button></div><div className="zoom-controls"><button aria-label="Zoom out" onClick={() => editor?.zoomOut()}><Minus size={15}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => editor?.zoomIn()}><Plus size={15}/></button><button aria-label="Fit canvas" title="Fit canvas" onClick={() => settings.mode === 'page' ? editor?.zoomToBounds({ x: -100, y: -70, w: 994, h: 1313 }) : editor?.zoomToFit()}><Maximize size={15}/></button></div></div>

      <div className={`command-dock ${voiceMode ? 'voice-first' : ''}`}>
        {library.storageWarning && <div className="error-banner" role="alert">{library.storageWarning}</div>}
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
        {toast && !error && <div className="toast" role="status">{toast}</div>}
        {following && <div className="live-status">Move your pointer. Tap to place.</div>}
        {voiceMode ? <div className="voice-panel">
          <div className="voice-transcript" aria-live="polite">{liveTranscript || (voiceStatus === 'connecting' ? 'Connecting… Allow microphone access if your browser asks.' : voiceStatus === 'thinking' ? 'Working…' : voiceStatus === 'speaking' ? 'Speaking…' : voiceStatus !== 'idle' ? 'Listening. Point anywhere and speak.' : 'Tap the microphone to start.')}</div>
          <div className="voice-controls"><button className="compact-control" aria-label="Show typing bar" title="Show typing bar" onClick={()=>setVoiceMode(false)}><Keyboard size={18}/></button><button ref={voiceOrbRef} className={`voice-orb ${voiceStatus !== 'idle' ? 'connected' : ''}`} aria-label={voiceStatus === 'idle' ? 'Start voice session' : 'Stop voice session'} onClick={()=>void toggleVoice()}><span className="voice-orb-halo"/>{voiceStatus === 'connecting' ? <LoaderCircle className="spin" size={25}/> : voiceStatus !== 'idle' ? <Mic size={25}/> : <MicOff size={25}/>}</button><button className="compact-control" aria-label={spokenReplies ? 'Mute assistant voice' : 'Enable assistant voice'} onClick={()=>{setSpokenReplies(v=>!v);voiceRef.current?.setSpokenReplies(!spokenReplies)}}>{spokenReplies?<Volume2 size={18}/>:<VolumeX size={18}/>}</button></div>
          <div className="voice-mode-options"><select aria-label="Voice action" value={dictationMode} onChange={e=>changeDictation(e.target.value as typeof dictationMode)}><option value="assistant">Assistant</option><option value="math">Dictate math</option><option value="text">Dictate text</option></select><button onClick={()=>setShowHistory(!showHistory)}>Conversation</button></div>
        </div> : <><form className={`command-bar ${voiceStatus !== 'idle' ? 'voice-active' : ''}`} onSubmit={e => { e.preventDefault(); void runPrompt() }}><input ref={inputRef} aria-label="Ask Magic Whiteboard" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Give an idea a little space…" disabled={busy}/><button type="submit" className="send-command" aria-label="Send instruction" disabled={busy || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowUp size={18}/>}</button><span className="command-divider"/><button type="button" className={`voice-button ${voiceStatus !== 'idle' ? 'recording' : ''}`} aria-label={voiceStatus === 'idle' ? 'Start voice session' : 'Stop voice session'} onClick={()=>void toggleVoice()}>{voiceStatus === 'connecting' ? <LoaderCircle className="spin" size={19}/> : <Mic size={19}/>}</button></form>
        <div className="command-caption"><span>{selectedContent ? `Selected: ${selectedContent.slice(0,35)}` : focus ? <><Scan size={12}/>{focus.kind === 'region' ? 'Region selected' : 'Point selected'}<button onClick={()=>setFocus(null)}>clear</button></> : 'Circle an area, then speak or type.'}</span><button onClick={()=>setShowHistory(!showHistory)}>Conversation{messages.length?` (${messages.length})`:''}</button></div></>}
      </div>
    </main>
    <input className="hidden-input" ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void importImage(f); e.target.value = '' }}/>
    <input className="hidden-input" ref={projectInput} type="file" accept=".json,.marginalia" onChange={async e => { const f = e.target.files?.[0]; if (f && editor) { setBusy(true); try { flushSourceEdits(); editor.completeInteraction(); stopFollowing(); setSettings(await loadProject(editor, f)); notify('Notebook opened.'); setMenu(null); setFocus(null) } catch (error) { setError((error as Error).message) } finally { setBusy(false) } } e.target.value = '' }}/>
  </div>
}
