import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Editor } from '../canvas/editor'
import type { BoardContext } from '../../shared/board'
import { ImageGenerationClient } from './imageGenerationClient'

export type { ImageDraft } from './imageGenerationClient'

export function useImageGeneration(notebookId: string, getEditor: () => Editor | null, getContext: () => BoardContext, onInserted: () => void | Promise<void>) {
  const latest = useRef({ notebookId, getEditor, getContext, onInserted })
  latest.current = { notebookId, getEditor, getContext, onInserted }
  const client = useMemo(() => {
    let storage: Storage | undefined
    try { storage = sessionStorage } catch { /* This tab can operate without persistent session storage. */ }
    return new ImageGenerationClient({ notebookId, storage,
      isCurrent: () => latest.current.notebookId === notebookId,
      getEditor: () => latest.current.getEditor(), getContext: () => latest.current.getContext(),
      onInserted: () => latest.current.onInserted(),
    })
  }, [notebookId])
  const draft = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  // A changed notebook retires its client before delayed responses can touch the new editor.
  useLayoutEffect(() => { client.start(); return client.stop }, [client])
  return { draft, propose: client.propose, confirm: client.confirm, check: client.check,
    revise: client.revise, placeHere: client.placeHere, dismiss: client.dismiss, reviewAgain: client.reviewAgain }
}
