const HISTORY = /^(?:(?:no|wait|okay|ok|actually|please)[,\s]+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?(undo|redo)(?:\s+(?:that|it|this|the last (?:change|step|edit|one)))?(?:\s*,?\s*please)?[.!?]*$/i
/** "undo" or "redo" typed on its own runs on the board, with no model call */
export function localHistoryCommand(text: string): 'undo' | 'redo' | null {
  const match = HISTORY.exec(text.trim())
  return match ? match[1].toLowerCase() as 'undo' | 'redo' : null
}

