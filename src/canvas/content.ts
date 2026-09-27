import type { Editor, TLShape } from './editor'

export function richTextToPlain(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: unknown; content?: unknown; type?: unknown }
  if (typeof node.text === 'string') return node.text
  if (node.type === 'hardBreak') return '\n'
  if (!Array.isArray(node.content)) return ''
  return node.content.map(richTextToPlain).join(node.type === 'doc' ? '\n' : '')
}

export function legacyText(props: { text?: unknown; richText?: unknown }): string {
  return typeof props.text === 'string' ? props.text : richTextToPlain(props.richText)
}

export function shapeOpacity(editor: Editor, shape: TLShape): number {
  let opacity = shape.opacity, parent = editor.getShape(shape.parentId)
  const seen = new Set([shape.id])
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id); opacity *= parent.opacity; parent = editor.getShape(parent.parentId)
  }
  return opacity
}
