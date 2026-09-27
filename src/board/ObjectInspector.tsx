import { useEffect, useRef, useState } from 'react'
import katex from 'katex'
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, Lock, Minus, Pencil, Plus, RotateCcw, RotateCw, Sparkles, Sigma, Trash2, Unlock, X } from 'lucide-react'
import type { Editor, TLShape } from '../canvas/editor'
import type { BoardObject, BoardOperation, BoardResult } from '../../shared/board'
import type { MagicShape } from './MagicShape'
import { flushSourceEdits, SOURCE_FLUSH_EVENT, sourceField, sourceUpdate, type SourceFlushOptions } from './liveSource'
import { dispatchContentSelection } from './InlineEditor'

type Props = {
  editor: Editor; object: BoardObject; shape: TLShape; editing: boolean; busy: boolean
  execute: (operations: BoardOperation[]) => BoardResult
  onCollapse: () => void; onDeselect: () => void; onEdit: () => void; onNaturalSize: () => void
  onCleanInk: () => void; onPlotInk: () => void
}

export function objectLabel(object: BoardObject): string {
  const name = object.kind === 'plot' ? 'Graph' : object.kind === 'math' ? 'Equation' : object.kind === 'geometry' ? 'Shape' : object.kind === 'image' ? 'Image' : object.kind === 'draw' ? 'Handwriting' : 'Text'
  const source = object.title || object.expression || object.latex || object.text
  return source ? `${name}: ${source.replace(/\s+/g, ' ').slice(0, 35)}` : name
}

function NumberField({ label, value, min, max, step = 'any', onCommit, disabled = false }: { label: string; value: number; min?: number; max?: number; step?: number | 'any'; onCommit: (value: number) => unknown; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))))
  const focused = useRef(false), dirty = useRef(false)
  useEffect(() => { if (!focused.current) { setDraft(String(Number(value.toFixed(3)))); dirty.current = false } }, [value])
  const commit = () => {
    if (!dirty.current) return
    const number = Number(draft)
    if (draft.trim() && Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max)) {
      const result = onCommit(number)
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) setDraft(String(Number(value.toFixed(3))))
    }
    else setDraft(String(Number(value.toFixed(3))))
    dirty.current = false
  }
  return <label>{label}<input aria-label={label} type="number" value={draft} min={min} max={max} step={step} disabled={disabled} onFocus={() => { focused.current = true }} onChange={event => { dirty.current = true; setDraft(event.target.value) }} onBlur={() => { focused.current = false; commit() }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur() } }}/></label>
}

function LiveSource({ editor, shape, disabled }: { editor: Editor; shape: MagicShape; disabled: boolean }) {
  const field = sourceField(shape), source = shape.props[field]
  const [draft, setDraft] = useState(source), [error, setError] = useState(''), [pending, setPending] = useState(false)
  const latest = useRef(shape); latest.current = shape
  const draftRef = useRef(source), dirty = useRef(false), activeGroup = useRef(false), focused = useRef(false)
  const lastApplied = useRef(source)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commit = (silent = false) => {
    clearTimeout(timer.current); timer.current = undefined; if (!silent) setPending(false)
    if (!dirty.current) return true
    const current = editor.getShape<MagicShape>(shape.id)
    if (!current || editor.isShapeOrAncestorLocked(current)) return false
    try {
      const props = sourceUpdate(current, draftRef.current)
      editor.updateShape<MagicShape>({ id: shape.id, type: 'magic', props })
      const canonical = props[field] as string
      lastApplied.current = canonical; dirty.current = false
      if (!silent) setError('')
      if (!focused.current) { draftRef.current = canonical; if (!silent) setDraft(canonical) }
      return true
    } catch (error) { if (!silent) setError((error as Error).message); return false }
  }
  const commitRef = useRef(commit); commitRef.current = commit
  useEffect(() => {
    if (!dirty.current && !(focused.current && source === lastApplied.current)) { lastApplied.current = source; draftRef.current = source; setDraft(source); setError('') }
  }, [source])
  useEffect(() => () => {
    if (timer.current) commitRef.current(true)
    clearTimeout(timer.current)
    if (activeGroup.current) editor.markHistoryStoppingPoint('Finish source editing')
  }, [editor, shape.id])
  useEffect(() => {
    const finish = (event: Event) => {
      const options = (event as CustomEvent<SourceFlushOptions>).detail ?? {}
      if (commitRef.current(options.silent)) dirty.current = false
      if (options.finishHistory !== false) {
        if (activeGroup.current) editor.markHistoryStoppingPoint('Finish source editing')
        activeGroup.current = false
      }
    }
    window.addEventListener(SOURCE_FLUSH_EVENT, finish)
    return () => window.removeEventListener(SOURCE_FLUSH_EVENT, finish)
  }, [editor])
  const change = (value: string) => {
    if (!activeGroup.current) { editor.completeInteraction(); editor.markHistoryStoppingPoint('Edit object source'); activeGroup.current = true }
    draftRef.current = value; dirty.current = true; setDraft(value); setPending(true); setError('')
    clearTimeout(timer.current); timer.current = setTimeout(() => commitRef.current(), 180)
  }
  const select = (element: HTMLTextAreaElement) => dispatchContentSelection({ shapeId: shape.id, field, start: element.selectionStart, end: element.selectionEnd, text: element.value.slice(element.selectionStart, element.selectionEnd), coordinateSpace: 'text' })
  return <div className="live-source-editor">
    <label className="field-label">{field === 'latex' ? 'LaTeX source' : field === 'expression' ? 'Function or equation' : shape.props.kind === 'geometry' ? 'Labels' : 'Text'}<textarea aria-label="Object content" value={draft} disabled={disabled} rows={field === 'expression' ? 2 : 3} spellCheck={field === 'text'} autoCapitalize="off" autoCorrect="off" onFocus={() => { focused.current = true }} onChange={event => { change(event.target.value); select(event.currentTarget) }} onSelect={event => select(event.currentTarget)} onBlur={() => { focused.current = false; commitRef.current(); if (activeGroup.current) editor.markHistoryStoppingPoint('Finish source editing'); activeGroup.current = false }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commitRef.current() } }}/></label>
    <div className={`source-status ${error ? 'has-error' : ''}`} role="status">{error || (pending ? 'Updating…' : 'Updates live as you type.')}{error && <button onClick={() => { clearTimeout(timer.current); dirty.current = false; const current = editor.getShape<MagicShape>(shape.id)?.props[field] ?? source; draftRef.current = current; setDraft(current); setError(''); setPending(false) }}>Restore last valid</button>}</div>
    {field === 'latex' && <div className="inspector-math-preview" aria-label="Compiled equation preview" dangerouslySetInnerHTML={{ __html: katex.renderToString(source, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 }).replace('class="katex"', 'class="katex" style="text-align:left"') }}/>}
  </div>
}

export function ObjectInspector({ editor, object, shape, editing, busy, execute, onCollapse, onDeselect, onEdit, onNaturalSize, onCleanInk, onPlotInk }: Props) {
  const locked = editor.isShapeOrAncestorLocked(shape), magic = shape.type === 'magic' ? shape : null
  const update = (fields: Omit<BoardOperation, 'type' | 'target'>) => execute([{ type: 'update_object', target: shape.id, ...fields }])
  const transform = (fields: Omit<BoardOperation, 'type' | 'target'>) => execute([{ type: 'transform_object', target: shape.id, ...fields }])
  const width = typeof shape.props.w === 'number' ? shape.props.w : undefined, height = typeof shape.props.h === 'number' ? shape.props.h : undefined
  const resize = (w: number, h: number) => {
    const localCenter = { x: (width ?? 0) / 2, y: (height ?? 0) / 2 }, center = editor.getShapePageTransform(shape).applyToPoint(localCenter)
    return transform({ bounds: { x: center.x - w / 2, y: center.y - h / 2, w, h } })
  }
  const layer = (front: boolean) => {
    flushSourceEdits(); editor.completeInteraction(); editor.markHistoryStoppingPoint('Change object layer')
    if (front) editor.bringToFront([shape.id]); else editor.sendToBack([shape.id])
    editor.markHistoryStoppingPoint('Finish object layer')
  }
  const crop = shape.type === 'image' ? shape.props.crop ?? { x: 0, y: 0, w: 1, h: 1 } : null
  const cropEdge = (edge: 'left' | 'top' | 'right' | 'bottom', percent: number) => {
    if (!crop) return
    let left = crop.x, top = crop.y, right = 1 - crop.x - crop.w, bottom = 1 - crop.y - crop.h
    if (edge === 'left') left = percent / 100; if (edge === 'right') right = percent / 100
    if (edge === 'top') top = percent / 100; if (edge === 'bottom') bottom = percent / 100
    return update({ crop: { x: left, y: top, w: 1 - left - right, h: 1 - top - bottom } })
  }
  return <aside className="object-inspector" aria-label="Object controls">
    <div className="inspector-heading"><span>{objectLabel({ ...object, title: '', expression: '', latex: '', text: '' })}</span><div className="inspector-heading-actions"><button aria-label={locked ? 'Unlock object' : 'Lock object'} title={locked ? 'Unlock object' : 'Lock object'} onClick={() => { flushSourceEdits(); editor.completeInteraction(); editor.markHistoryStoppingPoint('Change object lock'); editor.run(() => editor.updateShape({ id: shape.id, type: shape.type, isLocked: !locked }), { ignoreShapeLock: true }); editor.markHistoryStoppingPoint('Finish object lock') }}>{locked ? <Lock size={14}/> : <Unlock size={14}/>}</button><button aria-label="Collapse object controls" onClick={onCollapse}><ChevronDown size={16}/></button><button aria-label="Deselect object" onClick={onDeselect}><X size={16}/></button></div></div>
    <button className="inspector-text-button" onClick={() => { const bounds = editor.getShapePageBounds(shape); if (bounds) editor.zoomToBounds(bounds, { inset: 140 }) }}>Zoom to object</button>
    {locked && <p className="inspector-hint">This object is locked. Unlock it to change its content or appearance.</p>}
    {magic && <>
      {magic.props.kind !== 'geometry' && <button className={`edit-on-board ${editing ? 'is-editing' : ''}`} disabled={locked} onPointerDown={event => event.preventDefault()} onClick={onEdit}><Pencil size={14}/>{editing ? 'Editing on board · click to focus' : 'Edit on board'}</button>}
      <LiveSource key={shape.id} editor={editor} shape={magic} disabled={locked}/>
      {magic.props.kind === 'plot' && <>
        <details className="inspector-section" open><summary>Graph axes</summary><div className="inspector-number-grid">
          <NumberField label="X minimum" value={magic.props.xMin} disabled={locked} onCommit={xMin => update({ xMin })}/><NumberField label="X maximum" value={magic.props.xMax} disabled={locked} onCommit={xMax => update({ xMax })}/>
          <NumberField label="Y minimum" value={magic.props.yMin} disabled={locked} onCommit={yMin => update({ yMin, axisMode: 'auto' })}/><NumberField label="Y maximum" value={magic.props.yMax} disabled={locked} onCommit={yMax => update({ yMax, axisMode: 'auto' })}/>
        </div><label className="inspector-select">Axis scaling<select aria-label="Graph axis scaling" disabled={locked} value={object.axisMode ?? 'auto'} onChange={event => update({ axisMode: event.target.value as 'equal' | 'auto' })}><option value="equal">Equal units</option><option value="auto">Independent axes</option></select></label><div className="inspector-checks"><label><input type="checkbox" checked={magic.props.showGrid !== false} disabled={locked} onChange={event => update({ showGrid: event.target.checked })}/>Grid</label><label><input type="checkbox" checked={magic.props.showAxes !== false} disabled={locked} onChange={event => update({ showAxes: event.target.checked })}/>Axes</label></div><button className="inspector-text-button" disabled={locked} onClick={onNaturalSize}>Natural graph size</button><p className="inspector-hint">Equal units keeps the same spacing on both axes. Editing Y limits switches to independent axes.</p></details>
      </>}
      <details className="inspector-section" open><summary>Appearance</summary><div className="inspector-number-grid">
        <NumberField label="Font size" value={magic.props.fontSize} min={8} max={160} disabled={locked} onCommit={fontSize => update({ fontSize })}/><label>Ink color<input aria-label="Object ink color" type="color" disabled={locked} value={magic.props.color.startsWith('#') ? magic.props.color : '#202124'} onChange={event => update({ color: event.target.value })}/></label>
        {['plot', 'geometry'].includes(magic.props.kind) && <NumberField label="Line width" value={magic.props.strokeWidth ?? 2.6} min={.25} max={24} step={.25} disabled={locked} onCommit={strokeWidth => update({ strokeWidth })}/>}
        {magic.props.kind === 'geometry' && <><label>Fill color<input aria-label="Object fill color" type="color" disabled={locked} value={magic.props.fill?.startsWith('#') ? magic.props.fill : '#93c5fd'} onChange={event => update({ fill: event.target.value, fillOpacity: magic.props.fillOpacity ?? .15 })}/></label><NumberField label="Fill opacity %" value={(magic.props.fill && magic.props.fill !== 'none' ? magic.props.fillOpacity ?? .15 : 0) * 100} min={0} max={100} disabled={locked} onCommit={value => update({ fill: magic.props.fill && magic.props.fill !== 'none' ? magic.props.fill : '#93c5fd', fillOpacity: value / 100 })}/><button className="inspector-text-button" disabled={locked} onClick={() => update({ fill: 'none' })}>No fill</button></>}
      </div></details>
    </>}
    {shape.type === 'draw' && <><button className="edit-on-board" disabled={busy || locked} onClick={onCleanInk}><Sparkles size={14}/>Clean up handwriting</button><button className="edit-on-board" disabled={busy || locked} onClick={onPlotInk}><Sigma size={14}/>Plot this handwriting</button></>}
    {crop && <details className="inspector-section" open><summary>Image crop</summary><div className="inspector-number-grid"><NumberField label="Crop left %" value={crop.x * 100} min={0} max={99} disabled={locked} onCommit={value => cropEdge('left', value)}/><NumberField label="Crop right %" value={(1 - crop.x - crop.w) * 100} min={0} max={99} disabled={locked} onCommit={value => cropEdge('right', value)}/><NumberField label="Crop top %" value={crop.y * 100} min={0} max={99} disabled={locked} onCommit={value => cropEdge('top', value)}/><NumberField label="Crop bottom %" value={(1 - crop.y - crop.h) * 100} min={0} max={99} disabled={locked} onCommit={value => cropEdge('bottom', value)}/></div><button className="inspector-text-button" disabled={locked} onClick={() => update({ crop: { x: 0, y: 0, w: 1, h: 1 } })}>Reset crop</button><p className="inspector-hint">Crop edges hide part of the original image. The original stays in your notebook.</p></details>}
    <details className="inspector-section"><summary>Size, rotation & layer</summary><div className="inspector-number-grid">
      {width !== undefined && height !== undefined && shape.type !== 'draw' && <><NumberField label="Object width" value={width} min={16} max={10000} disabled={locked} onCommit={value => resize(value, height)}/><NumberField label="Object height" value={height} min={16} max={10000} disabled={locked} onCommit={value => resize(width, value)}/></>}
      <NumberField label="Rotation degrees" value={shape.rotation * 180 / Math.PI} disabled={locked} onCommit={rotation => transform({ rotation })}/><NumberField label="Object opacity %" value={shape.opacity * 100} min={0} max={100} disabled={locked} onCommit={value => update({ opacity: value / 100 })}/>
    </div><div className="inspector-layer-buttons"><button disabled={locked} onClick={() => layer(true)}><ArrowUpToLine size={14}/>Bring to front</button><button disabled={locked} onClick={() => layer(false)}><ArrowDownToLine size={14}/>Send to back</button></div></details>
    <div className="object-actions"><button disabled={locked} aria-label="Rotate left 90 degrees" title="Rotate left 90°" onClick={() => transform({ rotateBy: -90 })}><RotateCcw size={16}/></button><button disabled={locked} aria-label="Rotate right 90 degrees" title="Rotate right 90°" onClick={() => transform({ rotateBy: 90 })}><RotateCw size={16}/></button><button disabled={locked} aria-label="Make smaller" title="Make smaller" onClick={() => transform({ scale: .85 })}><Minus size={16}/></button><button disabled={locked} aria-label="Make bigger" title="Make bigger" onClick={() => transform({ scale: 1.15 })}><Plus size={16}/></button><button disabled={locked} className="delete-object" aria-label="Delete selected object" onClick={() => execute([{ type: 'delete_objects', ids: editor.getSelectedShapeIds() }])}><Trash2 size={16}/></button></div>
    <p className="inspector-hint">Select moves objects. Double-click text or math to edit characters. This card stays available while you edit.</p>
  </aside>
}
