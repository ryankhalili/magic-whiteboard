import { useEffect, useRef, useState } from 'react'
import { useEditor } from 'tldraw'
import type { MathfieldElement } from 'mathlive'
import type { MagicShape } from './MagicShape'
import { autoYRange, validateExpression } from './expression'
import 'mathlive/fonts.css'
import './inline-editor.css'

export type ContentSelectionEvent = { shapeId: string; field: 'text' | 'latex' | 'expression'; start: number; end: number; text: string; coordinateSpace: 'text' | 'mathlive' }
export function dispatchContentSelection(detail: ContentSelectionEvent) {
  window.dispatchEvent(new CustomEvent('marginalia-content-selection', { detail }))
}

export function InlineEditor({ shape, preview }: { shape: MagicShape; preview?: { field: 'latex' | 'text' | 'expression'; value: string } | null }) {
  const editor = useEditor(), isMath = shape.props.kind === 'math'
  const fieldName = isMath ? 'latex' : shape.props.kind === 'plot' ? 'expression' : 'text'
  const wrapper = useRef<HTMLDivElement>(null), mathHost = useRef<HTMLDivElement>(null)
  const mathField = useRef<MathfieldElement | null>(null), textarea = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(shape); latest.current = shape
  const visibleValue = preview?.field === fieldName ? preview.value : shape.props[fieldName]
  const latestValue = useRef(visibleValue); latestValue.current = visibleValue
  const [sourceMode, setSourceMode] = useState(false), [loading, setLoading] = useState(isMath)
  const [error, setError] = useState(''), [draft, setDraft] = useState(shape.props[fieldName])
  const finish = () => { editor.setEditingShape(null); editor.setCurrentTool('select.idle'); editor.markHistoryStoppingPoint('Finish editing content') }
  const commit = (value: string) => {
    setDraft(value)
    if (value.length > 6000) { setError('Keep this object under 6,000 characters.'); return }
    if (fieldName === 'expression') {
      try {
        const expression = validateExpression(value).expression
        const [yMin, yMax] = autoYRange(expression, latest.current.props.xMin, latest.current.props.xMax)
        editor.updateShape<MagicShape>({ id: shape.id, type: 'magic', props: { expression, yMin, yMax } })
        setError('')
      } catch (e) { setError((e as Error).message) }
    } else editor.updateShape<MagicShape>({ id: shape.id, type: 'magic', props: { [fieldName]: value } })
  }
  const commitRef = useRef(commit); commitRef.current = commit
  const finishRef = useRef(finish); finishRef.current = finish
  useEffect(() => {
    editor.markHistoryStoppingPoint('Edit object content')
    return () => { editor.markHistoryStoppingPoint('After content editing') }
  }, [editor, shape.id])
  useEffect(() => {
    const value = visibleValue
    setDraft(value)
    const mf = mathField.current
    if (mf && mf.value !== value) {
      const position = mf.position
      mf.setValue(value, { silenceNotifications: true })
      mf.position = Math.min(position, mf.lastOffset)
    }
  }, [visibleValue])
  useEffect(() => {
    if (!isMath || sourceMode) { textarea.current?.focus(); return }
    let cancelled = false
    let removeListeners: (() => void) | undefined
    setLoading(true)
    void import('mathlive').then(({ MathfieldElement: MathField }) => {
      if (cancelled || !mathHost.current) return
      MathField.fontsDirectory = null // fonts are bundled locally via fonts.css
      MathField.soundsDirectory = null
      const mf = new MathField()
      mf.className = 'marginalia-math-field'
      mf.setAttribute('aria-label', 'Edit equation')
      mf.mathVirtualKeyboardPolicy = 'auto'
      mf.defaultMode = 'math'
      mf.value = latestValue.current
      const input = () => commitRef.current(mf.value)
      const selection = () => {
        const range = mf.selection.ranges[0] ?? [mf.position, mf.position]
        dispatchContentSelection({ shapeId: shape.id, field: 'latex', start: Math.min(...range), end: Math.max(...range), text: mf.getValue(mf.selection), coordinateSpace: 'mathlive' })
      }
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); event.stopPropagation(); finishRef.current() }
      }
      // Let MathLive's shadow input receive ordinary keys before stopping them at the canvas boundary.
      const stopKeyboardBubble = (event: KeyboardEvent) => event.stopPropagation()
      const mounted = () => {
        if (cancelled) return
        setLoading(false)
        mf.focus()
        mf.position = mf.lastOffset
      }
      mf.addEventListener('input', input)
      mf.addEventListener('selection-change', selection)
      mf.addEventListener('keydown', keydown, true)
      mf.addEventListener('keydown', stopKeyboardBubble)
      mf.addEventListener('mount', mounted, { once: true })
      mathField.current = mf
      removeListeners = () => { mf.removeEventListener('input', input); mf.removeEventListener('selection-change', selection); mf.removeEventListener('keydown', keydown, true); mf.removeEventListener('keydown', stopKeyboardBubble); mf.removeEventListener('mount', mounted); mf.remove(); mathField.current = null }
      mathHost.current.replaceChildren(mf)
    }).catch((error: unknown) => {
      console.error('Math editor failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error).slice(0, 300))
      if (!cancelled) { setLoading(false); setSourceMode(true); setError('Math editor could not load. You can edit its LaTeX source here.') }
    })
    return () => { cancelled = true; removeListeners?.() }
  }, [isMath, sourceMode, shape.id])

  const notifyTextSelection = (el: HTMLTextAreaElement) => dispatchContentSelection({ shapeId: shape.id, field: fieldName, start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd), coordinateSpace: 'text' })
  const isPlot = shape.props.kind === 'plot'
  const contentLimit = shape.meta?.literalBounds ? { maxHeight: Math.max(16, shape.props.h - 16 - (isMath && shape.props.title ? 29 : 0)), overflow: 'auto' } : undefined
  return <div ref={wrapper} className={`marginalia-inline-editor${isPlot ? ' is-plot-editor' : ''}`} style={{ width: isPlot ? shape.props.w - 64 : shape.props.w, minHeight: isPlot ? 28 : shape.props.h, fontSize: shape.props.fontSize, color: shape.props.color, ...(isPlot ? { position: 'absolute', left: 46, top: shape.props.title ? 24 : 4 } : {}) }}
    onPointerDown={event => { editor.markEventAsHandled(event); event.stopPropagation() }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
    onBlur={event => {
      const next = event.relatedTarget as HTMLElement | null
      if (next && (wrapper.current?.contains(next) || next.closest('.ML__keyboard,.ML__keyboard-container,math-field'))) return
      // MathLive keeps focus while its virtual keyboard is in use. Check after focus settles.
      requestAnimationFrame(() => {
        if (mathField.current?.hasFocus() || wrapper.current?.contains(document.activeElement)) return
        if (editor.getEditingShapeId() === shape.id) finishRef.current()
      })
    }}>
    {isMath && !sourceMode && <>{shape.props.title && <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#333', marginBottom: 8 }}>{shape.props.title}</div>}<div ref={mathHost} className="math-editor-host" style={contentLimit}/>{loading && <span className="editor-note">Loading equation editor…</span>}</>}
    {(!isMath || sourceMode) && <textarea ref={textarea} aria-label={fieldName === 'latex' ? 'LaTeX source' : fieldName === 'expression' ? 'Function expression' : 'Edit text'}
      className={isMath || fieldName === 'expression' ? 'content-source' : 'content-text'} style={contentLimit} value={draft} placeholder={isMath ? 'Enter LaTeX' : fieldName === 'expression' ? 'sin(x)' : 'Type here…'}
      spellCheck={fieldName === 'text'} autoCapitalize="off" autoCorrect="off" rows={fieldName === 'expression' ? 1 : 3}
      onChange={event => {
        commit(event.target.value); notifyTextSelection(event.target)
        if (fieldName === 'text' && !latest.current.meta?.literalBounds && event.target.scrollHeight + 16 > latest.current.props.h) {
          editor.updateShape<MagicShape>({ id: shape.id, type: 'magic', props: { h: Math.min(10000, event.target.scrollHeight + 16) } })
        }
      }}
      onSelect={event => notifyTextSelection(event.currentTarget)}
      onKeyDown={event => {
        if (event.key === 'Escape' || (event.key === 'Enter' && (fieldName !== 'text' || event.ctrlKey || event.metaKey))) { event.preventDefault(); finish() }
        event.stopPropagation()
      }}/>} 
    <div className="inline-editor-tools">{isMath && <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => setSourceMode(value => !value)}>{sourceMode ? 'Visual math' : 'LaTeX source'}</button>}<button type="button" onPointerDown={event => event.preventDefault()} onClick={finish}>Done</button></div>
    {error && <div className="editor-note" role="status">{error}</div>}
  </div>
}
