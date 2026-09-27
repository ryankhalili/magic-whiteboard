import { createContext, useContext, useSyncExternalStore, type DependencyList, type ReactNode } from 'react'
import { Editor } from './editor'

const EditorContext = createContext<Editor | null>(null)

export function EditorProvider({ editor, children }: { editor: Editor; children: ReactNode }) {
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>
}

export function useEditor(): Editor {
  const editor = useContext(EditorContext)
  if (!editor) throw new Error('The whiteboard editor is not mounted.')
  return editor
}

const noSubscribe = () => () => {}
const zero = () => 0

/** Subscribe to the document revision, rather than an unstable computed array/object. */
export function useValue<T>(_label: string, getValue: () => T, dependencies: DependencyList = []): T {
  const contextual = useContext(EditorContext)
  const editor = contextual ?? dependencies.find(value => value instanceof Editor) as Editor | undefined
  useSyncExternalStore(editor ? listener => editor.subscribe(listener) : noSubscribe, editor ? () => editor.getRevision() : zero, zero)
  return getValue()
}

export function useIsEditing(id: string): boolean {
  const editor = useEditor()
  return useValue('Editing object', () => editor.getEditingShapeId() === id, [editor])
}
