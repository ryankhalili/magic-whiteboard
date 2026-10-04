import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { DefaultColorStyle, DefaultSizeStyle, type Editor, type TLShapeId } from './canvas/editor'
import { WhiteboardCanvas } from './canvas/WhiteboardCanvas'
import { ArrowUp, Check, ChevronDown, CircleHelp, Download, Eraser, Eye, EyeOff, FileImage, FileUp, Hand, ImagePlus, Keyboard, Library, LoaderCircle, Maximize, Mic, MicOff, Minus, MousePointer2, Pencil, Plus, Redo2, RotateCcw, RotateCw, Save, Scan, Settings2, Sparkles, Trash2, Type, Sigma, Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { createBoardController, getPlacementBounds, MagicShapeView } from './board'
import { focusImageBounds, libraryAssetId, libraryImageSize, libraryItemKey, libraryQueryFromOperation, spotForOption, type LibraryImageKind } from './board/controller'
import { guessContentSize, NATURAL_SIZES } from './board/placementSpots'
import { finishPointerFollow, focusFromGesture, movePointerFollow, startPointerFollow, type PointerFollow } from './board/interactions'
import { createHoldToTalk } from './ai/hold-to-talk'
import { MathStudio } from './math/MathStudio'
import { placeStudioOperation } from './math/studioPlacement'
import { DocumentNavigator, DocumentPageMask } from './documents/DocumentNavigator'
import { exportWorksheetPdf } from './files/pdfExport'
import { getBookGuideContext } from './library/guide'
import { createRealtimeClient, checkVoiceConnection, type ContentPreview } from './ai/realtime'
import { NotebookSwitcher, useNotebookLibrary, saveNotebookSnapshot, loadNotebookSnapshot, type NotebookLibrary } from './notebooks'
import { getApiStatus, sendBoardCommand, pairDevice, repairBoardCommand } from './ai/commands'
import { contextFingerprint, type VoiceRecoveryState } from './ai/voice-recovery'
import { prepareBoardRepair, pinBoardRepair } from './ai/board-repair'
import { useImageGeneration } from './images/useImageGeneration'
import { ImageGenerationPanel } from './images/ImageGenerationPanel'
import { downloadOriginalNotebook, exportBoard, exportRegionPdf, importImageFile, installBoardImageExporter, loadProject, PAGE_BOUNDS, regionFromSelection, saveProject } from './files/boardFiles'
import { boardNeedsImage, captureBoardContext } from './files/capture'
import { boardImportLimit, isPdfFile, worksheetPages } from './files/pdfPages'
import { addedBounds, asksForPanelPage, boardOnly, captureBoardCommandGuard, commandAllowance, createSpeechStart, freeSpots, insertMessage, instructionTooLong, isPairingError, localHistoryCommand, localContextObjects, modelLibrary, wantsPlacement } from './appLogic'
import { defaultImportTarget, ImportDialog, importProgressText, type ImportInfo, type ImportTarget } from './library/ImportDialog'
import { LibraryPanel } from './library/LibraryPanel'
import { candidateTitle, panelHits, ReferencePanel } from './library/ReferencePanel'
import { ensureIndexed, importBook, inspectPdf, needsReindex } from './library/indexer'
import { createBoundsFor, createInsertLock, easeInOut, FLOATING_UI, INSPECTOR_UI, inspectorZone, manualOverride, matchWithReindex, revealShift, type ScreenRect } from './library/insertLayout'
import { detectLibraryIntent, type LibraryIntent } from './library/intent'
import { rankItems } from './library/rank'
import { renderCrop, renderPage } from './library/render'
import { forgetBookData, matchLibrary, problemImage } from './library/resolve'
import { kindName, parseLibraryQuery, pickBook, titleMatch } from './library/search'
import { listBooks, removeBook, touchBook } from './library/store'
import type { BookRecord, Candidate, ImportProgress, LibraryQuery, PageBox, RankedCandidate, RenderedImage, Spot } from './library/types'
import { ObjectInspector } from './board/ObjectInspector'
import { flushSourceEdits, snapshotWithPendingSource } from './board/liveSource'
import { DEFAULT_SETTINGS, type AppSettings, type BoardCommand, type BoardContext, type BoardOperation, type BoardResult, type Bounds, type Focus, type LibraryAction, type PlacementCandidate, type PlacementOption, type Point } from '../shared/board'

type Tool = 'magic' | 'select' | 'draw' | 'eraser' | 'hand' | 'text' | 'math'
type Message = { id: number; role: 'user' | 'assistant' | 'event'; text: string }
type ApiStatus = { configured: boolean; authorized: boolean; pairingRequired: boolean; pairingCode?: string; models?: { text: string; realtime: string; image?: string }; limits?: { sessionMinutes: number; voiceMinutesLimit: number; imageLimit?: number; commandLimit?: number }; usage?: { commands?: number } }
const COLORS = ['#202124', '#2563eb', '#dc2626', '#15803d', '#7c3aed']
const INK_COLORS = ['black', 'blue', 'red', 'green', 'violet'] as const
const OPTION_IDS = ['A', 'B', 'C'] as const
let messageId = 0
let importId = 0
type PendingImport = { id: number; file: File; info: ImportInfo | null; progress: ImportProgress | null; busy: boolean; choosing: ImportTarget | null }
type LibrarySource = { book: BookRecord; pageIndex: number; candidate?: Candidate; box?: PageBox }
type ResolvedInsert = { op: BoardOperation; reserve: Bounds; note?: string } | { result: BoardResult }
type PlaceOptions = { option?: PlacementOption; extra?: Bounds[]; manual?: boolean }
type BookPage = { bookId: string; pageIndex: number }
const isLibraryOp = (op: BoardOperation | undefined) => op?.type === 'insert_library' || op?.type === 'library_action' || op?.type === 'create_image'
const pickText = (count: number) => count > 1 ? `Pick one of the ${count} highlighted matches.` : 'Tap the highlighted match to insert it.'
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback
const spotKey = (spots: Spot[]) => spots.map(spot => `${Math.round(spot.bounds.x)},${Math.round(spot.bounds.y)}`).join('|')
const spotOptions = (spots: Spot[]): PlacementOption[] | null => spots.length ? spots.slice(0, 3).map((spot, i) => ({ id: OPTION_IDS[i], bounds: spot.bounds, note: spot.description.slice(0, 300) })) : null

export default function App() {
  const library = useNotebookLibrary()
  return <NotebookWorkspace key={library.activeNotebook.id} library={library}/>
}

function NotebookWorkspace({ library }: { library: NotebookLibrary }) {
  const notebook = library.activeNotebook
  const editorRef = useRef<Editor | null>(null)
  const workspaceActive = useRef(true)
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
  const holdTalkRef = useRef<ReturnType<typeof createHoldToTalk> | null>(null)
  const priorHoldTool = useRef<Tool>('draw')
  const voiceOrbRef = useRef<HTMLButtonElement>(null)
  const contentSelectionRef = useRef<BoardContext['contentSelection']>(undefined)
  const dictationRef = useRef<'assistant' | 'math' | 'text'>('assistant')
  const inputRef = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const importAsBackground = useRef(true)
  // library state lives in refs too, so voice callbacks and getContext always read the latest
  const booksRef = useRef<BookRecord[]>([])
  const openBookRef = useRef<BookRecord | null>(null)
  const importRef = useRef<PendingImport | null>(null)
  const placementRef = useRef<PlacementOption[] | null>(null)
  const highlightRef = useRef<RankedCandidate[] | null>(null)
  // the page shown in the reference panel and the last inserted page, for "exercise 48" near where the teacher is
  const panelPageRef = useRef<BookPage | null>(null)
  const lastInsertRef = useRef<BookPage | null>(null)
  // set only while a panel insert runs, so it places like reference mode
  const contextOverride = useRef<Partial<BoardContext> | null>(null)
  const reindexing = useRef(new Map<string, Promise<BookRecord>>())
  const glideFrame = useRef(0)
  const showHistoryRef = useRef(false)
  const spotsKey = useRef('')
  const progressAt = useRef(0)
  const focusUsed = useRef(false)
  const snapshotReady = useRef(false)
  const snapshotFailed = useRef(false)
  const snapshotLoad = useRef<Promise<void>>(Promise.resolve())
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commandAbort = useRef<AbortController | null>(null)
  // glides new content into view; set once revealInserted exists
  const revealRef = useRef<(b: Bounds, selects: boolean) => void>(() => {})
  // voice placement spots in local order; Jev ranks them at most once per utterance
  const voiceSpots = useRef<{ key: string; spots: Spot[] } | null>(null)
  const rankedKey = useRef('')
  const speechStart = useRef(createSpeechStart())
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
  const [tool, setToolState] = useState<Tool>('magic')
  const toolRef = useRef<Tool>('magic')
  const setTool = useCallback((next: Tool) => { toolRef.current = next; setToolState(next) }, [])
  const [color, setColor] = useState(COLORS[0])
  const [inkSize, setInkSize] = useState<'s' | 'm'>('m')
  const [ready, setReady] = useState(false)
  const [tick, setTick] = useState(0)
  const [path, setPath] = useState<Point[]>([])
  const [focus, setFocusState] = useState<Focus | null>(null)
  const [following, setFollowing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState<VoiceRecoveryState>(null)
  const [commandProgress, setCommandProgress] = useState('')
  const aiPaused = !!recovery || !!commandProgress
  const [voiceStatus, setVoiceStatus] = useState('idle')
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [holdingTalk, setHoldingTalk] = useState(false)
  const [mathStudio, setMathStudio] = useState(false)
  const [documentPageId, setDocumentPageId] = useState<string | null>(null)
  const [voiceMode, setVoiceMode] = useState(false)
  const [voiceControlsHidden, setVoiceControlsHidden] = useState(false)
  const [dictationMode, setDictationMode] = useState<'assistant' | 'math' | 'text'>('assistant')
  const [contentPreview, setContentPreview] = useState<ContentPreview | null>(null)
  const [spokenReplies, setSpokenReplies] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<'paper' | 'export' | 'help' | 'library' | null>(null)
  const [books, setBooksState] = useState<BookRecord[]>([])
  const [openBook, setOpenBookState] = useState<BookRecord | null>(null)
  const [highlight, setHighlightState] = useState<RankedCandidate[] | null>(null)
  const [lookup, setLookup] = useState(0)
  const [refBusy, setRefBusy] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [insertLock] = useState(() => createInsertLock(setInserting))
  const [refMessage, setRefMessage] = useState<string | null>(null)
  const [pendingImport, setImportState] = useState<PendingImport | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  showHistoryRef.current = showHistory
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
  const setBooks = useCallback((list: BookRecord[]) => { booksRef.current = list; setBooksState(list) }, [])
  const setOpenBook = useCallback((book: BookRecord | null) => { openBookRef.current = book; setOpenBookState(book) }, [])
  const setImport = useCallback((next: PendingImport | null) => { importRef.current = next; setImportState(next) }, [])
  const setHighlight = useCallback((next: RankedCandidate[] | null) => { highlightRef.current = next; setHighlightState(next) }, [])
  // the matches showing as badges 1, 2, 3 in the reference panel
  const shownMatches = useCallback((): RankedCandidate[] => openBookRef.current ? panelHits(highlightRef.current, openBookRef.current) : [], [])
  const patchImport = useCallback((id: number, patch: Partial<PendingImport>) => {
    const current = importRef.current
    if (current?.id === id) setImport({ ...current, ...patch })
  }, [setImport])
  const getContext = useCallback((): BoardContext => {
    const editor = editorRef.current
    const vp = editor?.getViewportPageBounds()
    const gestureFocus = editor && gestureRef.current?.active ? focusFromGesture(editor, gestureRef.current) : null
    const chosenFocus = gestureFocus ?? focusRef.current
    const currentFocus = chosenFocus ? { ...chosenFocus, targetIds: chosenFocus.targetIds.filter(id => editor?.getShape(id as TLShapeId)) } : null
    const selectedIds = gestureFocus?.targetIds.length ? gestureFocus.targetIds : editor?.getSelectedShapeIds() as string[] || []
    const important = new Set([...selectedIds, ...(currentFocus?.targetIds || []), ...(controller.current?.lastCreatedIds || [])])
    // worksheet page text only matters for pages in view or in the circled area
    const view = currentFocus?.kind === 'region' ? currentFocus.bounds : vp
    const relevantObjects = localContextObjects(controller.current?.getObjects() || [], important, view)
    const shelf = booksRef.current, open = openBookRef.current, pending = importRef.current, page = panelPageRef.current
    const matches = open ? panelHits(highlightRef.current, open) : []
    // Only the locally extracted, bounded guide accompanies titles; no whole-book prompt.
    const library = modelLibrary({
      books: shelf, open, pending: pending && !pending.busy ? { name: pending.file.name, pages: pending.info?.pageCount ?? 0 } : null,
      highlights: open ? matches.map(c => candidateTitle(c, open.labels)) : [], panelPageIndex: open && page?.bookId === open.id ? page.pageIndex : null,
    })
    if (library?.openBook && open) library.openBook.guide = getBookGuideContext(open, page?.bookId === open.id ? page.pageIndex : null)
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
      ...(library ? { library } : {}),
      ...(placementRef.current?.length && !currentFocus ? { placementOptions: placementRef.current } : {}),
      ...contextOverride.current,
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
  const images = useImageGeneration(notebook.id, () => snapshotReady.current ? editorRef.current : null, getContext, async () => {
    const ed = editorRef.current
    if (!snapshotReady.current || !ed) throw new Error('Wait for this notebook to finish opening before saving the image.')
    clearTimeout(snapshotTimer.current)
    await saveNotebookSnapshot(notebook.id, snapshotWithPendingSource(ed, { finishHistory: false }))
    setSaveState('Saved on this device')
    notify('Your image is ready. Select it to move, resize, rotate, or crop it.')
  })
  // reveal: new objects that are off screen or under a panel glide into view
  const execute = useCallback((ops: BoardOperation[], reportFailure = true, reveal = true): BoardResult => {
    if (!controller.current) return { ok: false, message: 'The board is still loading.', ids: [] }
    if (ops.some(operation => operation.type === 'propose_image')) {
      try {
        if (ops.length !== 1) throw new Error('Propose one image at a time, separately from other board changes.')
        if (!ops[0].prompt?.trim()) throw new Error('Describe the image before proposing it.')
        images.propose(ops[0])
        return { ok: true, message: 'Review the shaded image area and description, then click the checkmark to generate.', ids: [] }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The image preview could not open.'
        if (reportFailure) setError(message)
        return { ok: false, message, ids: [] }
      }
    }
    const editor = editorRef.current!
    flushSourceEdits()
    editor.completeInteraction()
    // Finish an earlier drag before the next edit changes its geometry or history.
    stopFollowing()
    const followMark = ops.some(o => o.followPointer) ? editor.markHistoryStoppingPoint('Follow pointer instruction') : null
    const existing = reveal && !followMark && ops.some(op => op.type.startsWith('create_')) ? editor.getCurrentPageShapeIds() : null
    const result = controller.current.applyOperations(ops)
    if (result.ok) {
      setError('')
      notify(result.message)
      const added = existing && addedBounds(editor, existing, result.ids)
      if (added) revealRef.current(added, editor.getSelectedShapeIds().length > 0)
      if (followMark && result.ids.length) {
        const p = pointerRef.current || { x: 0, y: 0 }
        const context = getContext()
        const constraint = context.focusMode === 'literal' && context.focus?.kind === 'region' ? context.focus.bounds : undefined
        followRef.current = startPointerFollow(editor, result.ids, p, followMark, constraint)
        setFollowing(followRef.current.ids.length > 0)
        // Following must remain placeable even if the command was issued in another tool.
        setTool('magic'); editor.setCurrentTool('select')
      }
    } else if (reportFailure) setError(result.message)
    return result
  }, [notify, stopFollowing, getContext, images.propose])
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
  // on this laptop the status call also grants access again after a server restart
  const refreshStatus = useCallback(async (): Promise<ApiStatus | null> => {
    const status = await getApiStatus() as ApiStatus
    setApi(status)
    return status
  }, [])
  // a lapsed pairing: the laptop is let back in, and an iPad shows the pairing field again
  const recoverPairing = useCallback((error: unknown) => {
    if (!isPairingError(error)) return
    void refreshStatus().then(status => {
      if (status?.authorized) setError('The laptop server restarted, so this device connected again. Give the instruction again.')
    }).catch(() => {})
  }, [refreshStatus])
  useEffect(() => { refreshStatus().catch(() => setError('The local AI server is not reachable. Drawing still works.')) }, [refreshStatus])
  const imageMessage = images.draft?.message
  useEffect(() => { if (imageMessage) recoverPairing(imageMessage) }, [imageMessage, recoverPairing])
  useEffect(() => {
    workspaceActive.current = true
    return () => { workspaceActive.current = false; holdTalkRef.current?.dispose(); voiceRef.current?.disconnect(); commandAbort.current?.abort() }
  }, [])
  useEffect(() => {
    if (!aiPaused) return
    stopFollowing(); gestureRef.current = null; pathRef.current = []; touches.current.clear(); pinch.current = null; setPath([])
  }, [aiPaused, stopFollowing])
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
    if (busy || insertLock.held()) throw new Error('Wait for the current instruction or import to finish before switching notebooks.')
    holdTalkRef.current?.cancel()
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
  }, [notebook.id, busy, stopFollowing, insertLock])

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
      voiceRef.current?.updateContext()
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
    const ed = editorRef.current
    ed?.completeInteraction()
    if (toolRef.current === 'magic' && next !== 'magic') {
      // Releasing the talk key can precede pencil/mouse pointer-up. Finish the
      // reference region before its overlay disappears and VAD commits speech.
      const gesture = gestureRef.current
      if (gesture?.active && ed) {
        const completedFocus = focusFromGesture(ed, gesture)
        if (completedFocus.targetIds.length) ed.select(...completedFocus.targetIds as TLShapeId[])
        setFocus(completedFocus)
      }
      gestureRef.current = null; pathRef.current = []; touches.current.clear(); pinch.current = null; setPath([])
      voiceRef.current?.updateContext()
    }
    setTool(next); stopFollowing()
    ed?.setEditingShape(null)
    ed?.setCurrentTool(['magic', 'math', 'text'].includes(next) ? 'select' : next)
  }, [stopFollowing, setFocus, setTool])
  const onVoiceShortcut = useEffectEvent(() => { void toggleVoice() })
  const connectHeldVoice = useEffectEvent(() => connectVoice(false))
  const heldVoiceChanged = useEffectEvent((held: boolean) => {
    setHoldingTalk(held)
    if (held) { priorHoldTool.current = toolRef.current; chooseTool('magic'); setVoiceControlsHidden(false) }
    else if (toolRef.current === 'magic') chooseTool(priorHoldTool.current)
  })
  useEffect(() => {
    const hold = createHoldToTalk({ getClient: () => voiceRef.current, connectMuted: () => connectHeldVoice(), onHoldChange: held => heldVoiceChanged(held), onError: error => setError(errorText(error, 'Microphone could not start.')) })
    holdTalkRef.current = hold
    const release = () => hold.release()
    const keyup = (e: KeyboardEvent) => { if (e.code === 'KeyR' || e.key === 'Shift') release() }
    const hidden = () => { if (document.hidden) release() }
    window.addEventListener('keyup', keyup, true); window.addEventListener('blur', release); document.addEventListener('visibilitychange', hidden)
    return () => { hold.dispose(); window.removeEventListener('keyup', keyup, true); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.composedPath().some(node => node instanceof Element && node.closest('[role="dialog"]'))) return
      if (event.composedPath().some(node => node instanceof Element && node.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),math-field,.marginalia-inline-editor'))) return
      if (event.shiftKey && event.code === 'KeyR' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) void holdTalkRef.current?.press(); return }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code === 'KeyV' || event.code === 'Space')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (event.repeat) return
        if (event.code === 'KeyV') setVoiceControlsHidden(hidden => !hidden)
        else onVoiceShortcut()
        return
      }
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyZ' || event.code === 'KeyY')) {
        event.preventDefault(); event.stopImmediatePropagation()
        execute([{ type: event.code === 'KeyY' || event.shiftKey ? 'redo' : 'undo' }]); return
      }
      if (event.code === 'Escape') { holdTalkRef.current?.cancel(); stopFollowing(); setFocus(null); setMenu(null); setError('') }
      if (event.code === 'KeyM' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); chooseTool('magic') }
      if (event.code === 'KeyP' && !event.ctrlKey && !event.metaKey) chooseTool('draw')
      if (event.code === 'KeyV' && !event.ctrlKey && !event.metaKey) chooseTool('select')
      if (event.code === 'KeyE' && !event.ctrlKey && !event.metaKey) chooseTool('eraser')
      if (event.code === 'KeyH' && !event.ctrlKey && !event.metaKey) chooseTool('hand')
      if (event.code === 'KeyT' && !event.ctrlKey && !event.metaKey) chooseTool('text')
      if (event.code === 'KeyQ' && !event.ctrlKey && !event.metaKey) chooseTool('math')
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') { event.preventDefault(); setVoiceControlsHidden(false); setVoiceMode(false); requestAnimationFrame(() => inputRef.current?.focus()) }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [chooseTool, stopFollowing, setFocus, execute])

  const editor = editorRef.current
  const objects = useMemo(() => ready ? controller.current?.getObjects() || [] : [], [ready, editor, tick])
  const documentPages = useMemo(() => editor && ready ? worksheetPages(editor) : [], [editor, ready, tick])
  const activeDocumentPage = documentPages.find(p => p.id === documentPageId) ?? documentPages[0] ?? null
  useEffect(() => {
    if (settings.mode !== 'document' || !ready || !editor || !activeDocumentPage || documentPageId === activeDocumentPage.id) return
    setDocumentPageId(activeDocumentPage.id); editor.zoomToBounds(activeDocumentPage.bounds, { inset: 105 })
  }, [settings.mode, ready, editor, documentPageId, activeDocumentPage])
  const goToDocumentPage = (id: string) => {
    const page = documentPages.find(p => p.id === id); if (!page || !editor) return
    flushSourceEdits(); editor.completeInteraction(); holdTalkRef.current?.cancel(); setFocus(null); editor.selectNone()
    setDocumentPageId(id); editor.zoomToBounds(page.bounds, { inset: 105 })
  }
  const exportHomework = async () => {
    if (!editor) return
    flushSourceEdits(); editor.completeInteraction(); holdTalkRef.current?.cancel(); setBusy(true); setMenu(null)
    try { const result = await exportWorksheetPdf(editor, { ...(settings.mode === 'document' && activeDocumentPage ? { docId: activeDocumentPage.info.doc } : {}), title: settings.name }); notify(`Exported ${result.pages} homework pages.${result.rasterizedPages ? ' Some original PDFs were unavailable; those pages use their saved images.' : ''}`) }
    catch (e) { setError(errorText(e, 'Homework could not be exported.')) }
    finally { setBusy(false) }
  }

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
    if (aiPaused && tool === 'magic') return
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
    if (aiPaused && tool === 'magic') { event.preventDefault(); event.stopPropagation(); return }
    if (event.button !== 0 || !editorRef.current || !ready) return
    if (tool === 'text' || tool === 'math') {
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      const point = editorRef.current.screenToPage({ x: event.clientX, y: event.clientY })
      const result = execute([{ type: tool === 'math' ? 'create_math' : 'create_text', latex: '', text: '', bounds: { ...point, w: 400, h: tool === 'math' ? 100 : 140 }, fontSize: tool === 'math' ? 28 : 22, color }], true, false)
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
    if (aiPaused && tool === 'magic') { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); return }
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

  // typed requests the board answers itself, with no model call
  const runLocal = async (text: string, task: (guard: ReturnType<typeof captureBoardCommandGuard>) => Promise<BoardResult>, fallback: string) => {
    setPrompt(''); setError(''); addMessage('user', text); setBusy(true)
    const abort = new AbortController(); commandAbort.current = abort
    const progress = setTimeout(() => setCommandProgress('Reading your library…'), 400)
    try {
      flushSourceEdits(); editorRef.current?.completeInteraction(); stopFollowing()
      const result = await task(captureInstructionGuard(() => !abort.signal.aborted))
      if (abort.signal.aborted) return
      if (!result.ok) setError(result.message); else notify(result.message)
      addMessage('assistant', result.message)
    } catch (e) { if (!abort.signal.aborted) setError(errorText(e, fallback)) }
    finally {
      clearTimeout(progress); if (commandAbort.current === abort) commandAbort.current = null
      setBusy(false); setCommandProgress('')
    }
  }
  // everything on the board, wherever the view, pointer or gesture is; a reply is applied only when this still matches
  const boardKey = () => contextFingerprint(boardOnly({ ...getContext(), objects: controller.current?.getObjects() ?? [] }))
  const captureInstructionGuard = (isCurrent?: () => boolean) => captureBoardCommandGuard(() => ({
    active: workspaceActive.current, ready: snapshotReady.current, notebookId: notebook.id,
    editor: editorRef.current, boardKey: boardKey(), libraryKey: JSON.stringify({ book: openBookRef.current?.id ?? null,
      matches: shownMatches().map(match => match.id), pendingImport: importRef.current?.id ?? null }),
  }), isCurrent)
  const cancelledInsert = (): BoardResult => ({ ok: false, message: 'The instruction was cancelled or its writing target changed. No delayed insert was applied.', ids: [] })
  const runPrompt = async (text = prompt) => {
    if (!text.trim() || busy || recovery || voiceStatus === 'connecting') return
    const tooLong = instructionTooLong(text)
    if (tooLong) { setError(tooLong); return }
    const literalText = voiceRef.current?.isConnected() && dictationRef.current === 'text'
    const step = literalText ? null : localHistoryCommand(text)
    if (step) return runLocal(text, async () => execute([{ type: step }], false), 'That could not be done.')
    const panel = panelSource()
    if (!literalText && panel && asksForPanelPage(text)) {
      return runLocal(text, guard => insertLock.run(async () => {
        if (!guard.isCurrent()) return cancelledInsert()
        focusUsed.current = false
        const { op } = await libraryImageOp(panel, `page ${panel.book.labels?.[panel.pageIndex] ?? panel.pageIndex + 1}`)
        if (!guard.isCurrent()) return cancelledInsert()
        return applyResolved([op], [], true)
      }), 'That page could not be drawn.')
    }
    const intent = literalText ? null : detectLibraryIntent(text, { importPending: !!importRef.current && !importRef.current.busy, hasBooks: booksRef.current.length > 0, bookTitles: booksRef.current.map(book => book.title), highlightCount: shownMatches().length })
    if (intent) return runLocal(text, guard => runIntent(intent, guard), 'The library could not be read.')
    if (api?.pairingRequired && !api.authorized) { setError('Enter the pairing code shown in Help on your laptop to connect this device.'); return }
    setPrompt(''); setError(''); addMessage('user', text); setBusy(true)
    const abort = new AbortController(); commandAbort.current = abort
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    let sent = false
    try {
      flushSourceEdits(); editorRef.current?.completeInteraction(); stopFollowing()
      if (voiceRef.current?.isConnected()) { voiceRef.current.sendText(text); return }
      setCommandProgress('Working on your request…')
      progressTimer = setTimeout(() => setCommandProgress('This request is taking a little longer than usual. I’m checking it before changing the board…'), 3500)
      const before = structuredClone(getContext()), boardBefore = boardKey()
      // ink or a non library image in the area the model looks at; book pages never go to the model
      const needsImage = !!editorRef.current && boardNeedsImage(editorRef.current, before.focus)
      const visual = needsImage ? await getVisualContext() : null
      // the server ranks these free spots into placement options A, B, C; an edit of the selection places nothing
      const placementCandidates = wantsPlacement(text, before) ? typedCandidates(text) : undefined
      sent = true
      const result = await sendBoardCommand(text, { ...before, placementOptions: undefined }, messages.filter(m => m.role !== 'event').slice(-8).map(m => ({ role: m.role as 'user' | 'assistant', text: m.text })), visual || undefined, abort.signal, placementCandidates)
      if (abort.signal.aborted) return
      flushSourceEdits(); editorRef.current?.completeInteraction(); stopFollowing()
      if (boardBefore !== boardKey()) { notify('The board changed while I was working, so I left this response unapplied. Give the instruction again when ready.'); return }
      let applied: BoardResult | null = null
      if (result.operations.length) {
        const previous = placementRef.current
        placementRef.current = result.placementOptions ?? null
        try { applied = await executeResolved(result.operations, false, result.placementOptions ?? null, () => !abort.signal.aborted) }
        finally { placementRef.current = previous }
      }
      if (applied && !applied.ok) {
        const repair = prepareBoardRepair(result.operations, before, getContext(), applied)
        if (repair.ok) {
          clearTimeout(progressTimer); setCommandProgress('This request is taking a little longer than usual. I’m correcting the edit…')
          const corrected = await repairBoardCommand({ instruction: text, context: before, failedOperations: result.operations, failure: { kind: 'operation_rejected', message: applied.message } }, abort.signal)
          if (abort.signal.aborted) return
          flushSourceEdits(); editorRef.current?.completeInteraction(); stopFollowing()
          if (!corrected.operations.length) { const clarification = corrected.message || 'Please clarify what you would like to change.'; addMessage('assistant', clarification); notify(clarification); return }
          const pinned = pinBoardRepair(repair.value, corrected.operations, getContext())
          if (!pinned.ok) { notify('The original content changed, so I left the correction unapplied.'); return }
          applied = execute(pinned.value, false)
        }
        if (applied && !applied.ok) setError(`I couldn’t safely finish that edit after checking it. ${applied.message} You can keep working or give a new instruction.`)
      }
      // the board, not the model, knows whether a book lookup inserted something or is waiting for a tap
      addMessage('assistant', applied && (!applied.ok || result.operations.some(op => op.type === 'propose_image' || isLibraryOp(op))) ? applied.message : result.message || applied?.message || 'Done.')
    } catch (e) { if (!abort.signal.aborted) { setError(e instanceof Error ? e.message : String(e)); recoverPairing(e) } }
    finally {
      clearTimeout(progressTimer); if (commandAbort.current === abort) commandAbort.current = null; setBusy(false); setCommandProgress('')
      // keeps the allowance shown in Help and the low allowance warning current
      if (sent) void refreshStatus().catch(() => {})
    }
  }
  const toggleVoice = async () => {
    holdTalkRef.current?.cancel()
    if (voiceStatus !== 'idle') { voiceRef.current?.disconnect(); setVoiceStatus('idle'); setLiveTranscript(''); return }
    await connectVoice()
  }
  const connectVoice = async (initiallyEnabled = true) => {
    if (voiceRef.current?.isConnected()) return voiceRef.current
    if (busy || voiceStatus !== 'idle') return null
    setError('')
    if (api?.pairingRequired && !api.authorized) { setError('Connect this device with the laptop pairing code before starting voice.'); return null }
    if (!window.isSecureContext) { setError('Microphone access needs HTTPS on your iPad. Use the secure preview address; localhost works on this computer.'); return null }
    setVoiceMode(true)
    try {
      const client = createRealtimeClient({
        initiallyEnabled, onMicrophoneEnabled: setMicrophoneEnabled,
        getContext, getVisualContext,
        applyOperations: (ops, isCurrent) => {
          if (isCurrent && !isCurrent()) return { ok: false, message: 'The instruction was cancelled. No edit was applied.', ids: [] }
          if (!ops.some(isLibraryOp)) return execute(ops, false)
          setBusy(true)
          return executeResolvedRef.current(ops, false, null, isCurrent).finally(() => setBusy(false))
        },
        beforeApplyOperations: () => { flushSourceEdits(); editorRef.current?.completeInteraction(); stopFollowing() },
        onAudioLevel: level => {
          voiceOrbRef.current?.style.setProperty('--mic-level', String(level))
          if (speechStart.current(level, performance.now())) rankForTurn()
        },
        onContentPreview: handleContentPreview,
        onStatus: setVoiceStatus,
        onRecoveryState: state => { setRecovery(state); if (state) setError('') },
        onNotice: notify,
        repairRequest: repairBoardCommand,
        onTranscript: (text: string, final: boolean) => { setLiveTranscript(text); if (final) addMessage('user', text) },
        onAssistant: (text: string, final: boolean) => { if (final) { addMessage('assistant', text); setLiveTranscript('') } },
        onError: (text: string) => { setError(text); recoverPairing(text) }, spokenReplies,
      })
      voiceRef.current = client
      await client.connect()
      if (voiceRef.current === client && client.isConnected() && initiallyEnabled) chooseTool('magic')
      return client.isConnected() ? client : null
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setVoiceStatus('idle'); recoverPairing(e); return null }
  }

  const pair = async () => {
    setPairing(true); setError('')
    try {
      await pairDevice(pairCode)
      await refreshStatus()
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
    if (aiPaused && tool === 'magic') return
    const ed = editorRef.current
    if (!ed) return
    const point = ed.screenToPage({ x: event.clientX, y: event.clientY })
    const hit = ed.getShapeAtPoint(point, { hitInside: true, margin: 12 / ed.getZoomLevel(), filter: s => !s.isLocked })
    if (hit) beginEditing(hit.id)
  }
  const changeDictation = (mode: 'assistant' | 'math' | 'text') => {
    if (mode === dictationRef.current) return
    // Never reinterpret already captured speech under a different action mode.
    if (holdTalkRef.current?.isHeld() || voiceRef.current?.isWorking()) { notify('Finish the current phrase before changing voice action.'); return }
    handleContentPreview(null)
    dictationRef.current = mode; setDictationMode(mode); voiceRef.current?.updateContext()
  }
  const formalizeSelection = () => void runPrompt('Clean up the handwriting in my focused region into editable text and LaTeX, preserving the original meaning and position. Use separate text and math objects where appropriate. Replace only the selected handwritten ink after creating the clean objects successfully; keep any background image. If the writing is unclear, ask me instead of guessing.')
  const testVoice = async () => {
    setCheckingVoice(true); setError('')
    try { await checkVoiceConnection(getContext()); notify('Voice connection verified. The microphone was not activated.') }
    catch (e) { setError((e as Error).message); recoverPairing(e) }
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
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true],math-field,.marginalia-inline-editor')) return
      const image = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith('image/'))
      if (image) { event.preventDefault(); event.stopImmediatePropagation(); importAsBackground.current = true; void importImage(image) }
    }
    window.addEventListener('paste', paste, true)
    return () => window.removeEventListener('paste', paste, true)
  }, [settings.mode])

  const refreshBooks = useCallback(async (): Promise<BookRecord[]> => {
    try {
      const list = await listBooks()
      setBooks(list)
      const open = openBookRef.current, fresh = open && list.find(book => book.id === open.id)
      // a book being read again stays open
      if (open && !fresh && !reindexing.current.has(open.id)) { setOpenBook(null); setHighlight(null); panelPageRef.current = null }
      else if (open && fresh && (fresh.indexed !== open.indexed || fresh.indexVersion !== open.indexVersion)) setOpenBook(fresh)
      return list
    } catch { return booksRef.current }
  }, [setBooks, setOpenBook, setHighlight])
  useEffect(() => { void refreshBooks() }, [refreshBooks])
  useEffect(() => { if (menu === 'library') void refreshBooks() }, [menu, refreshBooks])
  useEffect(() => { voiceRef.current?.updateContext() }, [books, openBook, highlight, pendingImport?.id, pendingImport?.info, pendingImport?.busy])

  // floating panels on screen; content that will be selected also keeps clear of where the inspector opens
  const floatingRects = useCallback((selects: boolean): ScreenRect[] => {
    if (typeof document === 'undefined') return []
    const rects: ScreenRect[] = []
    for (const element of document.querySelectorAll(FLOATING_UI)) {
      // a page insert clears the selection, so the inspector goes away
      if (!selects && element.matches(INSPECTOR_UI)) continue
      const r = element.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, ...(element.matches(INSPECTOR_UI) ? { soft: true } : {}) })
    }
    if (selects && !showHistoryRef.current) {
      // the hidden .inspector-zone has the inspector's own css, so it sits exactly where the inspector opens
      const zone = stageRef.current?.querySelector('.inspector-zone')?.getBoundingClientRect(), stage = stageRef.current?.getBoundingClientRect()
      if (zone && zone.width > 0 && zone.height > 0) rects.push({ left: zone.left, top: zone.top, right: zone.right, bottom: zone.bottom, soft: true })
      else if (stage) rects.push(inspectorZone(stage, window.innerWidth))
    }
    return rects
  }, [])
  // free spots for new content of this size, avoiding floating panels and everything on the page
  const boardSpots = useCallback(function boardSpots(size: { w: number; h: number }, workBelow: number, extra: Bounds[] = [], selects = true, sheet = true): Spot[] {
    const ed = editorRef.current
    if (!ed) return []
    const vp = ed.getViewportPageBounds(), objects = controller.current?.getObjects() ?? []
    const avoid = floatingRects(selects).map((r): Bounds => {
      const a = ed.screenToPage({ x: r.left, y: r.top }), b = ed.screenToPage({ x: r.right, y: r.bottom })
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
    })
    const selectedIds = ed.getSelectedShapeIds() as string[], last = controller.current?.lastCreatedIds ?? []
    const near = objects.find(o => o.id === selectedIds[0]) ?? objects.find(o => o.id === last[0])
    // in A4 page mode new content stays on the sheet, unless the caller asks for room beside it
    const spots = freeSpots({
      viewport: { x: vp.x, y: vp.y, w: vp.w, h: vp.h }, zoom: ed.getZoomLevel(), objects, size, workBelow, extra, near: near?.bounds ?? null, avoid,
      sheet: sheet && settingsRef.current.mode === 'page' ? PAGE_BOUNDS : null, isBackground: id => ed.getShape(id as TLShapeId)?.meta.marginaliaBackground === true,
    })
    // on a small screen new content may go where the inspector opens when nothing else is in view; it folds away
    const inView = (list: Spot[]) => list.some(spot => (spot.features.inView ?? 0) >= .7)
    if (!selects || inView(spots)) return spots
    const loose = boardSpots(size, workBelow, extra, false, sheet)
    return inView(loose) ? loose : spots
  }, [floatingRects])
  // best first; the ranker (Jev or local) gets 1.5 s, then the local order stands
  const rankSpots = useCallback(async (spots: Spot[], query: string): Promise<Spot[]> => {
    if (spots.length < 2) return spots
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500) })
    try {
      const result = await Promise.race([rankItems({ task: 'placement', query: query.slice(0, 500) || 'new content', items: spots.map(spot => ({ id: spot.id, text: spot.description, features: spot.features })) }), late])
      if (!result) return spots
      const byId = new Map(spots.map(spot => [spot.id, spot]))
      return [...new Set([...result.ranked.map(entry => byId.get(entry.id)).filter((spot): spot is Spot => !!spot), ...spots])]
    } catch { return spots }
    finally { clearTimeout(timer) }
  }, [])
  const typedCandidates = (text: string): PlacementCandidate[] | undefined => {
    const bookish = booksRef.current.length > 0 && parseLibraryQuery(text) !== null
    const size = bookish ? { w: 640, h: 360 } : guessContentSize(text)
    const spots = boardSpots({ w: size.w, h: size.h }, bookish ? 300 : 0)
      .filter(spot => Math.abs(spot.bounds.x) <= 1e6 && Math.abs(spot.bounds.y) <= 1e6)
    return spots.length ? spots.map(spot => ({ id: spot.id, bounds: spot.bounds, description: spot.description.slice(0, 300), features: spot.features })) : undefined
  }
  // voice gets the current top 3 spots as placement options in local order, refreshed when the board settles
  useEffect(() => {
    if (voiceStatus === 'idle' || focus) {
      spotsKey.current = ''; voiceSpots.current = null; rankedKey.current = ''
      if (placementRef.current) { placementRef.current = null; voiceRef.current?.updateContext() }
      return
    }
    const timer = setTimeout(() => {
      const spots = boardSpots(NATURAL_SIZES.plot, 0), key = spotKey(spots)
      if (key === spotsKey.current) return
      spotsKey.current = key; voiceSpots.current = { key, spots }
      placementRef.current = spotOptions(spots)
      voiceRef.current?.updateContext()
    }, 600)
    return () => clearTimeout(timer)
  }, [voiceStatus, focus, tick, boardSpots])
  // when the teacher starts speaking, the ranker orders those spots once, while the sentence is still being said
  const rankForTurn = useCallback(() => {
    const current = voiceSpots.current
    if (!current || current.spots.length < 2 || rankedKey.current === current.key) return
    rankedKey.current = current.key
    void rankSpots(current.spots, 'new content the teacher asks for').then(ranked => {
      if (voiceSpots.current !== current || !placementRef.current) return
      placementRef.current = spotOptions(ranked)
      voiceRef.current?.updateContext()
    })
  }, [rankSpots])

  const stopGlide = () => { cancelAnimationFrame(glideFrame.current); glideFrame.current = 0 }
  useEffect(() => () => cancelAnimationFrame(glideFrame.current), [])
  // moves the camera smoothly at the same zoom
  const glideTo = (target: { x: number; y: number }) => {
    const ed = editorRef.current
    if (!ed) return
    stopGlide()
    const from = ed.getCamera()
    let still = false
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* no media queries */ }
    if (still) { ed.setCamera({ x: target.x, y: target.y, z: from.z }); return }
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 420), e = easeInOut(t)
      ed.setCamera({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z })
      glideFrame.current = t < 1 ? requestAnimationFrame(step) : 0
    }
    glideFrame.current = requestAnimationFrame(step)
  }
  // a new insert that is off screen or under a panel glides into full view; a visible one stays put
  const revealInserted = (b: Bounds, selects: boolean) => {
    const ed = editorRef.current, stage = stageRef.current?.getBoundingClientRect()
    if (!ed || !stage) return
    const a = ed.pageToScreen({ x: b.x, y: b.y }), c = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h })
    const area = { left: stage.left + 84, top: stage.top + 56, right: stage.right - 16, bottom: stage.bottom - 40 }
    const shift = revealShift({ left: a.x, top: a.y, right: c.x, bottom: c.y }, area, floatingRects(selects))
    if (!shift) return
    const camera = ed.getCamera(), z = camera.z || 1
    glideTo({ x: camera.x + shift.dx / z, y: camera.y + shift.dy / z })
  }
  revealRef.current = revealInserted
  // at the magic pen focus when there is one, else the best free spot (or the model's placementOption) with work space below
  const placeImage = async (image: { w: number; h: number }, kind: LibraryImageKind, query: string, { option, extra = [], manual = false }: PlaceOptions = {}): Promise<{ bounds: Bounds; reserve: Bounds; workBelow: number }> => {
    const size = libraryImageSize(image, kind)
    const base = getContext(), context = manual ? { ...base, ...manualOverride(base) } : base
    const withRoom = (b: Bounds) => ({ bounds: b, reserve: { ...b, h: b.h + size.workBelow }, workBelow: size.workBelow })
    const focused = focusImageBounds(size, context)
    if (focused) {
      focusUsed.current = true
      // a second insert in the same request goes under the first instead of on top of it
      const below = context.focusMode !== 'literal' && extra.length ? Math.max(...extra.map(b => b.y + b.h)) + 24 : null
      return withRoom(below === null ? focused : { ...focused, y: Math.max(focused.y, below) })
    }
    // pages are not selected after the insert, so they may go where the inspector would open;
    // a whole textbook page never covers the A4 homework, and anything that does not fit on the sheet goes beside it
    let spots = boardSpots(size, size.workBelow, extra, kind !== 'page', kind !== 'page')
    if (!spots.length) spots = boardSpots(size, size.workBelow, extra, kind !== 'page', false)
    if (option) return withRoom(spotForOption(option, spots, size))
    const top = (await rankSpots(spots, query))[0]?.bounds
    if (top) return withRoom({ x: top.x, y: top.y, w: size.w, h: size.h })
    const vp = context.viewport
    return withRoom({ x: vp.x + (vp.w - size.w) / 2, y: vp.y + Math.max(24, vp.h * .08), w: size.w, h: size.h })
  }
  // renders a page, a detected item or a manual crop and turns it into a create_image operation
  const libraryImageOp = async (source: LibrarySource, query: string, place: PlaceOptions = {}): Promise<{ op: BoardOperation; reserve: Bounds }> => {
    const { book, pageIndex, candidate, box } = source
    const anchor = candidate?.kind === 'item' ? candidate.anchor : undefined
    const kind: LibraryImageKind = box ? 'crop' : anchor ? 'item' : 'page'
    const assetKey = kind === 'crop' && box ? `${book.id}#${pageIndex}:crop:${[box.x, box.y, box.w, box.h].map(v => v.toFixed(4)).join(',')}`
      : kind === 'item' && anchor ? libraryItemKey(anchor.id, book.indexVersion) : `${book.id}#${pageIndex}:page`
    // the same page or problem again reuses the image already in this notebook
    const existing = editorRef.current?.getAsset(libraryAssetId(assetKey))
    const image: RenderedImage = existing && typeof existing.props.src === 'string'
      ? { src: existing.props.src, w: existing.props.w, h: existing.props.h, mimeType: existing.props.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' }
      : kind === 'crop' && box ? await renderCrop(book.id, pageIndex, box) : kind === 'item' && candidate ? await problemImage(candidate) : await renderPage(book.id, pageIndex)
    const label = book.labels?.[pageIndex] ?? null, where = label ? `page ${label}` : `file page ${pageIndex + 1}`
    const name = kind === 'page' ? `${book.title}, ${where}` : kind === 'item' && anchor ? `${kindName(anchor.kind)}${anchor.label ? ` ${anchor.label}` : ''}, ${book.title}` : `Part of ${where}, ${book.title}`
    const placed = await placeImage(image, kind, query, place)
    // workBelow keeps the teacher's work space free from later inserts
    return { reserve: placed.reserve, op: {
      type: 'create_image', image: { ...image, name: name.slice(0, 200) }, bounds: placed.bounds, locked: kind === 'page',
      meta: { assetKey, library: { bookId: book.id, title: book.title.slice(0, 160), pageIndex, pageLabel: label, kind, ...(anchor ? { itemKind: anchor.kind, itemLabel: anchor.label, anchorId: anchor.id } : {}), ...(placed.workBelow > 0 ? { workBelow: Math.round(placed.workBelow) } : {}) } },
    } }
  }
  const closeBook = () => { setOpenBook(null); setHighlight(null); setRefMessage(null); panelPageRef.current = null }
  const showMatches = (book: BookRecord, ranked: RankedCandidate[]) => { setOpenBook(book); setHighlight(ranked); setRefMessage(null); setLookup(n => n + 1) }
  // the page showing in the reference panel, when a book is open
  const panelSource = (): LibrarySource | null => {
    const open = openBookRef.current, page = panelPageRef.current
    return open && page?.bookId === open.id ? { book: open, pageIndex: page.pageIndex } : null
  }
  // the reference panel page, else the last inserted page
  const nearPage = (): BookPage | null => {
    const panel = panelSource()
    return panel ? { bookId: panel.book.id, pageIndex: panel.pageIndex } : lastInsertRef.current
  }
  // an older index is rebuilt from the stored PDF, with progress in the reference panel; one run per book
  const reindexBook = (bookId: string, isCurrent: () => boolean = () => true, onScopeChange: () => void = () => {}): Promise<BookRecord> => {
    const running = reindexing.current.get(bookId)
    if (running) return running
    const book = bookFor(bookId)
    if (isCurrent() && book && openBookRef.current?.id !== bookId) { setOpenBook(book); setHighlight(null); onScopeChange() }
    const show = (text: string | null) => { if (isCurrent() && openBookRef.current?.id === bookId) setRefMessage(text) }
    let shownAt = 0
    show('Updating this book so problems come out cleanly.')
    const job = ensureIndexed(bookId, progress => {
      const now = performance.now()
      if (progress.phase === 'reading' && progress.done < progress.total && now - shownAt < 150) return
      shownAt = now
      show(`Updating this book. ${importProgressText(progress)}.`)
    }).then(async updated => {
      forgetBookData(bookId)
      if (!isCurrent()) return updated
      await refreshBooks()
      if (isCurrent() && openBookRef.current?.id === bookId) { setOpenBook(updated); setRefMessage(null) }
      return updated
    }, error => {
      show(errorText(error, 'This book could not be updated. Import it again.'))
      throw error
    }).finally(() => reindexing.current.delete(bookId))
    reindexing.current.set(bookId, job)
    return job
  }
  const lookupLibrary = (query: LibraryQuery, openBookId: string | null, isCurrent: () => boolean = () => true, onScopeChange: () => void = () => {}, near: BookPage | null = nearPage()) => {
    // Reindexing can await disk work; its retry must use the original page/chapter.
    return matchWithReindex(() => matchLibrary(query, { openBookId, near }), id => reindexBook(id, isCurrent, onScopeChange))
  }
  // confident: an operation to apply; unsure: the top matches wait in the reference panel
  const resolveQuery = async (query: LibraryQuery, place: PlaceOptions = {}, isCurrent: () => boolean = () => true, onScopeChange: () => void = () => {}, near: BookPage | null = nearPage()): Promise<ResolvedInsert> => {
    const match = await lookupLibrary(query, openBookRef.current?.id ?? null, isCurrent, onScopeChange, near)
    if (!isCurrent()) throw new Error('The instruction was cancelled or its writing target changed. No delayed insert was applied.')
    if ('error' in match) {
      if ('books' in match && match.books?.length) setMenu('library')
      return { result: { ok: false, message: match.error, ids: [] } }
    }
    if (!match.confident || !match.ranked.length) {
      showMatches(match.book, match.ranked); onScopeChange()
      return { result: { ok: true, message: match.ranked.length ? pickText(match.ranked.length) : `Nothing in ${match.book.title} matches that.`, ids: [] } }
    }
    const best = match.ranked[0]
    const made = await libraryImageOp({ book: match.book, pageIndex: best.pageIndex, candidate: best }, query.raw, place)
    // "No printed page 5, added file page 5." tells the teacher which page came in
    return match.note ? { ...made, note: match.note } : made
  }
  const insertedText = (ops: BoardOperation[]) => {
    const names = ops.flatMap(op => {
      const info = op.meta?.library as { kind?: string; pageLabel?: string | null; pageIndex?: number; itemKind?: string; itemLabel?: string } | undefined
      if (op.type !== 'create_image' || !info) return []
      if (info.kind === 'page') return [info.pageLabel ? `page ${info.pageLabel}` : `file page ${(info.pageIndex ?? 0) + 1}`]
      if (info.kind === 'item') return [`${info.itemKind ? kindName(info.itemKind as Parameters<typeof kindName>[0]) : 'the item'}${info.itemLabel ? ` ${info.itemLabel}` : ''}`]
      return ['the crop']
    })
    return names.length ? `Added ${names.join(' and ')}.` : ''
  }
  // runs resolved operations as one undo step; execute brings new objects into view
  const applyResolved = (ready: BoardOperation[], notes: string[], reportFailure: boolean, manual = false): BoardResult => {
    if (!ready.length) {
      const message = notes.join(' ') || 'Done.'
      notify(message)
      return { ok: true, message, ids: [] }
    }
    const usedFocus = focusUsed.current
    focusUsed.current = false
    contextOverride.current = manual ? manualOverride(getContext()) : null
    let result: BoardResult
    try { result = execute(ready, reportFailure) }
    finally { contextOverride.current = null }
    if (!result.ok) return result
    // the circled spot now holds the book content, so the next insert finds its own space
    if (usedFocus) { setFocus(null); voiceRef.current?.updateContext() }
    const images = ready.filter(op => op.type === 'create_image' && op.bounds)
    const info = images[images.length - 1]?.meta?.library as { bookId?: unknown; pageIndex?: unknown } | undefined
    if (typeof info?.bookId === 'string' && typeof info.pageIndex === 'number') lastInsertRef.current = { bookId: info.bookId, pageIndex: info.pageIndex }
    const message = insertMessage(insertedText(ready), notes) || result.message
    notify(message)
    return { ...result, message }
  }

  const importToBoard = async (job: PendingImport) => {
    const ed = editorRef.current
    if (!ed) return
    patchImport(job.id, { busy: true, choosing: 'board', progress: null })
    setBusy(true)
    try {
      flushSourceEdits(); ed.completeInteraction(); stopFollowing()
      const { importPdfFile } = await import('./files/pdfImport')
      const result = await importPdfFile(ed, job.file, {
        mode: settingsRef.current.mode,
        onProgress: (page, pages) => patchImport(job.id, { progress: { phase: 'reading', done: page - 1, total: pages } }),
      })
      const name = job.file.name.replace(/\.pdf$/i, '').trim().slice(0, 120)
      holdTalkRef.current?.cancel()
      setDocumentPageId(result.ids[0]); ed.zoomToBounds(result.first, { inset: 105 })
      setSettings(s => ({ ...s, mode: 'document', ...(s.name === DEFAULT_SETTINGS.name && name ? { name } : {}) }))
      setFocus(null)
      notify(`${result.pages} homework ${result.pages === 1 ? 'page' : 'pages'} ready. Export Homework PDF to keep the original pages.${result.keptSource ? '' : ' Original PDF storage is unavailable; export will use page images.'}`)
    } catch (error) { setError(errorText(error, 'This PDF could not be put on the board.')) }
    finally {
      if (importRef.current?.id === job.id) setImport(null)
      setBusy(false)
    }
  }
  const importToLibrary = async (job: PendingImport) => {
    patchImport(job.id, { busy: true, choosing: 'library', progress: { phase: 'reading', done: 0, total: job.info?.pageCount ?? 0 } })
    progressAt.current = 0
    try {
      const book = await importBook(job.file, progress => {
        // a few updates a second keep a 769 page import smooth
        const now = performance.now()
        if (progress.phase === 'reading' && progress.done < progress.total && now - progressAt.current < 120) return
        progressAt.current = now
        patchImport(job.id, { progress })
      })
      forgetBookData(book.id)
      await refreshBooks()
      setOpenBook(book); setHighlight(null); setRefMessage(null)
      notify(`${book.title} is in your library. Ask for a page or a problem.`)
    } catch (error) { setError(errorText(error, 'This PDF could not be saved to the library.')) }
    finally { if (importRef.current?.id === job.id) setImport(null) }
  }
  const routeImport = (to: ImportTarget): BoardResult => {
    const job = importRef.current
    if (!job) return { ok: false, message: 'There is no PDF waiting to be imported.', ids: [] }
    if (job.busy) return { ok: true, message: 'The import is already running.', ids: [] }
    if (to === 'board') {
      const limit = boardImportLimit(job.info?.pageCount ?? 0, job.file.size)
      if (limit) return { ok: false, message: limit, ids: [] }
      void importToBoard(job)
      return { ok: true, message: 'Putting the pages on the board.', ids: [] }
    }
    void importToLibrary(job)
    return { ok: true, message: 'Saving it to the library.', ids: [] }
  }
  const openImport = (file: File) => {
    if (importRef.current?.busy) { setError('Wait for the current import to finish.'); return }
    const job: PendingImport = { id: ++importId, file, info: null, progress: null, busy: false, choosing: null }
    setImport(job); setMenu(null); setError('')
    inspectPdf(file).then(info => patchImport(job.id, { info })).catch(error => {
      if (importRef.current?.id !== job.id || importRef.current.busy) return
      setImport(null); setError(errorText(error, 'This PDF could not be opened.'))
    })
  }
  const importFile = (file: File, asBackground: boolean) => {
    if (isPdfFile(file)) openImport(file)
    else if (file.type.startsWith('image/')) { importAsBackground.current = asBackground; void importImage(file) }
    else setError('Choose a PDF or a PNG, JPEG or WebP image.')
  }

  const openFromLibrary = async (book: BookRecord, isCurrent: () => boolean = () => true, onScopeChange: () => void = () => {}) => {
    if (!isCurrent()) return
    setMenu(null); setOpenBook(book); setHighlight(null); setRefMessage(null); onScopeChange()
    // an unfinished import or an older index finishes reading while the book is open
    if (needsReindex(book)) void reindexBook(book.id, isCurrent, onScopeChange).catch(() => {})
    const touched = await touchBook(book.id).catch(() => null)
    if (!isCurrent()) return
    if (touched && openBookRef.current?.id === book.id && !reindexing.current.has(book.id)) setOpenBook(touched)
    void refreshBooks()
  }
  const removeFromLibrary = async (book: BookRecord) => {
    try {
      await removeBook(book.id)
      forgetBookData(book.id)
      if (openBookRef.current?.id === book.id) closeBook()
      await refreshBooks()
      notify(`${book.title} was removed from this browser.`)
    } catch (error) { setError(errorText(error, 'That book could not be removed.')) }
  }
  const runLibraryAction = async (action: LibraryAction | undefined, name = '', isCurrent: () => boolean = () => true, onScopeChange: () => void = () => {}): Promise<BoardResult> => {
    const done = (message: string, ok = true): BoardResult => ({ ok, message, ids: [] })
    if (!isCurrent()) return done('The instruction was cancelled or its writing target changed.', false)
    if (action === 'store_import' || action === 'board_import') return routeImport(action === 'store_import' ? 'library' : 'board')
    if (action === 'close_reference') {
      if (!openBookRef.current) return done('No book is open.')
      closeBook(); onScopeChange(); return done('Closed the book.')
    }
    if (action !== 'open_book') return done('That library action is not supported.', false)
    const list = booksRef.current.length ? booksRef.current : await refreshBooks()
    if (!isCurrent()) return done('The instruction was cancelled or its writing target changed.', false)
    if (!list.length) return done('The library is empty. Import a textbook first.', false)
    const hint = name.trim()
    let book: BookRecord | null
    if (hint) {
      const picked = pickBook(list, hint, null).book
      book = picked && Math.max(titleMatch(hint, picked.title), titleMatch(hint, picked.fileName ?? '')) >= .5 ? picked : null
    } else book = openBookRef.current ?? (list.length === 1 ? list[0] : null)
    if (!book) { setMenu('library'); return done(hint ? `No book matches "${hint.slice(0, 60)}". Pick one in the Library.` : 'Which book? Pick one in the Library.', false) }
    await openFromLibrary(book, isCurrent, onScopeChange)
    return done(`Opened ${book.title}.`)
  }
  // "number 2" while matches are highlighted: the match with that badge
  const pickedMatch = (index: number | undefined): { c: RankedCandidate; book: BookRecord } | { error: string } => {
    const shown = shownMatches(), c = index ? shown[index - 1] : undefined
    const book = c && (bookFor(c.bookId) ?? openBookRef.current)
    if (c && book) return { c, book }
    return { error: !shown.length ? 'There are no highlighted matches to pick from.' : shown.length === 1 ? 'Only match 1 is highlighted.' : `Pick a number from 1 to ${shown.length}.` }
  }
  const pickMatch = async (index: number, isCurrent: () => boolean): Promise<BoardResult> => {
    if (!isCurrent()) return cancelledInsert()
    const picked = pickedMatch(index)
    if ('error' in picked) return { ok: false, message: picked.error, ids: [] }
    focusUsed.current = false
    const { op } = await libraryImageOp({ book: picked.book, pageIndex: picked.c.pageIndex, candidate: picked.c }, picked.c.description)
    if (!isCurrent()) return cancelledInsert()
    const result = applyResolved([op], [], true)
    if (result.ok) setHighlight(null)
    return result
  }
  // insert_library and library_action become board operations here, for typed and voice commands alike
  const executeResolved = async (ops: BoardOperation[], reportFailure = true, options: PlacementOption[] | null = null, isCurrent?: () => boolean): Promise<BoardResult> => {
    const fail = (message: string): BoardResult => { if (reportFailure) setError(message); return { ok: false, message, ids: [] } }
    const { isCurrent: current, acceptLibraryChange } = captureInstructionGuard(isCurrent)
    let queryNear = nearPage()
    const stale = () => fail('The instruction was cancelled or its writing target changed. No delayed insert was applied.')
    if (!current()) return stale()
    if (!Array.isArray(ops) || !ops.length) return fail('Send between 1 and 20 whiteboard actions.')
    // images only come from the library, never straight from the model
    if (ops.some(op => op?.type === 'create_image')) return fail('That whiteboard action is not supported.')
    if (!ops.some(isLibraryOp)) return execute(ops, reportFailure)
    // one insert at a time, so each one finds its spot on the board as the last one left it
    return insertLock.run(async () => {
      if (!current()) return stale()
      const ready: BoardOperation[] = [], notes: string[] = [], placed: Bounds[] = []
      // where the board will put each new object, in order; creates listed before an insert do not know about it
      const created: Bounds[] = []
      const context = getContext(), offered = !!context.placementOptions?.length && !context.focus
      let picked = false
      focusUsed.current = false
      try {
        for (const op of ops) {
          if (!current()) return stale()
          const pick = op.type === 'library_action' && op.action === 'pick'
          if (op.type === 'library_action' && !pick) {
            const result = await runLibraryAction(op.action, op.book ?? '', current, acceptLibraryChange)
            if (!current()) return stale()
            if (!result.ok) return fail(result.message)
            if (op.action === 'open_book' || op.action === 'close_reference') queryNear = nearPage()
            notes.push(result.message); continue
          }
          if (op.type !== 'insert_library' && !pick) {
            ready.push(op)
            const b = createBoundsFor(op, context, created)
            if (b) created.push(b)
            continue
          }
          // A is the default whenever options are offered
          const optionId = op.placementOption ?? (offered ? 'A' : undefined)
          const option = optionId ? (options ?? placementRef.current)?.find(o => o.id === optionId) : undefined
          const place = { option, extra: [...placed, ...created] }
          let resolved: ResolvedInsert
          if (pick) {
            const match = pickedMatch(op.index)
            if ('error' in match) return fail(match.error)
            resolved = await libraryImageOp({ book: match.book, pageIndex: match.c.pageIndex, candidate: match.c }, match.c.description, place)
            picked = true
          } else {
            const query = libraryQueryFromOperation(op)
            if (!query) return fail('Say a page number or a problem number to insert from the book.')
            resolved = await resolveQuery(query, place, current, acceptLibraryChange, queryNear)
          }
          if (!current()) return stale()
          if ('result' in resolved) {
            if (!resolved.result.ok) return fail(resolved.result.message)
            notes.push(resolved.result.message); continue
          }
          placed.push(resolved.reserve)
          if (resolved.op.bounds) created.push(resolved.op.bounds)
          ready.push(resolved.op)
          if (resolved.note) notes.push(resolved.note)
        }
      } catch (error) { return fail(errorText(error, 'The book could not be read.')) }
      if (!current()) return stale()
      const result = applyResolved(ready, notes, reportFailure)
      if (result.ok && picked) setHighlight(null)
      return result
    })
  }
  const executeResolvedRef = useRef(executeResolved)
  executeResolvedRef.current = executeResolved
  // local fast path: clear library requests never reach the model
  const runIntent = async (intent: LibraryIntent, guard: ReturnType<typeof captureBoardCommandGuard>): Promise<BoardResult> => {
    if (!guard.isCurrent()) return cancelledInsert()
    if (intent.action === 'route_import') return routeImport(intent.to)
    if (intent.action === 'close_reference') return runLibraryAction('close_reference', '', guard.isCurrent, guard.acceptLibraryChange)
    if (intent.action === 'open_book') return runLibraryAction('open_book', intent.book, guard.isCurrent, guard.acceptLibraryChange)
    if (intent.action === 'pick') return insertLock.run(() => pickMatch(intent.index, guard.isCurrent))
    const query = intent.query, near = nearPage()
    return insertLock.run(async () => {
      if (!guard.isCurrent()) return cancelledInsert()
      focusUsed.current = false
      const resolved = await resolveQuery(query, {}, guard.isCurrent, guard.acceptLibraryChange, near)
      if (!guard.isCurrent()) return cancelledInsert()
      if ('result' in resolved) return resolved.result
      return applyResolved([resolved.op], resolved.note ? [resolved.note] : [], true)
    })
  }
  // reference panel buttons; placed like reference mode when nothing is circled, even in Literal
  const panelInsert = async (make: () => Promise<{ op: BoardOperation }>) => {
    if (refBusy || insertLock.held()) return
    const guard = captureInstructionGuard()
    setRefMessage(null)
    await insertLock.run(async () => {
      setRefBusy(true); focusUsed.current = false
      try {
        const { op } = await make()
        if (!guard.isCurrent()) { setRefMessage(cancelledInsert().message); return }
        const result = applyResolved([op], [], false, true)
        if (result.ok) setHighlight(null); else setRefMessage(result.message)
      } catch (error) { setRefMessage(errorText(error, 'That page could not be drawn.')) }
      finally { setRefBusy(false) }
    })
  }
  const bookFor = (id: string) => booksRef.current.find(book => book.id === id) ?? (openBookRef.current?.id === id ? openBookRef.current : null)
  const searchBook = async (text: string) => {
    const book = openBookRef.current
    if (!book || !text.trim()) return
    const parsed = parseLibraryQuery(text)
    // the search box always looks in the open book
    const query: LibraryQuery = parsed ? { ...parsed, book: undefined } : { kind: 'topic', terms: text.trim(), raw: text.trim() }
    setRefBusy(true); setRefMessage(null)
    try {
      const match = await lookupLibrary(query, book.id)
      if ('error' in match) { setHighlight(null); setRefMessage(match.error); return }
      setHighlight(match.ranked); setLookup(n => n + 1)
      if (!match.ranked.length) setRefMessage(`Nothing in ${book.title} matches that.`)
      else if (match.note) setRefMessage(match.note.replace('added', 'showing'))
    } catch (error) { setRefMessage(errorText(error, 'This book could not be searched.')) }
    finally { setRefBusy(false) }
  }
  const exportArea = async () => {
    setMenu(null)
    if (!editor) return
    const current = focusRef.current
    const region = current?.kind === 'region' && current.bounds.w > 0 && current.bounds.h > 0 ? current.bounds : regionFromSelection(editor)
    if (!region) { setError('Circle an area with the magic pen or select objects first.'); return }
    flushSourceEdits(); editor.completeInteraction(); stopFollowing()
    setBusy(true)
    try { await exportRegionPdf(editor, region, settings); notify('Area PDF exported.') }
    catch (error) { setError(errorText(error, 'The area could not be exported.')) }
    finally { setBusy(false) }
  }

  const example = () => {
    const ed = editorRef.current
    if (!ed) return
    const result = execute([
      { type: 'create_text', text: 'A study in waves', title: 'Notes', bounds: { x: 110, y: 70, w: 360, h: 100 }, fontSize: 30, color: '#202124' },
      { type: 'create_plot', expression: 'sin(x)', title: '', xMin: 0, xMax: 4 * Math.PI, yMin: -1.5, yMax: 1.5, bounds: { x: 110, y: 190, w: 650, h: 380 }, color: '#202124' },
      { type: 'create_math', latex: '\\int_0^{2\\pi} \\sin(x)\\,dx = 0', bounds: { x: 800, y: 220, w: 390, h: 140 } },
      { type: 'create_geometry', geometry: 'right_triangle', bounds: { x: 850, y: 410, w: 210, h: 170 }, color: '#202124' },
    ], true, false)
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
  const save = async () => {
    if (!editor) return
    flushSourceEdits(); editor.completeInteraction(); stopFollowing()
    // a notebook too large to open again is refused with a message
    try { await saveProject(editor, settings); notify('Editable notebook downloaded.') } catch (e) { setError(errorText(e, 'This notebook could not be saved.')) }
  }
  const downloadOriginal = async () => {
    try { await downloadOriginalNotebook(notebook.id, settings); notify('Original notebook backup downloaded. Your current board is unchanged.') }
    catch (error) { setError((error as Error).message) }
  }
  const changeMode = (mode: AppSettings['mode']) => {
    setSettings(s => ({ ...s, mode })); setMenu(null)
    if (mode === 'document' && activeDocumentPage) goToDocumentPage(activeDocumentPage.id)
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
    executeManual([{ type: 'update_object', target: selected.id, bounds }])
  }

  const origin = pageToLocal({ x: 0, y: 0 })
  const allowance = commandAllowance(api)
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

  const insertStudioMath = (operation: BoardOperation): BoardResult => {
    const ed = editorRef.current
    if (!ed) return { ok: false, message: 'The board is still loading.', ids: [] }
    try {
      const context = { ...getContext(), objects: controller.current?.getObjects() ?? [] }
      const avoid = floatingRects(false).map(rect => {
        const a = ed.screenToPage({ x: rect.left, y: rect.top }), b = ed.screenToPage({ x: rect.right, y: rect.bottom })
        return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
      })
      const op = placeStudioOperation(operation, context, {
        zoom: ed.getZoomLevel(), avoid,
        sheet: settings.mode === 'page' ? PAGE_BOUNDS : settings.mode === 'document' ? activeDocumentPage?.bounds : null,
        isBackground: id => ed.getShape(id as TLShapeId)?.meta.marginaliaBackground === true,
      })
      const result = executeManual([op])
      if (result.ok) {
        setInspectorOpen(true)
        if (op.bounds) revealInserted(op.bounds, true)
        if (op.type === 'create_math' && result.ids[0]) beginEditing(result.ids[0])
      }
      return result
    } catch (error) { return { ok: false, message: errorText(error, 'Choose a placement area for this math.'), ids: [] } }
  }

  return <div className="app-shell">
    {mathStudio && <MathStudio onClose={() => setMathStudio(false)} onInsert={insertStudioMath}/>}
    <header className="app-header">
      <div className="header-left"><span className="brand">MagiBoard</span><NotebookSwitcher library={library} beforeChange={flushNotebook}/></div>
      <div className="document-title"><input aria-label="Notebook title" value={settings.name} onChange={e => setSettings(s => ({ ...s, name: e.target.value }))}/><span><Check size={12}/>{saveState}</span></div>
      <div className="header-actions">
        <button aria-label="Generate image" title="Generate image" className="plain-button secondary-action" disabled={!ready || aiPaused || !!images.draft} onClick={() => { try { images.propose({ type: 'propose_image' }) } catch (error) { setError((error as Error).message) } }}><ImagePlus size={17}/><span>Generate image</span></button>
        <button aria-label={voiceMode ? 'Type' : 'Voice mode'} title={voiceMode ? 'Show typing bar' : 'Voice mode'} className={`plain-button voice-mode-toggle ${voiceMode ? 'active' : ''}`} onClick={() => { setVoiceControlsHidden(false); if (voiceMode) setVoiceMode(false); else { setVoiceMode(true); if (voiceStatus === 'idle') void toggleVoice() } }}>{voiceMode ? <Keyboard size={18}/> : <Mic size={18}/>}<span>{voiceMode ? 'Type' : 'Voice mode'}</span></button>
        <button aria-label={voiceControlsHidden ? 'Show voice controls' : 'Hide voice controls'} title={`${voiceControlsHidden ? 'Show' : 'Hide'} voice controls (Shift+V)`} aria-expanded={!voiceControlsHidden} aria-controls="voice-panel-controls" aria-keyshortcuts="Shift+V" className="plain-button" onClick={() => setVoiceControlsHidden(hidden => !hidden)}>{voiceControlsHidden ? <Eye size={18}/> : <EyeOff size={18}/>}</button>
        {voiceControlsHidden && <button aria-label={voiceStatus === 'idle' ? 'Start voice session' : 'Stop voice session'} title={`${voiceStatus === 'idle' ? 'Start' : 'Stop'} voice session (Shift+Space)`} aria-keyshortcuts="Shift+Space" className={`plain-button ${microphoneEnabled ? 'active' : ''}`} onClick={() => void toggleVoice()}>{voiceStatus === 'connecting' ? <LoaderCircle className="spin" size={18}/> : microphoneEnabled ? <Mic size={18}/> : <MicOff size={18}/>}</button>}
        <button aria-label="Background" title="Set image background" className="plain-button hide-small secondary-action" onClick={() => { importAsBackground.current = true; imageInput.current?.click() }}><ImagePlus size={17}/><span>Background</span></button>
        <button aria-label="Import" title="Import a PDF or an image" className="plain-button" disabled={!!pendingImport?.busy} onClick={() => importInput.current?.click()}><FileUp size={17}/><span>Import</span></button>
        <button aria-label="Library" title="Your textbooks" aria-expanded={menu === 'library'} className={`plain-button ${menu === 'library' ? 'active' : ''}`} onClick={() => setMenu(menu === 'library' ? null : 'library')}><Library size={17}/><span>Library</span></button>
        <button aria-label="Insert math" className="plain-button" onClick={() => setMathStudio(true)}><Sigma size={18}/><span>Insert math</span></button>
        <button aria-label="Hold to talk" title="Hold Shift+R to point and talk" aria-keyshortcuts="Shift+R" aria-pressed={holdingTalk} className={`plain-button ${holdingTalk && microphoneEnabled ? 'active' : ''}`} style={{ touchAction: 'none' }}
          onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void holdTalkRef.current?.press() }}
          onPointerUp={() => holdTalkRef.current?.release()} onPointerCancel={() => holdTalkRef.current?.release()} onLostPointerCapture={() => holdTalkRef.current?.release()} onBlur={() => holdTalkRef.current?.release()}
          onKeyDown={e => { if ([' ', 'Enter'].includes(e.key) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); if (!e.repeat) void holdTalkRef.current?.press() } }}
          onKeyUp={e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); holdTalkRef.current?.release() } }}
        >{holdingTalk && !microphoneEnabled ? <LoaderCircle className="spin" size={18}/> : <Mic size={18}/>}<span>{holdingTalk ? microphoneEnabled ? 'Listening' : recovery ? 'Recovering…' : 'Connecting…' : 'Hold to talk'}</span></button>
        <button aria-label="Export" className="export-button" onClick={() => setMenu(menu === 'export' ? null : 'export')}><Download size={16}/><span>Export</span><ChevronDown size={13}/></button>
      </div>
    </header>

    <main ref={stageRef} className={`board-stage paper-${settings.paper} mode-${settings.mode} ${pendingImport ? 'import-open' : ''}`} style={paperStyle} onPointerMoveCapture={pointerMove} onPointerDownCapture={stopGlide} onWheelCapture={stopGlide} onDragOver={e => e.preventDefault()} onDropCapture={e => { const f = e.dataTransfer.files[0]; if (f && isPdfFile(f)) { e.preventDefault(); e.stopPropagation(); importFile(f, true) } else if (f?.type.startsWith('image/')) { e.preventDefault(); e.stopPropagation(); importAsBackground.current = true; void importImage(f) } }}>
      <div className="paper-pattern"/>
      <div className="inspector-zone" aria-hidden="true"/>
      {ready && settings.mode === 'page' && <div className="page-boundary" style={localBounds({ x: 0, y: 0, w: 794, h: 1123 })}><span>A4</span></div>}
      <WhiteboardCanvas persistenceKey={notebook.persistenceKey} onMount={onMount} renderShape={shape => shape.type === 'magic' ? <MagicShapeView shape={shape}/> : null}/>
      {settings.mode === 'document' && activeDocumentPage && <><DocumentPageMask bounds={{ ...pageToLocal(activeDocumentPage.bounds), w: activeDocumentPage.bounds.w * zoom, h: activeDocumentPage.bounds.h * zoom }}/><DocumentNavigator pages={documentPages} activePageId={activeDocumentPage.id} onPageChange={goToDocumentPage} onInfinite={() => changeMode('infinite')} onFit={() => goToDocumentPage(activeDocumentPage.id)}/></>}
      {!ready && <div className="notebook-loading">Opening notebook…</div>}
      {['magic', 'text', 'math'].includes(tool) && <div className={`magic-surface ${following ? 'is-following' : ''} ${aiPaused && tool === 'magic' ? 'is-recovering' : ''}`} onPointerDown={magicDown} onPointerUp={magicUp} onDoubleClick={editAtPointer} onPointerCancel={() => { gestureRef.current = null; pathRef.current = []; touches.current.clear(); pinch.current = null; setPath([]) }}/>}
      <svg className="gesture-overlay" aria-hidden="true">{path.length > 1 && <path d={path.map((p, i) => { const v = pageToLocal(p); return `${i ? 'L' : 'M'} ${v.x} ${v.y}` }).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}</svg>
      {focus && !path.length && !isEditing && <div className={`magic-focus ${focus.kind} focus-${settings.focusMode ?? 'reference'}`} style={focus.kind === 'region' ? localBounds(focus.bounds) : { left: pageToLocal(focus.bounds).x - 12, top: pageToLocal(focus.bounds).y - 12 }}><span>{focus.kind === 'region' ? `Work here · ${settings.focusMode === 'literal' ? 'Literal' : 'Reference'}` : settings.focusMode === 'literal' ? 'Circle an area for Literal mode' : 'Reference point'}</span></div>}
      {contentPreview && previewBounds && <div className="streaming-preview" aria-label="Live content draft" style={{...localBounds(previewBounds), fontSize: 28 * zoom, ...(settings.focusMode === 'literal' ? {overflow:'hidden'} : {})}}>{contentPreview.field === 'latex' ? <span style={{display:'inline-block'}} dangerouslySetInnerHTML={{ __html: katex.renderToString(contentPreview.value, {displayMode:true,throwOnError:false,trust:false,maxExpand:300,maxSize:20,strict:'ignore'}).replace('class="katex-display"', 'class="katex-display" style="margin:0;text-align:left"').replace('class="katex"', 'class="katex" style="text-align:left"') }}/> : <span>{contentPreview.field === 'expression' ? 'y = ' : ''}{contentPreview.value}</span>}<span className="streaming-caret"/></div>}

      {images.draft && <div className="image-placement-preview" style={localBounds(images.draft.bounds)} aria-label="Image placement preview"><span><ImagePlus size={16}/>{images.draft.phase === 'review' ? 'Image preview · awaiting confirmation' : ['submitting', 'generating'].includes(images.draft.phase) ? 'Generating image…' : 'Image request paused'}</span></div>}
      <ImageGenerationPanel images={images} model={api?.models?.image}/>

      <div className="board-options"><button onClick={() => setMenu(menu === 'paper' ? null : 'paper')}><Settings2 size={14}/>{settings.mode === 'page' ? 'A4 page' : settings.mode === 'document' ? 'Homework pages' : 'Infinite canvas'}<ChevronDown size={12}/></button><label className="work-area-control" title={settings.focusMode === 'literal' ? 'AI changes must fit within the selected region.' : 'Use the selected region as a location cue, with room to grow.'}>Work here<select disabled={aiPaused} aria-label="Work area mode" value={settings.focusMode ?? 'reference'} onChange={e=>changeFocusMode(e.target.value as 'reference' | 'literal')}><option value="reference">Reference</option><option value="literal">Literal</option></select></label><button aria-label="Help and pairing" title="Help and pairing" onClick={() => { setMenu(menu === 'help' ? null : 'help'); void refreshStatus().catch(() => {}) }}><CircleHelp size={16}/></button></div>
      <nav className="tool-rail" aria-label="Drawing tools">
        {([{ id: 'magic', label: 'Magic pen', key: 'M', icon: Sparkles }, { id: 'draw', label: 'Pencil', key: 'P', icon: Pencil }, { id: 'select', label: 'Select & move', key: 'V', icon: MousePointer2 }, { id: 'text', label: 'Text', key: 'T', icon: Type }, { id: 'math', label: 'Math', key: 'Q', icon: Sigma }, { id: 'eraser', label: 'Eraser', key: 'E', icon: Eraser }, { id: 'hand', label: 'Pan', key: 'H', icon: Hand }] as const).map(({ id, label, key, icon: Icon }) => <button key={id} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} className={tool === id ? 'active' : ''} onClick={() => chooseTool(id)}>{id === 'magic' && aiPaused ? <LoaderCircle className="spin" size={21}/> : <Icon size={21}/>}<span className="tool-tip">{label}<kbd>{key}</kbd></span></button>)}
        <div className="rail-divider"/>
        <div className="color-stack">{COLORS.map((c, i) => <button aria-label={`Ink color ${INK_COLORS[i]}`} key={c} className={color === c ? 'chosen' : ''} style={{ '--ink': c } as React.CSSProperties} onClick={() => { setColor(c); editor?.setStyleForNextShapes(DefaultColorStyle, INK_COLORS[i]); if (selectedRecord?.type === 'magic') execute([{ type: 'update_object', target: selected!.id, color: c }]); else editor?.setStyleForSelectedShapes(DefaultColorStyle, INK_COLORS[i]) }}/>)}</div>
        <div className="rail-divider"/><button title={`${inkSize === 's' ? 'Thin' : 'Medium'} ink · click to change`} aria-label="Change ink width" onClick={() => { const size = inkSize === 's' ? 'm' : 's'; setInkSize(size); editor?.setStyleForNextShapes(DefaultSizeStyle, size); notify(`${size === 's' ? 'Thin' : 'Medium'} ink selected.`) }}><span className="stroke-preview" style={{ height: inkSize === 's' ? 2 : 3 }}/></button>
      </nav>
      {['math','text'].includes(tool) && <div className="tool-instruction">Tap anywhere to write {tool === 'math' ? 'an equation' : 'text'}.</div>}
      {!shapeCount && ready && !['text','math'].includes(tool) && <div className="empty-board"><h1>Blank notebook</h1><p>Write with the pencil, type a note, or circle an area and ask for something.</p><div className="example-actions"><button onClick={example}>Try an example</button><button onClick={() => void worksheetExample()} disabled={busy}>Try a homework page</button></div></div>}

      {selected && selectedRecord && editor && !showHistory && inspectorOpen && !images.draft && <ObjectInspector key={selected.id} editor={editor} object={selected} shape={selectedRecord} editing={editingShapeId === selected.id} busy={busy} execute={executeManual}
        onCollapse={() => setInspectorOpen(false)} onDeselect={() => { flushSourceEdits(); editor.setEditingShape(null); editor.selectNone(); contentSelectionRef.current = undefined; setSelectedContent('') }}
        onEdit={() => beginEditing(selected.id)} onNaturalSize={resetGraphSize} onCleanInk={formalizeSelection}
        onPlotInk={() => void runPrompt('Read the function in the selected handwriting and plot it nearby. Keep the original handwriting. If unclear, ask me.')}/>}
      {selected && !showHistory && !inspectorOpen && !images.draft && <button className="reopen-inspector" onClick={() => setInspectorOpen(true)}><Settings2 size={15}/>Object controls</button>}
      {showHistory && <aside className="history-panel"><div className="inspector-heading"><span>Conversation</span><button aria-label="Close conversation" onClick={() => setShowHistory(false)}><X size={16}/></button></div><div className="messages">{messages.length ? messages.map(m => <div className={`message ${m.role}`} key={m.id}><span>{m.role === 'user' ? 'You' : 'Assistant'}</span><p>{m.text}</p></div>) : <p className="quiet">Your instructions and replies will appear here.</p>}</div></aside>}

      {menu === 'paper' && <div className="popover paper-popover"><div className="popover-heading">Page settings<button aria-label="Close page settings" onClick={()=>setMenu(null)}><X size={16}/></button></div><span className="field-caption">Layout</span><div className="segmented"><button className={settings.mode === 'infinite' ? 'selected' : ''} onClick={() => changeMode('infinite')}>Infinite</button><button className={settings.mode === 'page' ? 'selected' : ''} onClick={() => changeMode('page')}>A4 page</button>{documentPages.length > 0 && <button className={settings.mode === 'document' ? 'selected' : ''} onClick={() => changeMode('document')}>Homework</button>}</div><span className="field-caption">Paper</span><div className="paper-swatches">{(['plain','dots', 'grid', 'ruled'] as const).map(p => <button aria-label={`${p} paper`} title={p} key={p} className={`swatch-${p} ${settings.paper === p ? 'selected' : ''}`} onClick={() => setSettings(s => ({ ...s, paper: p }))}/>)}</div><div className="paper-colors">{['#ffffff', '#f8f9fa', '#fffde7', '#eef5ff'].map(c => <button key={c} aria-label={`Paper color ${c}`} style={{ background: c }} className={settings.backgroundColor === c ? 'selected' : ''} onClick={() => setSettings(s => ({ ...s, backgroundColor: c }))}/>)}</div><button className="menu-row" onClick={() => { importAsBackground.current = true; imageInput.current?.click() }}><ImagePlus size={17}/>Set image background</button><button className="menu-row" onClick={() => { importAsBackground.current = false; imageInput.current?.click() }}><FileImage size={17}/>Insert movable image</button><button className="menu-row" onClick={() => projectInput.current?.click()}><FileUp size={17}/>Open notebook file</button><button className="menu-row" onClick={() => { void save(); setMenu(null) }}><Save size={17}/>Save editable notebook</button>{editor?.getCurrentPageShapes().some(s => s.meta.marginaliaBackground === true) && <button className="menu-row" onClick={removeBackground}><Trash2 size={17}/>Remove background</button>}</div>}
      {menu === 'export' && <div className="popover export-popover"><div className="popover-heading">Export<button aria-label="Close export" onClick={()=>setMenu(null)}><X size={16}/></button></div>{documentPages.length > 0 && <button className="menu-row" disabled={busy} onClick={() => void exportHomework()}><FileImage size={18}/><span>Homework PDF<small>Original pages with your work; excludes scratchwork</small></span></button>}<button className="menu-row" onClick={() => void doExport('png')}><FileImage size={18}/><span>PNG image<small>Include the whole board</small></span></button><button className="menu-row" onClick={() => void doExport('pdf')}><Download size={18}/><span>Canvas PDF<small>{settings.mode === 'page' ? 'A4 portrait page' : 'Fitted to your canvas'}</small></span></button><button className="menu-row" onClick={() => void exportArea()}><Scan size={18}/><span>Selected area PDF<small>{focus?.kind === 'region' ? 'The area you circled' : 'Circle an area or select objects first'}</small></span></button><button className="menu-row" onClick={() => {void save();setMenu(null)}}><Save size={18}/><span>Editable notebook<small>Keep the objects and images</small></span></button></div>}
      {menu === 'library' && <LibraryPanel books={books} openBookId={openBook?.id ?? null} onOpen={book => void openFromLibrary(book)} onImport={() => importInput.current?.click()} onRemove={book => void removeFromLibrary(book)} onClose={() => setMenu(null)}/>}
      {openBook && <ReferencePanel book={openBook} highlight={highlight} busy={refBusy || inserting} message={refMessage} lookup={lookup} onClose={closeBook} onSearch={text => void searchBook(text)}
        onDismiss={() => setHighlight(null)} onPageChange={index => { panelPageRef.current = { bookId: openBook.id, pageIndex: index }; voiceRef.current?.updateContext() }}
        onInsertPage={index => { const book = openBook; void panelInsert(() => libraryImageOp({ book, pageIndex: index }, `page ${book.labels?.[index] ?? index + 1}`, { manual: true })) }}
        onInsertCrop={(index, box) => { const book = openBook; void panelInsert(() => libraryImageOp({ book, pageIndex: index, box }, 'part of a textbook page', { manual: true })) }}
        onInsertCandidate={c => { const book = bookFor(c.bookId) ?? openBook; void panelInsert(() => libraryImageOp({ book, pageIndex: c.pageIndex, candidate: c }, c.description, { manual: true })) }}/>}
      {menu === 'help' && <div className="popover help-popover"><div className="popover-heading">Help & iPad connection<button aria-label="Close help" onClick={() => setMenu(null)}><X size={16}/></button></div><p><b>Magic pen:</b> tap near an object or loosely circle an area, then speak or type. Double-click an equation or text to edit its characters.</p><p><b>Work here:</b> Reference uses your selection as a location cue and allows content to grow beyond it. Literal keeps AI changes inside the selected region; circle an area first.</p><p><b>Graphs:</b> Equal units keeps x and y spacing the same. Natural graph size restores a comfortable width and height.</p><p><b>Voice mode:</b> hides the typing bar. The microphone circle responds to your actual voice. Choose Assistant, Dictate math, or Dictate text.</p><p><b>Hold to talk:</b> hold Shift+R to temporarily use the magic pen and microphone. Release to return to drawing. The Hold to talk button works on touch screens.</p><p><b>Keyboard:</b> Shift+V hides or shows the voice controls. Shift+Space starts or stops the microphone. Hiding the controls keeps the microphone in its current state. Shortcuts are inactive while typing or editing math.</p><p><b>Notebooks:</b> each notebook saves separately on this device. Download a notebook file to transfer it to another device.</p>{api?.pairingCode ? <div className="pair-code"><span>iPad pairing code</span><strong>{api.pairingCode}</strong><p>Open the HTTPS preview in iPad Safari and enter this code. It permits AI use through this laptop. It changes when the server restarts or after 20 wrong codes.</p></div> : <p>Find the pairing code in Help on the laptop at <b>localhost:3000</b>. This device does not display the code.</p>}<button className="menu-row" onClick={testVoice} disabled={checkingVoice || voiceStatus !== 'idle'}>{checkingVoice ? <LoaderCircle className="spin" size={15}/> : <Mic size={15}/>}Check voice connection</button><button className="menu-row" onClick={() => void worksheetExample()} disabled={busy}><FileImage size={16}/>Try a sample homework background</button><button className="menu-row" onClick={() => void downloadOriginal()}><Download size={16}/>Download original notebook backup</button>{api?.models && <p className="model-details"><b>AI models</b><br/>Voice: {api.models.realtime}<br/>Typed instructions: {api.models.text}<br/>Images: {api.models.image || 'gpt-image-2.5-flare'} · Low quality</p>}{allowance && <p className={`allowance-line ${allowance.low ? 'low' : ''}`}><b>Typed commands:</b> {allowance.left} of {allowance.limit} left in the local allowance.{allowance.low ? ' Check usage before raising OPENAI_COMMAND_LIMIT.' : ''}</p>}<small>Voice uses API credit while connected. Pause microphone closes the voice connection; turning spoken replies off only silences the assistant. Sessions renew automatically while active, with a {api?.limits?.voiceMinutesLimit ?? 180}-minute local allowance. Voice pauses after 90 seconds of inactivity.</small><p><a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">Third-party licenses</a></p></div>}

      {api?.pairingRequired && !api.authorized && <form className="pair-banner" onSubmit={e=>{e.preventDefault();void pair()}}><div><b>Connect your iPad to AI</b><span>On your laptop, open Help & iPad connection to find the code.</span></div><input aria-label="Pairing code" placeholder="6-digit code" value={pairCode} onChange={e => setPairCode(e.target.value)} inputMode="numeric" maxLength={6}/><button disabled={pairing}>{pairing?'Connecting…':'Connect'}</button></form>}
      <div className="canvas-footer"><span className="canvas-status">{settings.mode === 'page' ? 'A4 portrait' : settings.mode === 'document' ? 'Homework pages' : 'Infinite canvas'}<span className="footer-separator">·</span>{shapeCount} {shapeCount === 1 ? 'object' : 'objects'}</span><div className="history-buttons"><button aria-label="Undo" title="Undo" onClick={() => execute([{type:'undo'}])}><Undo2 size={17}/></button><button aria-label="Redo" title="Redo" onClick={() => execute([{type:'redo'}])}><Redo2 size={17}/></button></div><div className="zoom-controls"><button aria-label="Zoom out" onClick={() => editor?.zoomOut()}><Minus size={15}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => editor?.zoomIn()}><Plus size={15}/></button><button aria-label="Fit canvas" title="Fit canvas" onClick={() => settings.mode === 'page' ? editor?.zoomToBounds({ x: -100, y: -70, w: 994, h: 1313 }) : settings.mode === 'document' && activeDocumentPage ? goToDocumentPage(activeDocumentPage.id) : editor?.zoomToFit()}><Maximize size={15}/></button></div></div>

      <div className={`command-dock ${voiceMode ? 'voice-first' : ''}`}>
        {library.storageWarning && <div className="error-banner" role="alert">{library.storageWarning}</div>}
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
        {toast && !error && <div className="toast" role="status">{toast}</div>}
      {following && <div className="live-status">Move your pointer. Tap to place.</div>}
        {aiPaused && <div className="recovery-status" role="status"><LoaderCircle className="spin" size={18}/><span>{recovery?.message || commandProgress}<small>{recovery ? 'Microphone paused while I recover. You can still use the pencil.' : 'Magic pen paused. You can still use the pencil.'}</small></span><button aria-label="Cancel pending request" onClick={() => { commandAbort.current?.abort(); holdTalkRef.current?.cancel(); if (recovery) voiceRef.current?.disconnect() }}>Cancel</button></div>}
        <div id="voice-panel-controls" hidden={voiceControlsHidden}>
        {voiceMode ? <div className="voice-panel">
          <div className="voice-transcript" aria-live="polite">{recovery?.message || liveTranscript || (voiceStatus === 'connecting' ? 'Connecting… Allow microphone access if your browser asks.' : voiceStatus === 'thinking' ? 'Working…' : voiceStatus === 'speaking' ? 'Speaking…' : microphoneEnabled ? 'Listening. Point anywhere and speak.' : voiceStatus !== 'idle' ? 'Microphone paused. Hold Shift+R to speak again.' : 'Hold Shift+R to talk, or tap the microphone for continuous voice.')}</div>
          <div className="voice-controls"><button className="compact-control" aria-label="Show typing bar" title="Show typing bar" onClick={()=>setVoiceMode(false)}><Keyboard size={18}/></button><button ref={voiceOrbRef} className={`voice-orb ${microphoneEnabled ? 'connected' : ''}`} aria-label={voiceStatus === 'idle' ? 'Start voice session' : 'Stop voice session'} aria-keyshortcuts="Shift+Space" title="Start or stop voice session (Shift+Space)" onClick={()=>void toggleVoice()}><span className="voice-orb-halo"/>{voiceStatus === 'connecting' || recovery ? <LoaderCircle className="spin" size={25}/> : microphoneEnabled ? <Mic size={25}/> : <MicOff size={25}/>}</button><button className="compact-control" aria-label={spokenReplies ? 'Turn off spoken replies' : 'Enable spoken replies'} onClick={()=>{setSpokenReplies(v=>!v);voiceRef.current?.setSpokenReplies(!spokenReplies)}}>{spokenReplies?<Volume2 size={18}/>:<VolumeX size={18}/>}</button></div>
          <button className="microphone-pause" onClick={() => void toggleVoice()}>{voiceStatus === 'idle' ? 'Start continuous voice' : 'Stop voice session'}</button>
          <div className="voice-output-label">Spoken replies {spokenReplies ? 'on' : 'off'} · microphone {recovery ? 'paused for recovery' : microphoneEnabled ? 'on' : 'paused'}</div>
          <div className="voice-mode-options"><select disabled={!!recovery || holdingTalk || voiceStatus === 'thinking' || voiceStatus === 'connecting'} aria-label="Voice action" value={dictationMode} onChange={e=>changeDictation(e.target.value as typeof dictationMode)}><option value="assistant">Assistant</option><option value="math">Dictate math</option><option value="text">Dictate text</option></select><button onClick={()=>setShowHistory(!showHistory)}>Conversation</button></div>
          {dictationMode === 'math' && <p className="dictation-hint">Live LaTeX draft. Pause briefly between phrases to finish each edit.</p>}
          {dictationMode === 'text' && <p className="dictation-hint">Speak to write your words. Choose Assistant to give editing commands.</p>}
        </div> : <><form className={`command-bar ${microphoneEnabled ? 'voice-active' : ''}`} onSubmit={e => { e.preventDefault(); void runPrompt() }}><input ref={inputRef} aria-label="Ask MagiBoard" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Give an idea a little space…" disabled={busy || !!recovery || voiceStatus === 'connecting'}/><button type="submit" className="send-command" aria-label="Send instruction" disabled={busy || !!recovery || voiceStatus === 'connecting' || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowUp size={18}/>}</button><span className="command-divider"/><button type="button" className={`voice-button ${microphoneEnabled ? 'recording' : ''}`} aria-label={voiceStatus === 'idle' ? 'Start voice session' : 'Stop voice session'} aria-keyshortcuts="Shift+Space" title="Start or stop voice session (Shift+Space)" onClick={()=>void toggleVoice()}>{voiceStatus === 'connecting' || recovery ? <LoaderCircle className="spin" size={19}/> : microphoneEnabled ? <Mic size={19}/> : <MicOff size={19}/>}</button></form>
        <div className="command-caption"><span>{selectedContent ? `Selected: ${selectedContent.slice(0,35)}` : focus ? <><Scan size={12}/>{focus.kind === 'region' ? 'Region selected' : 'Point selected'}<button onClick={()=>setFocus(null)}>clear</button></> : 'Circle an area, then speak or type.'}</span>{allowance?.low && <span className="allowance-warning" role="status">{allowance.left ? `${allowance.left} of ${allowance.limit} typed commands left` : 'Typed command allowance used up'}</span>}<button onClick={()=>setShowHistory(!showHistory)}>Conversation{messages.length?` (${messages.length})`:''}</button></div></>}
        </div>
      </div>
    </main>
    <input className="hidden-input" ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void importImage(f); e.target.value = '' }}/>
    <input className="hidden-input" ref={importInput} type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f, false); e.target.value = '' }}/>
    {pendingImport && <ImportDialog file={pendingImport.file} info={pendingImport.info} progress={pendingImport.progress} busy={pendingImport.busy} choosing={pendingImport.choosing}
      defaultTarget={pendingImport.info ? defaultImportTarget(pendingImport.info.pageCount) : 'library'} boardLimit={boardImportLimit(pendingImport.info?.pageCount ?? 0, pendingImport.file.size)}
      onChoose={to => { const result = routeImport(to); if (!result.ok) setError(result.message) }} onCancel={() => { if (!importRef.current?.busy) setImport(null) }} container={stageRef.current}/>}
    <input className="hidden-input" ref={projectInput} type="file" accept=".json,.marginalia" onChange={async e => { const f = e.target.files?.[0]; if (f && editor) { setBusy(true); try { holdTalkRef.current?.cancel(); voiceRef.current?.disconnect(); flushSourceEdits(); editor.completeInteraction(); stopFollowing(); setDocumentPageId(null); setSettings(await loadProject(editor, f)); notify('Notebook opened.'); setMenu(null); setFocus(null) } catch (error) { setError((error as Error).message) } finally { setBusy(false) } } e.target.value = '' }}/>
  </div>
}
