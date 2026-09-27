import type { Editor, TLShape } from './editor'

export type ContentPreviewTarget = { id: string; field: 'latex' | 'text' | 'expression'; source: string }

/** Transient rendering state only: never write streamed fragments to the document. */
export function getContentPreviewTarget(editor: Editor, detail: unknown, previous: ContentPreviewTarget | null = null): ContentPreviewTarget | null {
  if (!detail || typeof detail !== 'object') return null
  const input = detail as { target?: unknown; field?: unknown; value?: unknown }
  if (typeof input.target !== 'string' || typeof input.value !== 'string' || !['latex', 'text', 'expression'].includes(String(input.field))) return null
  const shape = editor.getShape(input.target)
  if (shape?.type !== 'magic') return null
  const field = input.field as ContentPreviewTarget['field']
  const source = shape.props[field]
  if (previous?.id === shape.id && previous.field === field && previous.source === source) return previous
  return { id: shape.id, field, source }
}

/** A final source commit ends the preview, even before its explicit clear event arrives. */
export function isContentPreviewTarget(shape: TLShape | undefined, preview: ContentPreviewTarget | null): boolean {
  return !!preview && shape?.type === 'magic' && shape.id === preview.id && shape.props[preview.field] === preview.source
}
