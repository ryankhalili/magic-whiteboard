import type { BoardContext, BoardOperation, Bounds, ContentField } from '../../shared/board'

export type ContentPreview = {
  callId: string; operationIndex: number; kind: 'math' | 'text' | 'plot' | 'edit';
  field: ContentField; value: string; target?: string; bounds?: Bounds; complete: boolean;
  operationType?: BoardOperation['type']
}
type Node = { value: unknown; complete: boolean; children?: Record<string, Node> | Node[] }

/** Small, bounded JSON reader that can expose an unfinished string. It never evaluates code. */
function readPartial(source: string): Node | undefined {
  if (source.length > 100_000) return
  let cursor = 0
  const skip = () => { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++ }
  function string(): Node | undefined {
    if (source[cursor] !== '"') return
    cursor++
    let value = ''
    while (cursor < source.length) {
      const char = source[cursor++]
      if (char === '"') return { value, complete: true }
      if (char.charCodeAt(0) < 32) return
      if (char !== '\\') { value += char; continue }
      if (cursor >= source.length) break
      const escape = source[cursor++]
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (escape === 'u') {
        const hex = source.slice(cursor, cursor + 4)
        if (hex.length < 4 && /^[0-9a-f]*$/i.test(hex)) break
        if (!/^[0-9a-f]{4}$/i.test(hex)) return
        value += String.fromCharCode(parseInt(hex, 16)); cursor += 4
      } else if (Object.hasOwn(escapes, escape)) value += escapes[escape]
      else return
    }
    return { value, complete: false }
  }
  function read(depth = 0): Node | undefined {
    if (depth > 12) return
    skip()
    const char = source[cursor]
    if (char === '"') return string()
    if (char === '{') {
      cursor++
      const value: Record<string, unknown> = Object.create(null)
      const children: Record<string, Node> = Object.create(null)
      while (cursor < source.length) {
        skip(); if (source[cursor] === '}') { cursor++; return { value, children, complete: true } }
        const key = string()
        if (!key?.complete) break
        skip(); if (source[cursor++] !== ':') break
        const node = read(depth + 1)
        if (!node) break
        const name = String(key.value)
        value[name] = node.value; children[name] = node
        if (!node.complete) break
        skip(); if (source[cursor] === ',') { cursor++; continue }
        if (source[cursor] !== '}') break
      }
      return { value, children, complete: false }
    }
    if (char === '[') {
      cursor++
      const value: unknown[] = []; const children: Node[] = []
      while (cursor < source.length) {
        skip(); if (source[cursor] === ']') { cursor++; return { value, children, complete: true } }
        const node = read(depth + 1)
        if (!node) break
        value.push(node.value); children.push(node)
        if (!node.complete) break
        skip(); if (source[cursor] === ',') { cursor++; continue }
        if (source[cursor] !== ']') break
      }
      return { value, children, complete: false }
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return { value, complete: true } }
    }
    const number = source.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number && Number.isFinite(Number(number[0]))) { cursor += number[0].length; return { value: Number(number[0]), complete: true } }
  }
  return read()
}

export function extractContentPreviews(callId: string, source: string, context: BoardContext): ContentPreview[] {
  const root = readPartial(source)
  const operations = root?.children && !Array.isArray(root.children) ? root.children.operations?.children : undefined
  if (!Array.isArray(operations)) return []
  const previews: ContentPreview[] = []
  operations.slice(0, 12).forEach((operation, operationIndex) => {
    const props = operation.children
    if (!props || Array.isArray(props) || !props.type?.complete) return
    const type = props.type.value
    if (!['create_math', 'create_text', 'create_plot', 'update_object', 'edit_content'].includes(String(type))) return
    const target = props.target?.complete && typeof props.target.value === 'string' ? props.target.value : undefined
    const explicitIds = Array.isArray(props.ids?.value) ? props.ids.value.filter((id): id is string => typeof id === 'string') : []
    // Match the controller's aliases and priority. A missing explicit alias target
    // must not silently preview an unrelated last-created object.
    const resolvedTarget = explicitIds[0]
      || (target === 'selected' || target === 'selection' ? context.selectedIds[0]
        : target === 'focus' ? context.focus?.targetIds[0]
          : target === 'last' ? context.lastCreatedIds[0]
            : target || context.selectedIds[0] || context.focus?.targetIds[0] || context.lastCreatedIds[0])
    const existing = context.objects.find(object => object.id === resolvedTarget)
    const updating = type === 'edit_content' || type === 'update_object'
    if (updating && !existing) return
    const fields = type === 'edit_content' ? props.field?.complete ? [props.field.value] : [] : ['latex', 'text', 'expression']
    for (const candidate of fields) {
      if (!['latex', 'text', 'expression'].includes(String(candidate))) continue
      const field = candidate as ContentField
      const content = type === 'edit_content' ? props.replacement ?? props.replace : props[field]
      if (!content || typeof content.value !== 'string') continue
      let value = content.value
      if (type === 'edit_content') {
        const original = existing?.[field]
        if (typeof original !== 'string') continue
        if (props.find) {
          if (!props.find.complete || typeof props.find.value !== 'string' || !props.find.value) continue
          const find = props.find.value
          const at = original.indexOf(find)
          if (at < 0 || original.indexOf(find, at + find.length) !== -1) continue
          value = original.slice(0, at) + value + original.slice(at + find.length)
        } else if (props.start || props.end) {
          const start = props.start?.value; const end = props.end?.value ?? start
          if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) < Number(start) || Number(end) > original.length) continue
          value = original.slice(0, Number(start)) + value + original.slice(Number(end))
        } else value = original + value
      }
      const b = props.bounds?.value as Bounds | undefined
      const explicitBounds = b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0 ? b : undefined
      previews.push({ callId, operationIndex, field, value, complete: operation.complete, operationType: type as BoardOperation['type'],
        kind: type === 'edit_content' ? 'edit' : field === 'latex' ? 'math' : field === 'expression' ? 'plot' : 'text',
        target: updating ? existing?.id ?? target : target,
        bounds: explicitBounds ?? (updating ? existing?.bounds : undefined),
      })
    }
  })
  return previews
}
