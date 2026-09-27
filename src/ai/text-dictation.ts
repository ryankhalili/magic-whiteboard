import type { BoardCommand, BoardContext, BoardObject, BoardOperation, Bounds } from '../../shared/board'
import { applyContentEdit } from '../board/contentEdit'
import type { ContentPreview } from './content-preview'

export type TextDictationResult = {
  ok: true; command: BoardCommand; value: string; target?: string; bounds?: Bounds;
} | { ok: false; reason: string }

const fail = (reason: string): TextDictationResult => ({ ok: false, reason })
const stale = () => fail('The writing target changed while you were speaking. Dictate the phrase again.')
const validBounds = (bounds: Bounds, minimum = 16) => [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
  && Math.abs(bounds.x) <= 1e7 && Math.abs(bounds.y) <= 1e7 && bounds.w >= minimum && bounds.h >= minimum && bounds.w <= 10000 && bounds.h <= 10000

function inside(outer: Bounds, inner: Bounds) {
  // Match the board controller's allowance for page-bounds rounding noise.
  const epsilon = 1e-8
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon
    && inner.x + inner.w <= outer.x + outer.w + epsilon && inner.y + inner.h <= outer.y + outer.h + epsilon
}

function scopeKey(context: BoardContext): string {
  const selection = context.contentSelection
  return JSON.stringify({
    mode: context.dictationMode, focusMode: context.focusMode ?? 'reference',
    focus: context.focus ? { kind: context.focus.kind, bounds: context.focus.bounds, ids: [...context.focus.targetIds].sort() } : null,
    selected: [...context.selectedIds].sort(),
    selection: selection ? { shapeId: selection.shapeId, field: selection.field, start: selection.start, end: selection.end, text: selection.text, coordinateSpace: selection.coordinateSpace } : null,
    // Last-created only participates when it actually supplies the target.
    last: !selection && !context.selectedIds.length && !context.focus ? [...context.lastCreatedIds].sort() : undefined,
  })
}

function targetKey(object: BoardObject): string {
  return JSON.stringify({ id: object.id, kind: object.kind, text: object.text, bounds: object.bounds, rotation: object.rotation, locked: !!object.locked })
}

function appendFragment(source: string, text: string): string {
  // Preserve dictated punctuation and paragraph breaks. Only join separate word fragments.
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
  const separator = source && !/\s$/.test(source) && !/^[,.;:!?%)\]}，。！？；：、]/.test(text)
    && !/[(\[{“‘]$/.test(source) && !cjk.test(source.slice(-1)) && !cjk.test(text[0]) ? ' ' : ''
  return separator + text
}

/** Literal transcription only: even questions and command-like phrases are plain text. */
export function prepareTextDictation(transcript: string, captured: BoardContext, current: BoardContext): TextDictationResult {
  if (captured.dictationMode !== 'text' || current.dictationMode !== 'text') return fail('Choose Dictate text before dictating prose.')
  if (typeof transcript !== 'string' || transcript.length > 6000 || !transcript.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript)) return fail('Dictate a nonempty phrase under 6,000 characters.')
  if (scopeKey(captured) !== scopeKey(current)) return stale()
  if (captured.gesture?.active || current.gesture?.active) return fail('Finish choosing the writing area, then dictate the phrase again.')
  const text = transcript.trim()
  const emptyFocus = captured.focus && captured.focus.targetIds.length === 0
  const selection = emptyFocus ? undefined : captured.contentSelection
  const candidates = emptyFocus ? [] : selection ? [selection.shapeId]
    : captured.focus?.targetIds.length ? captured.focus.targetIds : captured.selectedIds.length ? captured.selectedIds : captured.lastCreatedIds
  const ids = [...new Set(candidates)]
  if (ids.length > 1) return fail('Select one text object or choose an empty writing area.')
  const target = captured.objects.find(object => object.id === ids[0])
  if (ids.length && !target) return stale()
  const liveTarget = current.objects.find(object => object.id === ids[0])
  if (target && (!liveTarget || targetKey(target) !== targetKey(liveTarget))) return stale()
  if (selection && (selection.field !== 'text' || target?.kind !== 'text')) return fail('Select text content before dictating a replacement.')

  const literal = captured.focusMode === 'literal'
  const region = literal && captured.focus?.kind === 'region' && validBounds(captured.focus.bounds) ? captured.focus.bounds : undefined
  if (literal && !region) return fail('Choose a valid literal writing region before dictating.')
  let operation: BoardOperation, value: string, bounds: Bounds | undefined
  if (target?.kind === 'text') {
    if (target.locked) return fail('That text object is locked. Unlock it before dictating.')
    if (typeof target.text !== 'string' || target.text.length > 6000 || !validBounds(target.bounds)) return fail('The selected text object is unavailable.')
    if (region && (!captured.focus!.targetIds.includes(target.id) || !inside(region, target.bounds))) return fail('Select a text object fully inside the literal writing region.')
    operation = { type: 'edit_content', target: target.id, field: 'text' }
    if (selection) {
      if (selection.coordinateSpace === 'text' && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
        if (selection.text !== undefined && target.text.slice(selection.start, selection.end) !== selection.text) return stale()
        Object.assign(operation, { start: selection.start, end: selection.end, replacement: text })
      } else if (selection.coordinateSpace !== 'mathlive' && selection.start === undefined && selection.end === undefined && selection.text) {
        Object.assign(operation, { find: selection.text, replace: text })
      } else return fail('Select an exact text range before dictating a replacement.')
    } else operation.replacement = appendFragment(target.text, text)
    try { value = applyContentEdit(target.text, operation) }
    catch { return fail('The selected text range is ambiguous or no longer valid. Select it again.') }
    bounds = { ...target.bounds }
  } else {
    if (region && (region.w < 80 || region.h < 48)) return fail('Choose a literal writing region at least 80 by 48 pixels.')
    if (!captured.focus && (JSON.stringify(captured.viewport) !== JSON.stringify(current.viewport) || !validBounds(captured.viewport))) return stale()
    if (captured.focus && !validBounds(captured.focus.bounds, 0)) return fail('Choose a valid writing location before dictating.')
    operation = { type: 'create_text', text, placement: captured.focus ? 'focus' : 'auto' }
    value = text
    bounds = region ? { ...region } : undefined
  }
  if (value.length > 6000) return fail('This text would exceed 6,000 characters. Choose a new writing area.')
  return { ok: true, command: { operations: [operation], message: '' }, value, target: operation.target, bounds }
}

/** Shares the final edit's targeting and stale-context guards; never applies a board operation. */
export function generateTextTranscriptPreview(itemId: string, transcript: string, captured: BoardContext, current: BoardContext): ContentPreview | null {
  if (!itemId || itemId.length > 200) return null
  const result = prepareTextDictation(transcript, captured, current)
  if (!result.ok) return null
  return { callId: `transcript:${itemId}`, operationIndex: 0, kind: result.target ? 'edit' : 'text', field: 'text',
    value: result.value, target: result.target, bounds: result.bounds, complete: false, operationType: result.command.operations[0].type }
}
