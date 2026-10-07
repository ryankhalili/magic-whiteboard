import type { BoardContext, BoardOperation } from '../../shared/board'

/** A clipped source image must be rerendered, not stretched. Never act on another selection. */
export function excerptRepairOperation(text: string, context: BoardContext): BoardOperation[] | null {
  if (!/\b(?:cut off|cropped (?:out|off)|clipped|top.{0,25}missing|bottom.{0,25}missing|restore.{0,25}(?:excerpt|pdf)|repair.{0,25}(?:excerpt|crop))\b/i.test(text)
    || /\b(?:do not|don't|never|not yet)\b/i.test(text)) return null
  const ids = context.selectedIds.length ? context.selectedIds : context.lastCreatedIds
  if (ids.length !== 1 || !context.objects.some(object => object.id === ids[0] && object.kind === 'textbook_item' && !object.locked)) return null
  return [{ type: 'library_action', action: 'repair_excerpt', target: ids[0] }]
}
