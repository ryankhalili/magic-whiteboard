import { ChevronLeft, ChevronRight, Maximize, Move } from 'lucide-react'
import type { Bounds } from '../../shared/board'
import type { WorksheetPage } from '../files/pdfPages'
import './documents.css'

export type DocumentNavigatorProps = {
  pages: WorksheetPage[]
  activePageId: string | null
  onPageChange: (id: string) => void
  onInfinite: () => void
  onFit?: () => void
}

/** Navigation changes only the camera; pages, ink, and scratchwork keep their original coordinates. */
export function DocumentNavigator({ pages, activePageId, onPageChange, onInfinite, onFit }: DocumentNavigatorProps) {
  if (!pages.length) return null
  const index = Math.max(0, pages.findIndex(page => page.id === activePageId))
  const current = pages[index]
  return <nav className="document-navigator" aria-label="Homework pages">
    <button aria-label="Previous homework page" disabled={index === 0} onClick={() => onPageChange(pages[index - 1].id)}><ChevronLeft size={17}/></button>
    <label><span className="document-page-name" title={current.info.name}>{current.info.name}</span>
      <select aria-label="Homework page" value={current.id} onChange={event => onPageChange(event.target.value)}>
        {pages.map(page => <option key={page.id} value={page.id}>{page.info.name} · {page.info.page} / {page.info.pages}</option>)}
      </select>
    </label>
    <button aria-label="Next homework page" disabled={index === pages.length - 1} onClick={() => onPageChange(pages[index + 1].id)}><ChevronRight size={17}/></button>
    {onFit && <button aria-label="Fit homework page" title="Fit page" onClick={onFit}><Maximize size={16}/></button>}
    <button title="Show scratchwork around the pages" onClick={onInfinite}><Move size={15}/><span>Canvas</span></button>
  </nav>
}

/** A visual page window. It never modifies the saved scene or intercepts pen/zoom events. */
export function DocumentPageMask({ bounds }: { bounds: Bounds | null }) {
  if (!bounds) return null
  return <div className="document-page-mask" aria-hidden="true" style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}/>
}

export function nearestDocumentPage(pages: WorksheetPage[], center: { x: number; y: number }): WorksheetPage | null {
  let nearest: WorksheetPage | null = null, distance = Infinity
  for (const page of pages) {
    const bounds = page.bounds
    const dx = Math.max(bounds.x - center.x, 0, center.x - bounds.x - bounds.w)
    const dy = Math.max(bounds.y - center.y, 0, center.y - bounds.y - bounds.h)
    const next = dx * dx + dy * dy
    if (next < distance) { nearest = page; distance = next }
  }
  return nearest
}
