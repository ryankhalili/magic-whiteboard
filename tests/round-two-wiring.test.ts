import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/canvas/editor'
import { createRealtimeClient } from '../src/ai/realtime'
import { insertMessage, modelLibrary } from '../src/appLogic'
import { BOARD_INSTRUCTIONS, compactContext, contextSchema } from '../server/board-tools'
import type { BoardContext, LibraryContext } from '../shared/board'

// the pieces the five parts of this round hand to each other

class FakeChannel extends EventTarget {
  readyState = 'connecting'
  sent: any[] = []
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 'closed' }
}
class FakePeer extends EventTarget {
  static latest: FakePeer
  channel = new FakeChannel()
  connectionState = 'new'
  constructor() { super(); FakePeer.latest = this }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() { return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' } }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')) }
  close() {}
}

const base: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1200, h: 800 } }
const ids = Array.from({ length: 150 }, (_, i) => `shape:ink${i}`)
const circled: BoardContext = { ...base, selectedIds: ids, lastCreatedIds: ids.slice(0, 120), focus: { kind: 'region', bounds: { x: 0, y: 0, w: 500, h: 300 }, targetIds: ids } }

describe('cut id lists', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const track = { stop: vi.fn(), enabled: true }
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }) } })
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject = null; setAttribute() {} pause() {} play() { return Promise.resolve() } })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ sdp: 'answer', sessionId: 'rtc_test', maxDurationSeconds: 300 }) })))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('use the same count names for typed and voice, and the rules name them', async () => {
    const typed = compactContext(contextSchema.parse(circled)) as Record<string, any>
    const client = createRealtimeClient({ getContext: () => circled, applyOperations: () => ({ ok: true, message: 'Applied.', ids: [] }), onStatus() {}, onTranscript() {}, onAssistant() {}, onError() {} })
    await client.connect()
    const item = FakePeer.latest.channel.sent.find(event => event.type === 'conversation.item.create' && event.item?.role === 'system')
    const voice = JSON.parse(item.item.content[0].text.split('\n').slice(1).join('\n'))
    client.disconnect()
    for (const context of [typed, voice]) {
      expect(context).toMatchObject({ selectedCount: 150, lastCreatedCount: 120, focus: { targetCount: 150 } })
      expect(context.selectedIds).toHaveLength(100)
    }
    for (const name of ['selectedCount', 'lastCreatedCount', 'focus.targetCount']) expect(BOARD_INSTRUCTIONS).toContain(name)
    // the controller still reaches every id through these targets
    expect(BOARD_INSTRUCTIONS).toContain('target "focus"')
  })
})

describe('library context', () => {
  it('the app sends what the shared type and the server schema describe', () => {
    const open = { title: 'Calculus Volume 1', pageCount: 769, labels: Array.from({ length: 769 }, (_, i) => i >= 7 ? String(i - 7) : null) }
    const library: LibraryContext | undefined = modelLibrary({ books: [open], open, pending: null, highlights: [], panelPageIndex: 240 })
    expect(library).toMatchObject({ openBook: { title: 'Calculus Volume 1' }, panelPage: { label: '233', pageIndex: 240 } })
    expect(contextSchema.parse({ ...base, library }).library).toEqual(library)
  })
  it('the rules say how to take a mistaken textbook page off the board', () => {
    expect(BOARD_INSTRUCTIONS).toContain('To take an inserted textbook_page off the board when the teacher asks, use delete_objects with its id')
  })
})

describe('page number fallback', () => {
  it('says once which page came in', () => {
    const note = 'No printed page 5, added file page 5.'
    expect(insertMessage('Added file page 5.', [note])).toBe(note)
    expect(insertMessage('Added page 14.', [note])).toBe(`Added page 14. ${note}`)
    expect(insertMessage('Added page 22.', ['Opened Calculus Volume 1.'])).toBe('Added page 22. Opened Calculus Volume 1.')
    expect(insertMessage('', [])).toBe('')
  })
})

describe('notebooks saved before worksheet pages stopped being backgrounds', () => {
  const page = (id: string, meta: Record<string, unknown>) => ({ id, typeName: 'shape', type: 'image', x: 0, y: 0, rotation: 0, index: 1, parentId: 'page:main', isLocked: true, opacity: 1, meta, props: { assetId: 'asset:page', w: 816, h: 1056 } })
  const asset = { id: 'asset:page', typeName: 'asset', type: 'image', meta: {}, props: { src: 'data:image/png;base64,AAAA', name: 'page', w: 10, h: 10, mimeType: 'image/png' } }
  it('open with their pages kept as pages, so a pasted image never removes them', () => {
    const editor = new Editor()
    editor.loadSnapshot({ document: { schema: { schemaVersion: 1, engine: 'magic-whiteboard' }, store: {
      'asset:page': asset,
      'shape:p1': page('shape:p1', { marginaliaBackground: true, pdf: { page: 1, pages: 3 } }),
      'shape:a4': page('shape:a4', { marginaliaBackground: true, pdf: { page: 1, pages: 1 } }),
      'shape:bg': page('shape:bg', { marginaliaBackground: true }),
    } } })
    expect(editor.getShape('shape:p1')?.meta).toMatchObject({ marginaliaBackground: false, pdf: { pages: 3 } })
    // a one page PDF fitted to A4 and an image background stay backgrounds
    expect(editor.getShape('shape:a4')?.meta.marginaliaBackground).toBe(true)
    expect(editor.getShape('shape:bg')?.meta.marginaliaBackground).toBe(true)
  })
})
