import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, BookOpen, FileUp, Trash2, X } from 'lucide-react'
import type { BookRecord } from './types'
import { formatBytes } from './ImportDialog'
import './library.css'

type Props = { books: BookRecord[]; openBookId: string | null; onOpen(book: BookRecord): void; onImport(): void; onRemove(book: BookRecord): void; onClose(): void }
export type Point = { x: number; y: number }

export const PREVIEW_SIZE = { w: 280, h: 180 }
export const FOLLOW_FACTOR = .15

/** one animation frame of the preview follower: move a fraction of the way to the target, snap when close */
export function followStep(current: Point, target: Point, factor = FOLLOW_FACTOR): Point {
  const f = Number.isFinite(factor) ? Math.min(1, Math.max(0, factor)) : FOLLOW_FACTOR
  const x = current.x + (target.x - current.x) * f, y = current.y + (target.y - current.y) * f
  return Math.abs(target.x - x) < .5 && Math.abs(target.y - y) < .5 ? { ...target } : { x, y }
}

/** top left corner of the preview card: level with the cursor, outside the list (`avoid`) when there is room, inside the window */
export function previewTarget(pointer: Point, view: { w: number; h: number }, avoid?: { left: number; right: number } | null, card = PREVIEW_SIZE, gap = 24): Point {
  let x: number
  if (avoid && avoid.left - gap - card.w >= 8) x = avoid.left - gap - card.w - (avoid.right - pointer.x) * .08
  else if (avoid && avoid.right + gap + card.w <= view.w - 8) x = avoid.right + gap + (pointer.x - avoid.left) * .08
  else { const right = pointer.x + gap, left = pointer.x - gap - card.w; x = right + card.w <= view.w - 8 || left < 8 ? right : left }
  const y = pointer.y - card.h / 2
  return { x: Math.round(Math.max(8, Math.min(x, view.w - card.w - 8))), y: Math.round(Math.max(8, Math.min(y, view.h - card.h - 8))) }
}

export function openedText(openedAt: number, now = Date.now()): string {
  if (!Number.isFinite(openedAt) || openedAt <= 0) return ''
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  const days = Math.round((day(now) - day(openedAt)) / 86_400_000)
  if (days <= 0) return 'Opened today'
  if (days === 1) return 'Opened yesterday'
  if (days < 7) return `Opened ${days} days ago`
  return `Opened ${new Date(openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export function bookDescription(book: BookRecord, now = Date.now()): string {
  if (!book.indexed) return 'Import not finished. Open it to finish reading it.'
  const parts = [openedText(book.openedAt, now), formatBytes(book.size)]
  if (book.pageCount > 0 && book.textPages < book.pageCount / 2) parts.push('little searchable text')
  return parts.filter(Boolean).join(' · ')
}

export function LibraryPanel({ books, openBookId, onOpen, onImport, onRemove, onClose }: Props) {
  const [preview, setPreview] = useState<BookRecord | null>(null)
  const [showing, setShowing] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  const pos = useRef<Point>({ x: 0, y: 0 }), target = useRef<Point>({ x: 0, y: 0 })
  const frame = useRef(0), visible = useRef(false), reduced = useRef(false)
  useEffect(() => {
    try { reduced.current = matchMedia('(prefers-reduced-motion: reduce)').matches } catch { reduced.current = false }
    return () => cancelAnimationFrame(frame.current)
  }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.import-layer')) return
      if (confirming) setConfirming(null); else onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [confirming, onClose])
  useEffect(() => { if (confirming && !books.some(book => book.id === confirming)) setConfirming(null) }, [books, confirming])

  const place = () => { if (card.current) card.current.style.transform = `translate3d(${pos.current.x}px,${pos.current.y}px,0)` }
  const tick = () => {
    pos.current = followStep(pos.current, target.current); place()
    frame.current = pos.current.x === target.current.x && pos.current.y === target.current.y ? 0 : requestAnimationFrame(tick)
  }
  const track = (event: React.PointerEvent, book: BookRecord) => {
    if (event.pointerType !== 'mouse') return
    const box = panel.current?.getBoundingClientRect()
    target.current = previewTarget({ x: event.clientX, y: event.clientY }, { w: window.innerWidth, h: window.innerHeight }, box ? { left: box.left, right: box.right } : null)
    if (!visible.current || reduced.current) { pos.current = { ...target.current }; place() }
    else if (!frame.current) frame.current = requestAnimationFrame(tick)
    if (!visible.current) { visible.current = true; setShowing(true) }
    if (preview?.id !== book.id) setPreview(book)
  }
  const hide = () => { visible.current = false; setShowing(false); cancelAnimationFrame(frame.current); frame.current = 0 }

  return <div ref={panel} className="popover library-popover" role="dialog" aria-label="Library">
    <div className="popover-heading">Library<div className="library-heading-actions">{books.length > 0 && <button type="button" className="library-import" onClick={onImport}><FileUp size={14}/>Import PDF</button>}<button type="button" aria-label="Close library" onClick={onClose}><X size={16}/></button></div></div>
    {books.length ? <>
      <p className="library-caption">{books.length} {books.length === 1 ? 'book' : 'books'} in this browser. Pick one to open it beside the board.</p>
      <ul className="library-list" onPointerLeave={hide}>
        {books.map(book => {
          const open = book.id === openBookId, asking = confirming === book.id
          return <li key={book.id} className={`library-row ${open ? 'is-open' : ''} ${asking ? 'is-confirming' : ''}`} onPointerMove={event => { if (!asking) track(event, book) }} onPointerEnter={event => { if (asking) hide(); else track(event, book) }}>
            {asking ? <div className="library-confirm" role="alert">
              <span>Remove <b>{book.title}</b> from this browser?</span>
              <div><button type="button" className="library-danger" onClick={() => { setConfirming(null); hide(); onRemove(book) }}>Remove</button><button type="button" onClick={() => setConfirming(null)} autoFocus>Keep</button></div>
            </div> : <>
              <button type="button" className="library-open" onClick={() => { hide(); onOpen(book) }} aria-current={open ? 'true' : undefined}>
                <span className="library-text">
                  <span className="library-title"><span className="library-title-text">{book.title || book.fileName}</span><ArrowUpRight className="library-arrow" size={16} aria-hidden="true"/></span>
                  <span className="library-desc">{open && <em>Open now</em>}{bookDescription(book)}</span>
                </span>
                <span className="library-pages"><b>{book.pageCount}</b><small>{book.pageCount === 1 ? 'page' : 'pages'}</small></span>
              </button>
              <button type="button" className="library-remove" aria-label={`Remove ${book.title}`} title="Remove from this browser" onClick={() => { hide(); setConfirming(book.id) }}><Trash2 size={14}/></button>
            </>}
          </li>
        })}
      </ul>
      <div ref={card} className={`library-preview ${showing && preview ? 'is-visible' : ''}`} aria-hidden="true">
        {preview && (preview.cover ? <img src={preview.cover} alt="" draggable={false}/> : <div className="library-preview-fallback"><BookOpen size={20}/><span>{preview.title}</span></div>)}
      </div>
    </> : <div className="library-empty">
      <span className="library-empty-icon"><BookOpen size={22}/></span>
      <b>No books yet</b>
      <p>Import a PDF textbook, then ask for a page or a problem by number.</p>
      <button type="button" className="library-primary" onClick={onImport}><FileUp size={15}/>Import PDF</button>
    </div>}
    <p className="library-footnote">Books are saved in this browser only.</p>
  </div>
}
