import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, LayoutPanelTop, Library, LoaderCircle, X } from 'lucide-react'
import type { ImportProgress } from './types'
import './library.css'

export type ImportTarget = 'board' | 'library'
export type ImportInfo = { pageCount: number; title: string; size: number }
type Props = {
  file: File; info: ImportInfo | null; defaultTarget: ImportTarget; progress: ImportProgress | null; busy: boolean
  /** why the board option is unavailable (too many pages or too large), null when it is fine */
  boardLimit?: string | null
  /** the choice being carried out when it was made by voice or typing rather than a click */
  choosing?: ImportTarget | null
  onChoose(target: ImportTarget): void; onCancel(): void
}

export const defaultImportTarget = (pageCount: number): ImportTarget => pageCount <= 1 ? 'board' : 'library'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / 1024 / 1024
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
}

export function progressFraction(progress: ImportProgress | null): number {
  if (!progress || !(progress.total > 0) || !Number.isFinite(progress.done)) return 0
  return Math.min(1, Math.max(0, progress.done / progress.total))
}

export function importProgressText(progress: ImportProgress): string {
  const total = Number.isFinite(progress.total) ? Math.max(0, Math.round(progress.total)) : 0
  const done = Number.isFinite(progress.done) ? Math.max(0, Math.round(progress.done)) : 0
  if (progress.phase === 'reading') return total ? `Reading page ${Math.min(total, done + 1)} of ${total}` : 'Reading the PDF'
  if (progress.phase === 'indexing') return 'Finding page numbers, problems and examples'
  return 'Saving to your library'
}

const pageText = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`

export function ImportDialog({ file, info, defaultTarget, progress, busy, boardLimit, choosing, onChoose, onCancel }: Props) {
  const [picked, setPicked] = useState<ImportTarget | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const cancelRef = useRef(onCancel); cancelRef.current = onCancel
  const busyRef = useRef(busy); busyRef.current = busy
  const boardBlocked = !!boardLimit
  const selected: ImportTarget = boardBlocked ? 'library' : defaultTarget
  useEffect(() => { if (!busy) setPicked(null) }, [busy])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); cancelRef.current() }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); try { previous?.focus() } catch { /* element may be gone */ } }
  }, [])
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('.import-choice.selected:not(:disabled)')?.focus() }, [selected])
  const choose = (target: ImportTarget) => { if (busy || (target === 'board' && boardBlocked)) return; setPicked(target); onChoose(target) }
  const meta = info ? [pageText(info.pageCount), formatBytes(info.size || file.size)].filter(Boolean).join(' · ') : `${formatBytes(file.size)} · Checking the PDF…`
  const fraction = progressFraction(progress)
  // library imports report progress, so a busy dialog with progress is saving to the library
  const active = busy ? picked ?? choosing ?? (progress ? 'library' : null) : null
  const choice = (target: ImportTarget) => {
    const board = target === 'board', disabled = busy || (board && boardBlocked), Icon = board ? LayoutPanelTop : Library
    return <button type="button" className={`import-choice ${selected === target ? 'selected' : ''} ${active === target ? 'picked' : ''}`} disabled={disabled} aria-describedby={board && boardLimit ? 'import-board-limit' : undefined} onClick={() => choose(target)}>
      <span className="import-choice-icon">{active === target ? <LoaderCircle className="spin" size={18}/> : <Icon size={18}/>}</span>
      <b>{board ? 'Put on the board' : 'Save to library'}</b>
      <span>{board ? 'Each page becomes a locked sheet you can write on.' : 'Keep it in this browser and pull any page or problem later.'}</span>
      {selected === target && !busy && <em className="import-suggested">Suggested</em>}
    </button>
  }
  const content = <aside className="import-layer" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }}>
    <div ref={dialog} className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <div className="import-heading"><h2 id="import-dialog-title">Import PDF</h2><button type="button" aria-label="Cancel import" onClick={onCancel} disabled={busy}><X size={16}/></button></div>
      <div className="import-file"><FileText size={20}/><span><strong title={file.name}>{file.name}</strong><small>{meta}</small></span></div>
      <div className="import-choices">{choice('board')}{choice('library')}</div>
      {boardLimit && <p className="import-limit" id="import-board-limit">{boardLimit}</p>}
      {busy && <div className="import-progress" role="status" aria-live="polite">
        <div className={`import-progress-bar ${progress ? '' : 'indeterminate'}`}><i style={progress ? { width: `${(fraction * 100).toFixed(1)}%` } : undefined}/></div>
        <div className="import-progress-text"><span>{progress ? importProgressText(progress) : active === 'board' ? 'Putting pages on the board' : 'Starting'}</span>{progress && progress.total > 0 && <span className="import-percent">{Math.round(fraction * 100)}%</span>}</div>
      </div>}
      <p className="import-hint">You can also say "store it" or "put it on the board".</p>
      <div className="import-actions"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
    </div>
  </aside>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
