import type { BoardOperation } from '../../shared/board'

/** Text ranges are UTF-16 source offsets, never MathLive visual atom positions. */
export function applyContentEdit(source: string, operation: Pick<BoardOperation, 'start' | 'end' | 'replacement' | 'find' | 'replace'>): string {
  if (operation.find !== undefined) {
    if (typeof operation.find !== 'string' || !operation.find) throw new Error('Choose some text to replace.')
    if (typeof operation.replace !== 'string') throw new Error('Specify the replacement text.')
    if (operation.start !== undefined || operation.end !== undefined || operation.replacement !== undefined) throw new Error('Use either a selected range or an exact text match for an edit.')
    const at = source.indexOf(operation.find)
    if (at < 0) throw new Error('That content was not found in this object. Select it again.')
    if (source.indexOf(operation.find, at + 1) >= 0) throw new Error('That content occurs more than once. Select the exact occurrence to change.')
    return source.slice(0, at) + operation.replace + source.slice(at + operation.find.length)
  }
  if (typeof operation.replacement !== 'string') throw new Error('Specify the text to insert.')
  if (operation.replace !== undefined) throw new Error('An exact replacement also needs the text to find.')
  if (operation.start === undefined && operation.end === undefined) return source + operation.replacement
  const { start, end } = operation
  if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! < start! || end! > source.length) throw new Error('The selected text range is invalid. Select it again.')
  return source.slice(0, start) + operation.replacement + source.slice(end)
}
