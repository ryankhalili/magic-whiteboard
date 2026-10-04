import { useEffect, useId, useRef, useState } from 'react'
import { BookOpen, Check, ChevronDown, LoaderCircle, Pencil, Plus, X } from 'lucide-react'
import type { NotebookLibraryController } from './useNotebookLibrary'

export function NotebookSwitcher({ library, beforeChange }: { library: NotebookLibraryController; beforeChange?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const container = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); toggle.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  useEffect(() => { setRenaming(false); setError(null) }, [library.activeNotebook.id])

  const changeNotebook = async (action: () => void) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await beforeChange?.(); action(); setOpen(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The current notebook could not be saved. Please try again.') }
    finally { busyRef.current = false; setBusy(false) }
  }

  return <div className="notebook-switcher" ref={container}>
    <button ref={toggle} type="button" className="notebook-switcher-toggle" aria-label="Notebooks" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}>
      <BookOpen size={17}/><span>Notebooks</span><ChevronDown size={13}/>
    </button>
    {open && <div id={menuId} className="notebook-switcher-menu" role="dialog" aria-label="Notebook library" aria-busy={busy}>
      <div className="notebook-library-heading"><span>Your notebooks</span><span>{library.notebooks.length}</span></div>
      <p className="notebook-library-caption">Saved on this device</p>
      <ul className="notebook-list">
        {library.notebooks.map(notebook => <li key={notebook.id}>
          <button type="button" disabled={busy} className={`notebook-list-item ${notebook.id === library.activeNotebook.id ? 'active' : ''}`} aria-current={notebook.id === library.activeNotebook.id ? 'page' : undefined} onClick={() => {
            if (notebook.id === library.activeNotebook.id) { setOpen(false); return }
            void changeNotebook(() => library.selectNotebook(notebook.id))
          }}>
            <BookOpen size={17}/><span><strong>{notebook.settings.name.trim() || 'Untitled notebook'}</strong><small>{notebook.settings.mode === 'page' ? 'A4 page' : notebook.settings.mode === 'document' ? 'Homework pages' : 'Infinite canvas'}</small></span>{notebook.id === library.activeNotebook.id && <Check size={15}/>}
          </button>
        </li>)}
      </ul>
      {renaming ? <form className="notebook-rename-form" onSubmit={event => {
        event.preventDefault(); library.renameNotebook(library.activeNotebook.id, renameValue); setRenaming(false)
      }}>
        <input aria-label="Rename notebook" disabled={busy} value={renameValue} maxLength={120} onChange={event => setRenameValue(event.target.value)} autoFocus/>
        <button type="submit" disabled={busy} aria-label="Save notebook name"><Check size={16}/></button>
        <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(false)}><X size={16}/></button>
      </form> : <button type="button" disabled={busy} className="notebook-rename-button" onClick={() => { setRenameValue(library.activeNotebook.settings.name); setRenaming(true) }}><Pencil size={14}/>Rename current notebook</button>}
      <form className="notebook-create-form" onSubmit={event => {
        event.preventDefault()
        void changeNotebook(() => { library.createNotebook(name); setName('') })
      }}>
        <input aria-label="New notebook name" disabled={busy} placeholder="New notebook name" value={name} maxLength={120} onChange={event => setName(event.target.value)}/>
        <button type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}Create</button>
      </form>
      {busy && <p className="notebook-library-caption" role="status">Saving current notebook…</p>}
      {(error || library.storageWarning) && <p className="notebook-storage-warning" role="status">{error || library.storageWarning}</p>}
    </div>}
  </div>
}
