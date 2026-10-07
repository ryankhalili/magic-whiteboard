import type { BoardOperation } from '../../shared/board'
import { detectLibraryIntent } from './intent'

/** Opening a book cannot complete an explicit request to put an item on the board. */
export function completeLibraryRetrieval(operations: BoardOperation[], instruction: string): BoardOperation[] {
  if (operations.length !== 1 || operations[0].type !== 'library_action' || operations[0].action !== 'open_book') return operations
  const intent = detectLibraryIntent(instruction, { hasBooks: true, importPending: false })
  if (intent?.action !== 'insert') return operations
  return [{ type: 'insert_library', query: intent.query.raw, book: intent.query.book ?? operations[0].book }]
}
