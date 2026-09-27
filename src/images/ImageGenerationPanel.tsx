import { useEffect, useState } from 'react'
import { Check, ImagePlus, LoaderCircle, Scan, X } from 'lucide-react'
import type { useImageGeneration } from './useImageGeneration'
import type { ImageSize } from './placement'

export function ImageGenerationPanel({ images, model = 'gpt-image-2.5-flare' }: { images: ReturnType<typeof useImageGeneration>; model?: string }) {
  const [placementError, setPlacementError] = useState('')
  const draft = images.draft
  useEffect(() => setPlacementError(''), [draft?.requestId])
  if (!draft) return null
  const review = draft.phase === 'review'
  const waiting = ['submitting', 'generating'].includes(draft.phase)
  return <aside className="image-generation-panel" aria-label="Image generation">
    <div className="inspector-heading"><span><ImagePlus size={16}/> {review ? 'Review image' : waiting ? 'Creating image' : 'Image request'}</span>{!waiting && <button aria-label="Dismiss image preview" onClick={images.dismiss}><X size={16}/></button>}</div>
    {review ? <>
      <label className="field-label">Image description<textarea aria-label="Image description" value={draft.prompt} maxLength={4000} onChange={event => images.revise({ prompt: event.target.value })} placeholder="Describe the picture you want…"/></label>
      {draft.originalPrompt && draft.originalPrompt !== draft.prompt && <details><summary>Original request</summary><p className="quiet">{draft.originalPrompt}</p></details>}
      <label className="inspector-select">Format<select aria-label="Generated image format" value={draft.size} onChange={event => images.revise({ size: event.target.value as ImageSize })}><option value="1536x1024">Landscape</option><option value="1024x1024">Square</option><option value="1024x1536">Portrait</option></select></label>
      <button className="image-place-button" onClick={() => { try { images.placeHere(); setPlacementError('') } catch (error) { setPlacementError(error instanceof Error ? error.message : 'Select a work area first.') } }}><Scan size={15}/>Use current work area</button>
      {(placementError || draft.message) && <p className="quiet" role="status">{placementError || draft.message}</p>}
      <p className="quiet">The shaded area shows where your image will go. Review the description, then confirm.</p>
      <p className="image-cost">Uses API credit · {model} · Low quality draft. Cost varies with the image.</p>
      <button className="confirm-image" aria-label="Confirm and generate image" disabled={!draft.prompt.trim()} onClick={() => void images.confirm()}><Check size={18}/>Generate image</button>
    </> : waiting ? <div className="image-progress" role="status"><LoaderCircle className="spin" size={25}/><p>Generating your image…</p><small>You can keep drawing. It will appear in the shaded area when ready.</small></div> : <>
      <p className="quiet" role="status">{draft.message}</p>
      {draft.phase === 'uncertain' && <button className="apply-edit" onClick={() => void images.check()}>Check existing request</button>}
      <button className="apply-edit" onClick={images.reviewAgain}>Review a new request</button>
      <p className="image-cost">A new confirmed request may use additional API credit.</p>
    </>}
  </aside>
}
