import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/board'

export const NOTEBOOK_STORAGE_KEY = 'marginalia-notebooks-v1'
export const NOTEBOOK_BACKUP_KEY = `${NOTEBOOK_STORAGE_KEY}-backup`
export const NOTEBOOK_RECOVERY_KEY = `${NOTEBOOK_STORAGE_KEY}-recovery`
export const LEGACY_SETTINGS_KEY = 'marginalia-settings-v1'
export const LEGACY_NOTEBOOK_ID = 'legacy'
export const LEGACY_PERSISTENCE_KEY = 'marginalia-board-v1'

export interface NotebookRecord {
  id: string
  persistenceKey: string
  settings: AppSettings
  createdAt: number
  updatedAt: number
}

export interface NotebookManifest {
  version: 1
  activeNotebookId: string
  notebooks: NotebookRecord[]
}

export interface NotebookLibraryState {
  notebooks: NotebookRecord[]
  activeNotebook: NotebookRecord
  storageWarning: string | null
}

export type NotebookStorage = Pick<Storage, 'getItem' | 'setItem'>

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const TEMPORARY_WARNING = 'Notebook list could not be saved on this device. Download editable notebooks before closing this tab.'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeNotebookSettings(value: unknown): AppSettings {
  const input = object(value) ? value : {}
  const settings: AppSettings = {
    name: typeof input.name === 'string' ? input.name.slice(0, 120) : DEFAULT_SETTINGS.name,
    mode: input.mode === 'page' ? 'page' : 'infinite',
    focusMode: input.focusMode === 'literal' ? 'literal' : 'reference',
    paper: ['dots', 'grid', 'plain', 'ruled'].includes(String(input.paper)) ? input.paper as AppSettings['paper'] : DEFAULT_SETTINGS.paper,
    backgroundColor: typeof input.backgroundColor === 'string' && /^#[\da-f]{6}$/i.test(input.backgroundColor)
      ? input.backgroundColor : DEFAULT_SETTINGS.backgroundColor,
  }
  // Migrate both legacy settings and manifests created by the earlier prototype theme.
  if (settings.backgroundColor.toLowerCase() === '#fbfaf6' && settings.paper === 'dots') {
    settings.backgroundColor = '#ffffff'
    settings.paper = 'plain'
  }
  return settings
}

function persistenceKey(id: string) {
  return id === LEGACY_NOTEBOOK_ID ? LEGACY_PERSISTENCE_KEY : `marginalia-board-${id}`
}

/** Read metadata only; canvas contents remain in tldraw's per-notebook IndexedDB stores. */
export function parseNotebookManifest(text: string | null): NotebookManifest | null {
  if (!text || text.length > 2_000_000) return null
  try {
    const input: unknown = JSON.parse(text)
    if (!object(input) || input.version !== 1 || !Array.isArray(input.notebooks) || !input.notebooks.length) return null
    const seen = new Set<string>()
    const notebooks: NotebookRecord[] = []
    for (const entry of input.notebooks) {
      if (!object(entry) || typeof entry.id !== 'string' || (entry.id !== LEGACY_NOTEBOOK_ID && !UUID.test(entry.id)) || seen.has(entry.id)) return null
      if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt) || typeof entry.createdAt !== 'number' || typeof entry.updatedAt !== 'number') return null
      seen.add(entry.id)
      notebooks.push({
        id: entry.id, persistenceKey: persistenceKey(entry.id), settings: normalizeNotebookSettings(entry.settings),
        createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      })
    }
    return {
      version: 1, notebooks,
      activeNotebookId: typeof input.activeNotebookId === 'string' && seen.has(input.activeNotebookId)
        ? input.activeNotebookId : notebooks[0].id,
    }
  } catch { return null }
}

function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  // getRandomValues remains available on local-network HTTP where randomUUID may not be.
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class NotebookRepository {
  private manifest: NotebookManifest
  private state: NotebookLibraryState
  private warning: string | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly storage: NotebookStorage | null,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = uuid,
  ) {
    let raw: string | null = null
    let loaded: NotebookManifest | null = null
    try {
      raw = storage?.getItem(NOTEBOOK_STORAGE_KEY) ?? null
      loaded = parseNotebookManifest(raw)
      if (!loaded) {
        loaded = parseNotebookManifest(storage?.getItem(NOTEBOOK_BACKUP_KEY) ?? null)
        if (loaded) this.warning = 'The notebook list was recovered from a backup. Canvas data has not been deleted.'
      }
    } catch { this.warning = TEMPORARY_WARNING }

    if (raw && !parseNotebookManifest(raw)) {
      // Preserve the unreadable manifest before repairing it; never touch canvas databases.
      try { storage?.setItem(NOTEBOOK_RECOVERY_KEY, raw) } catch { /* Storage may be read-only or full. */ }
      this.warning ??= 'The notebook list was repaired. Unreadable metadata was preserved; canvas data has not been deleted.'
    }

    if (!loaded) {
      let legacy: unknown = null
      try { legacy = JSON.parse(storage?.getItem(LEGACY_SETTINGS_KEY) || 'null') } catch { /* Use safe defaults. */ }
      const settings = normalizeNotebookSettings(legacy)
      if (settings.backgroundColor.toLowerCase() === '#fbfaf6' && settings.paper === 'dots') {
        settings.backgroundColor = '#ffffff'
        settings.paper = 'plain'
      }
      const timestamp = this.now()
      loaded = { version: 1, activeNotebookId: LEGACY_NOTEBOOK_ID, notebooks: [{
        id: LEGACY_NOTEBOOK_ID, persistenceKey: LEGACY_PERSISTENCE_KEY,
        settings, createdAt: timestamp, updatedAt: timestamp,
      }] }
    }
    this.manifest = loaded
    if (!storage) this.warning = TEMPORARY_WARNING
    this.persist()
    this.state = this.makeState()
  }

  private makeState(): NotebookLibraryState {
    return {
      notebooks: this.manifest.notebooks,
      activeNotebook: this.manifest.notebooks.find(notebook => notebook.id === this.manifest.activeNotebookId) ?? this.manifest.notebooks[0],
      storageWarning: this.warning,
    }
  }

  private emit() {
    this.state = this.makeState()
    for (const listener of this.listeners) listener()
  }

  private persist(): boolean {
    if (!this.storage) { this.warning = TEMPORARY_WARNING; return false }
    try {
      const old = this.storage.getItem(NOTEBOOK_STORAGE_KEY)
      if (parseNotebookManifest(old)) {
        try { this.storage.setItem(NOTEBOOK_BACKUP_KEY, old!) } catch { /* Still attempt the primary write. */ }
      }
      this.storage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(this.manifest))
      if (this.warning === TEMPORARY_WARNING) this.warning = null
      return true
    } catch { this.warning = TEMPORARY_WARNING; return false }
  }

  private mergeStored() {
    try {
      const stored = parseNotebookManifest(this.storage?.getItem(NOTEBOOK_STORAGE_KEY) ?? null)
      if (!stored) return false
      const merged = new Map(this.manifest.notebooks.map(notebook => [notebook.id, notebook]))
      let changed = false
      for (const notebook of stored.notebooks) {
        const existing = merged.get(notebook.id)
        if (!existing || notebook.updatedAt > existing.updatedAt) { merged.set(notebook.id, notebook); changed = true }
      }
      // Keep the active notebook in this tab; another tab must not interrupt its voice session.
      if (changed) this.manifest = { ...this.manifest, notebooks: [...merged.values()].sort((a, b) => a.createdAt - b.createdAt) }
      return changed
    } catch { this.warning = TEMPORARY_WARNING; return false }
  }

  getSnapshot = (): NotebookLibraryState => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Called for cross-tab storage events; merges metadata without changing this tab's board. */
  refresh = () => {
    this.mergeStored()
    this.emit()
  }

  createNotebook = (name?: string): string => {
    this.mergeStored()
    let id = this.newId()
    if (!UUID.test(id)) throw new Error('Could not create a notebook identifier.')
    // A collision is extraordinarily unlikely, but must never point a new title at an old board.
    for (let attempt = 0; this.manifest.notebooks.some(notebook => notebook.id === id); attempt++) {
      if (attempt >= 5) throw new Error('Could not create a unique notebook. Try again.')
      id = this.newId()
      if (!UUID.test(id)) throw new Error('Could not create a notebook identifier.')
    }
    const timestamp = this.now()
    const record: NotebookRecord = {
      id, persistenceKey: persistenceKey(id), createdAt: timestamp, updatedAt: timestamp,
      settings: normalizeNotebookSettings({ ...DEFAULT_SETTINGS, name: name?.trim().slice(0, 120) || 'Untitled notebook' }),
    }
    const previous = this.manifest
    this.manifest = { ...previous, activeNotebookId: id, notebooks: [...previous.notebooks, record] }
    if (!this.persist()) {
      this.manifest = previous
      this.emit()
      throw new Error('There is not enough available browser storage to save a new notebook. Download a backup before freeing space.')
    }
    this.emit()
    return id
  }

  selectNotebook = (id: string) => {
    this.mergeStored()
    if (!this.manifest.notebooks.some(notebook => notebook.id === id)) return
    this.manifest = { ...this.manifest, activeNotebookId: id }
    this.persist()
    this.emit()
  }

  updateNotebookSettings = (id: string, settings: AppSettings) => {
    const local = this.manifest.notebooks.find(notebook => notebook.id === id)
    if (!local) return
    const requested = normalizeNotebookSettings(settings)
    const changedKeys = (Object.keys(requested) as (keyof AppSettings)[]).filter(key => requested[key] !== local.settings[key])
    const merged = this.mergeStored()
    const record = this.manifest.notebooks.find(notebook => notebook.id === id)
    if (!record) return
    // A stale tab changing its paper must not undo a title edited in another tab.
    const patch = Object.fromEntries(changedKeys.map(key => [key, requested[key]]))
    const next = normalizeNotebookSettings({ ...record.settings, ...patch })
    if (JSON.stringify(record.settings) === JSON.stringify(next)) { if (merged) this.emit(); return }
    this.manifest = {
      ...this.manifest,
      notebooks: this.manifest.notebooks.map(notebook => notebook.id === id ? {
        ...notebook, settings: next, updatedAt: Math.max(this.now(), notebook.updatedAt + 1),
      } : notebook),
    }
    this.persist()
    this.emit()
  }

  renameNotebook = (id: string, name: string) => {
    this.mergeStored()
    const record = this.manifest.notebooks.find(notebook => notebook.id === id)
    if (record) this.updateNotebookSettings(id, { ...record.settings, name: name.trim().slice(0, 120) || 'Untitled notebook' })
  }
}
