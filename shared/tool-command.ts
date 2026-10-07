import type { BoardCommand } from './board'
import { commandSchema, operationSchema } from './command-schema'

export const MAX_TOOL_ARGUMENTS = 64_000

export class BoardCommandParseError extends Error {
  readonly code = 'invalid_board_command'
  constructor(message = 'The assistant returned an invalid board edit.') { super(message); this.name = 'BoardCommandParseError' }
}

/** Accept only complete JSON and unambiguous transport envelopes; never invent an operation. */
export function parseBoardCommand(input: unknown): BoardCommand {
  let value = input
  if (typeof value === 'string') {
    if (value.length > MAX_TOOL_ARGUMENTS) throw new BoardCommandParseError('The board edit is too large.')
    try { value = JSON.parse(value) }
    catch { throw new BoardCommandParseError('The assistant returned an incomplete edit.') }
  }
  // Bound object inputs too, and reject poison keys before passing them to any schema.
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let count = 0, textLength = 0
  while (queue.length) {
    const next = queue.pop()!
    if (++count > 12_000 || next.depth > 12) throw new BoardCommandParseError('The board edit is too complex.')
    if (typeof next.value === 'string') textLength += next.value.length
    if (textLength > MAX_TOOL_ARGUMENTS) throw new BoardCommandParseError('The board edit is too large.')
    if (!next.value || typeof next.value !== 'object') continue
    if (!Array.isArray(next.value) && Object.getPrototypeOf(next.value) !== Object.prototype && Object.getPrototypeOf(next.value) !== null) throw new BoardCommandParseError()
    for (const [key, item] of Object.entries(next.value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new BoardCommandParseError()
      queue.push({ value: item, depth: next.depth + 1 })
    }
  }
  if (Array.isArray(value)) value = { operations: value, message: '' }
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.type === 'string' && !('operations' in record)) value = { operations: [record], message: '' }
    else if ('operations' in record && !('message' in record)) value = { ...record, message: '' }
  }
  const parsed = commandSchema.strict().safeParse(value)
  if (!parsed.success) throw new BoardCommandParseError()
  // Unknown properties must not be silently stripped from an otherwise valid action.
  const raw = value as { operations: unknown[] }
  for (const operation of raw.operations) if (!operationSchema.strict().safeParse(operation).success) throw new BoardCommandParseError()
  const proposal = parsed.data.operations.find(operation => operation.type === 'propose_image')
  if (proposal && (parsed.data.operations.length !== 1 || !proposal.prompt)) throw new BoardCommandParseError('An image proposal must be a single operation with a prompt.')
  const mathReview = parsed.data.operations.find(op => op.type === 'confirm_math' || op.type === 'cancel_math')
  if (mathReview && (parsed.data.operations.length !== 1 || !mathReview.target || mathReview.type === 'confirm_math' && !mathReview.previewRevision)) throw new BoardCommandParseError('Confirm or discard only the identified current math preview, separately from other actions.')
  return parsed.data as BoardCommand
}

export function safeParseBoardCommand(value: unknown): { success: true; data: BoardCommand } | { success: false; error: BoardCommandParseError } {
  try { return { success: true, data: parseBoardCommand(value) } }
  catch (error) { return { success: false, error: error instanceof BoardCommandParseError ? error : new BoardCommandParseError() } }
}
