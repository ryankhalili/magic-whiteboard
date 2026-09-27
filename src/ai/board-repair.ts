import type { BoardContext, BoardObject, BoardOperation, BoardResult, ContentField } from '../../shared/board'

const contentKeys = new Set(['latex', 'expression', 'text', 'field', 'start', 'end', 'replacement', 'find', 'replace'])
const aliases = new Set(['selected', 'selection', 'last', 'focus'])
const createFields: Partial<Record<BoardOperation['type'], ContentField>> = { create_math: 'latex', create_plot: 'expression', create_text: 'text' }
const sourceFor = (object: BoardObject): ContentField | null => object.kind === 'math' ? 'latex' : object.kind === 'plot' ? 'expression' : object.kind === 'text' ? 'text' : null

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function targets(operation: BoardOperation, context: BoardContext): string[] {
  if (operation.ids?.length) return [...new Set(operation.ids)]
  if (operation.target && !aliases.has(operation.target)) return [operation.target]
  if (operation.target === 'selected' || operation.target === 'selection') return context.selectedIds
  if (operation.target === 'last') return context.lastCreatedIds
  if (operation.target === 'focus') return context.focus?.targetIds ?? []
  return context.selectedIds.length ? context.selectedIds : context.focus?.targetIds.length ? context.focus.targetIds : context.lastCreatedIds
}

type RepairScope = { original: BoardOperation; field: ContentField; targets: string[] }
export type BoardRepair = {
  failedOperations: BoardOperation[]
  scopes: RepairScope[]
  objects: BoardObject[]
  originalContext: BoardContext
  creates: boolean
}
type Decision<T> = { ok: true; value: T } | { ok: false; reason: string }

export function failureMessage(results: BoardResult | BoardResult[]): string {
  const failures = (Array.isArray(results) ? results : [results]).filter(result => !result.ok)
  return [...new Set(failures.map(result => result.message).filter(Boolean))].join(' ').slice(0, 1500) || 'The board could not apply that edit.'
}

/** Only an unchanged, completely failed content edit is eligible for one correction. */
export function prepareBoardRepair(operations: BoardOperation[], before: BoardContext, after: BoardContext, results: BoardResult | BoardResult[]): Decision<BoardRepair> {
  const outcomes = Array.isArray(results) ? results : [results]
  if (!outcomes.length || outcomes.some(result => result.ok || result.ids.length)) return { ok: false, reason: 'The edit may have partly succeeded, so it cannot be safely repeated.' }
  if (!operations.length) return { ok: false, reason: 'There was no content edit to correct.' }
  if (/locked|outside.*literal|literal.*focus|no longer exists|select an object|unsupported (?:operation|action|object|tool)|(?:operation|action|object|tool).*not supported|credit|quota/i.test(failureMessage(results))) return { ok: false, reason: 'Choose a valid target or rephrase the instruction before trying again.' }
  const scopes: RepairScope[] = []
  for (const original of operations) {
    const createField = createFields[original.type]
    if (createField) scopes.push({ original, field: createField, targets: [] })
    else if (original.type === 'update_object' || original.type === 'edit_content') {
      const ids = targets(original, before)
      const objects = ids.map(id => before.objects.find(object => object.id === id))
      if (!ids.length || objects.some(object => !object || object.locked)) return { ok: false, reason: 'The original target is unavailable.' }
      const fields = objects.map(object => sourceFor(object!))
      if (!fields[0] || fields.some(field => field !== fields[0])) return { ok: false, reason: 'This operation is not a correctable text or math edit.' }
      const field = fields[0]
      if (original.type === 'edit_content' ? original.field !== field : original[field] === undefined) return { ok: false, reason: 'Only the failed content can be corrected automatically.' }
      scopes.push({ original, field, targets: ids })
    } else return { ok: false, reason: 'This action needs a new instruction rather than an automatic repeat.' }
  }
  const creates = scopes.some(scope => !scope.targets.length)
  if (creates && (scopes.some(scope => scope.targets.length) || canonical(before) !== canonical(after))) return { ok: false, reason: 'New content can only be retried as an entirely failed creation batch on an unchanged board.' }
  const ids = new Set(scopes.flatMap(scope => scope.targets))
  const objects = before.objects.filter(object => ids.has(object.id))
  const repair: BoardRepair = structuredClone({ failedOperations: operations, scopes, objects, originalContext: before, creates })
  const current = validateRepairContext(repair, after)
  return current.ok ? { ok: true, value: repair } : current
}

export function validateRepairContext(repair: BoardRepair, context: BoardContext): Decision<true> {
  if ((repair.originalContext.focusMode ?? 'reference') !== (context.focusMode ?? 'reference')) return { ok: false, reason: 'The work-area mode changed while the edit was being corrected.' }
  if (context.focusMode === 'literal' && canonical(context.focus) !== canonical(repair.originalContext.focus)) return { ok: false, reason: 'The literal work area changed while the edit was being corrected.' }
  if (repair.creates && canonical(context) !== canonical(repair.originalContext)) return { ok: false, reason: 'The board or placement changed while the new content was being corrected.' }
  for (const original of repair.objects) {
    const current = context.objects.find(object => object.id === original.id)
    if (!current || canonical(current) !== canonical(original)) return { ok: false, reason: 'The original object changed while the edit was being corrected. Please give the instruction again.' }
  }
  return { ok: true, value: true }
}

/** Pin omitted/alias targets to the original IDs, and reject unrelated operations. */
export function pinBoardRepair(repair: BoardRepair, proposed: BoardOperation[], context: BoardContext): Decision<BoardOperation[]> {
  const current = validateRepairContext(repair, context)
  if (!current.ok) return current
  if (!proposed.length || proposed.length !== repair.scopes.length) return { ok: false, reason: 'The correction must address exactly the failed edits.' }
  const output: BoardOperation[] = [], available = [...repair.scopes]
  for (const candidate of proposed) {
    const index = available.findIndex(scope => {
      if (!scope.targets.length) return candidate.type === scope.original.type
      if (!['update_object', 'edit_content'].includes(candidate.type)) return false
      const ids = candidate.ids?.length ? candidate.ids : candidate.target && !aliases.has(candidate.target) ? [candidate.target] : scope.targets
      return ids.length === scope.targets.length && ids.every(id => scope.targets.includes(id))
    })
    const scope = available[index]
    if (!scope) return { ok: false, reason: 'The correction tried to change a different object or perform another action.' }
    available.splice(index, 1)
    if (candidate.type === 'edit_content' && candidate.field !== scope.field) return { ok: false, reason: 'The correction changed a different content field.' }
    for (const [key, value] of Object.entries(candidate)) {
      if (value === undefined || ['type', 'target', 'ids'].includes(key)) continue
      if (contentKeys.has(key)) {
        if (['latex', 'expression', 'text'].includes(key) && key !== scope.field) return { ok: false, reason: 'The correction changed a different content field.' }
        continue
      }
      if (canonical(value) !== canonical((scope.original as unknown as Record<string, unknown>)[key])) return { ok: false, reason: 'The correction introduced an unrequested formatting or placement change.' }
    }
    if (candidate.type !== 'edit_content' && candidate[scope.field] === undefined) return { ok: false, reason: 'The correction did not provide the failed content.' }
    const pinned = { ...candidate }
    delete pinned.target; delete pinned.ids
    if (scope.targets.length === 1) pinned.target = scope.targets[0]
    else if (scope.targets.length) pinned.ids = [...scope.targets]
    output.push(pinned)
  }
  return { ok: true, value: output }
}

export function repairInstructions(repair: BoardRepair) {
  return {
    attemptsRemaining: 1,
    failedOperations: repair.failedOperations,
    originalTargetIds: repair.objects.map(object => object.id),
    instruction: 'The entire previous content operation failed. You may make ONE corrected apply_board_operations call for exactly the failed content edits and original IDs only. Preserve the mathematical intent and existing content; repair syntax or use a valid full-source update for a broken fragment edit. Retry a creation only if it is one of the failed creations. Do not add unrelated objects, make unrelated deletions, change formatting, move anything, or repeat successful work. Existing target IDs are pinned, even if selection changes. The current context below includes the source. If you cannot correct it confidently, ask the user one short question instead. A second failed edit will stop automatic recovery.',
  }
}
