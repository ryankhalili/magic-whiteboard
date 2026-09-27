import type { BoardContext, BoardOperation, BoardResult } from '../../shared/board'
import type { ContentPreview } from './content-preview'
import { generateTextTranscriptPreview, prepareTextDictation, type TextDictationResult } from './text-dictation'
import { contextFingerprint } from './voice-recovery'

type Options = {
  getContext: () => BoardContext;
  applyOperations: (operations: BoardOperation[]) => BoardResult | BoardResult[] | Promise<BoardResult | BoardResult[]>;
  beforeApplyOperations?: () => void | Promise<void>;
  resolveTranscript?: (itemId: string, signal: AbortSignal) => Promise<string>;
  onNotice: (message: string) => void;
  onApplied?: (itemId: string, text: string, before: BoardContext, after: BoardContext) => void;
  onRecoveryState?: (active: boolean) => void;
  onIdle?: () => void;
}
type Turn = { id: string; captured: BoardContext; deadline: number; text?: string; failed?: boolean; wake?: () => void }
type Anchor = { context: BoardContext; target: string; consumedSelection: boolean }
type Transition = { before: BoardContext; after: BoardContext }
const clone = (context: BoardContext) => structuredClone(context)
const validId = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 200
const changedNotice = 'The writing target changed. Dictate the phrase again for the current selection.'
const retryNotice = "I couldn't transcribe that phrase. Please repeat it."

// Pointer hover and inactive gesture coordinates do not change the writing target.
function key(context: BoardContext): string {
  return contextFingerprint({ ...context, pointer: null, gesture: context.gesture?.active ? context.gesture : null,
    selectedIds: [...context.selectedIds].sort(), lastCreatedIds: [...context.lastCreatedIds].sort(),
    objects: [...context.objects].sort((a, b) => a.id.localeCompare(b.id)) })
}
const same = (a: BoardContext, b: BoardContext) => key(a) === key(b)

/** Certifies a context transition before using it to rebase later phrases. */
function ownChange(before: BoardContext, after: BoardContext, result: Extract<TextDictationResult, { ok: true }>, ids: string[]): string | undefined {
  const target = result.target ?? (ids.length === 1 ? ids[0] : undefined)
  if (!target || after.selectedIds.length !== 1 || after.selectedIds[0] !== target) return
  const object = after.objects.find(item => item.id === target)
  if (!object || object.kind !== 'text' || object.text !== result.value || object.locked) return
  if (!result.target && before.objects.some(item => item.id === target)) return
  if (after.contentSelection && JSON.stringify(after.contentSelection) !== JSON.stringify(before.contentSelection)) return
  const stable = (context: BoardContext) => ({ ...context, objects: context.objects.filter(item => item.id !== target),
    selectedIds: [], lastCreatedIds: [], contentSelection: null })
  if (!same(stable(before), stable(after))) return
  // The board controller updates its last-used target for both creation and edits.
  if (after.lastCreatedIds.length !== 1 || after.lastCreatedIds[0] !== target) return
  return target
}

/** FIFO literal writing. It never requests an assistant response or interprets spoken commands. */
export function createTextDictationSession(options: Options) {
  const queue: Turn[] = []
  const early = new Map<string, { text?: string; failed?: boolean }>()
  const finished = new Set<string>()
  const transitions: Transition[] = []
  let anchor: Anchor | undefined
  let generation = 0, draining = false, applying = false
  let recovery: { id: string; controller: AbortController } | undefined
  const notice = (message: string) => { try { options.onNotice(message) } catch { /* UI callbacks cannot break the queue. */ } }
  const remember = (id: string) => { finished.add(id); if (finished.size > 128) finished.delete(finished.values().next().value!) }

  function reset() {
    generation++
    for (const turn of queue) { remember(turn.id); turn.wake?.() }
    queue.length = 0; early.clear(); transitions.length = 0; anchor = undefined
    recovery?.controller.abort(); recovery = undefined
  }

  function normalize(captured: BoardContext, current: BoardContext): { captured: BoardContext; current: BoardContext } | null {
    let rebased = captured
    for (const transition of transitions) if (same(rebased, transition.before)) rebased = transition.after
    if (anchor && same(rebased, anchor.context) && same(current, anchor.context)) {
      if (anchor.consumedSelection) return null
      // An unchanged empty focus persists after create_text. Only our verified creation
      // grants continuation into its new object; choosing another focus removes it.
      const pin = (context: BoardContext) => {
        const copy = clone(context)
        if (copy.focus && copy.focus.targetIds.length === 0) copy.focus.targetIds = [anchor!.target]
        return copy
      }
      return { captured: pin(rebased), current: pin(current) }
    }
    return { captured: rebased, current }
  }

  function updateContext() {
    if (applying) return
    const current = options.getContext()
    if (anchor && !same(anchor.context, current)) { anchor = undefined; transitions.length = 0 }
    const head = queue[0]
    if (!head) return
    const contexts = normalize(head.captured, current)
    const check = contexts && prepareTextDictation('…', contexts.captured, contexts.current)
    if (!check || !check.ok) { reset(); notice(check && !check.ok ? check.reason : changedNotice) }
  }

  async function getTranscript(turn: Turn, epoch: number): Promise<string | undefined> {
    if (turn.text !== undefined) return turn.text
    if (!turn.failed && turn.deadline > Date.now()) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.max(0, turn.deadline - Date.now()))
        function done() { clearTimeout(timer); turn.wake = undefined; resolve() }
        turn.wake = done
      })
    }
    if (epoch !== generation) return
    if (turn.text !== undefined) return turn.text
    if (!options.resolveTranscript) { notice(retryNotice); return }
    const controller = new AbortController()
    recovery = { id: turn.id, controller }
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    try {
      options.onRecoveryState?.(true)
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error('cancelled'))
        controller.signal.addEventListener('abort', abortListener, { once: true })
        timer = setTimeout(() => controller.abort(), 25_000)
      })
      const text = await Promise.race([options.resolveTranscript(turn.id, controller.signal), aborted])
      if (epoch === generation) return turn.text ?? text
    } catch {
      if (epoch === generation) { if (turn.text !== undefined) return turn.text; notice(retryNotice) }
    } finally {
      clearTimeout(timer)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      controller.abort()
      if (recovery?.controller === controller) recovery = undefined
      try { options.onRecoveryState?.(false) } catch { /* Optional status callback. */ }
    }
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length) {
        const turn = queue[0], epoch = generation
        const text = await getTranscript(turn, epoch)
        if (epoch !== generation) continue
        if (text !== undefined) {
          try {
            applying = true
            await options.beforeApplyOperations?.()
            if (epoch !== generation) continue
            const before = clone(options.getContext())
            const contexts = normalize(turn.captured, before)
            const result = contexts && prepareTextDictation(text, contexts.captured, contexts.current)
            if (!result || !result.ok) notice(result && !result.ok ? result.reason : 'Select a new text range before dictating another replacement.')
            else {
              const applied = await options.applyOperations(result.command.operations)
              if (epoch !== generation) continue
              const results = Array.isArray(applied) ? applied : [applied]
              if (!results.length || results.some(item => !item.ok)) notice('That phrase could not be written. Select a writing area and repeat it.')
              else {
                const after = clone(options.getContext())
                const target = ownChange(before, after, result, [...new Set(results.flatMap(item => item.ids))])
                if (target) {
                  transitions.push({ before, after }); if (transitions.length > 16) transitions.shift()
                  anchor = { context: after, target, consumedSelection: !!contexts.captured.contentSelection && !!after.contentSelection }
                } else { anchor = undefined; transitions.length = 0 }
                options.onApplied?.(turn.id, text, before, after)
              }
            }
          } catch { if (epoch === generation) notice('That phrase could not be written. Please repeat it.') }
          finally { applying = false }
        }
        if (epoch === generation && queue[0] === turn) { queue.shift(); remember(turn.id) }
      }
    } finally {
      draining = false
      if (queue.length) void drain()
      else { try { options.onIdle?.() } catch { /* Optional UI callback. */ } }
    }
  }

  function enqueue(itemId: string, captured: BoardContext): boolean {
    if (!validId(itemId) || finished.has(itemId) || queue.some(turn => turn.id === itemId)) return false
    if (queue.length >= 8) { remember(itemId); early.delete(itemId); notice('Let the pending phrases finish, then dictate again.'); return false }
    const pending = early.get(itemId); early.delete(itemId)
    queue.push({ id: itemId, captured: clone(captured), deadline: Date.now() + 6000, ...pending })
    void drain()
    return true
  }
  function transcript(itemId: string, text: string) {
    if (!validId(itemId) || finished.has(itemId) || typeof text !== 'string') return
    const value = text.length <= 6000 ? text : text.slice(0, 6001)
    const state = value.trim() ? { text: value } : { failed: true }
    const turn = queue.find(item => item.id === itemId)
    if (turn) {
      if (turn.text !== undefined) return
      Object.assign(turn, state); turn.wake?.()
      if (recovery?.id === itemId && turn.text !== undefined) recovery.controller.abort()
    } else if (early.get(itemId)?.text === undefined) { early.set(itemId, state); if (early.size > 16) early.delete(early.keys().next().value!) }
  }
  function fail(itemId: string) {
    if (!validId(itemId) || finished.has(itemId)) return
    const turn = queue.find(item => item.id === itemId)
    if (turn) { turn.failed = true; turn.wake?.() }
    else if (!early.has(itemId)) { early.set(itemId, { failed: true }); if (early.size > 16) early.delete(early.keys().next().value!) }
  }
  function preview(itemId: string, text: string, captured?: BoardContext): ContentPreview | null {
    const current = options.getContext(), turn = queue.find(item => item.id === itemId)
    const contexts = normalize(captured ?? turn?.captured ?? current, current)
    return contexts ? generateTextTranscriptPreview(itemId, text, contexts.captured, contexts.current) : null
  }
  return { enqueue, transcript, fail, reset, updateContext, preview, isPending: () => draining || queue.length > 0 }
}
