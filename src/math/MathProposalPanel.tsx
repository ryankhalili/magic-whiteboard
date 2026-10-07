import { X } from 'lucide-react'
import type { MathProposal } from './MathProposal'
import { PlotGraphic } from '../board/PlotGraphic'
import './math-studio.css'

export function MathProposalPanel({ draft, onConfirm, onDismiss }: { draft: MathProposal; onConfirm: () => void; onDismiss: () => void }) {
  return <aside className="math-proposal" aria-label="Math preview">
    <header><strong>Review math</strong><button aria-label="Dismiss math preview" onClick={onDismiss}><X size={16}/></button></header>
    <p>Keep talking to adjust this draft. Say “add it” when it looks right.</p>
    <div className="math-proposal-plots">{draft.shapes.map(shape => <div key={shape.id}>
      <svg role="img" aria-label={`Preview of ${shape.props.expression}`} viewBox={`0 0 ${shape.props.w} ${shape.props.h}`}><PlotGraphic shape={shape}/></svg>
      <small>{shape.props.visualization?.type === 'phase' ? 'Numerical phase portrait' : '3D plot'} · x: {shape.props.xMin} to {shape.props.xMax}{shape.props.visualization?.type === 'revolution' ? '' : ` · y: ${shape.props.yMin} to ${shape.props.yMax}`}</small>
    </div>)}</div>
    <footer><button onClick={onDismiss}>Discard draft</button><button className="studio-insert" onClick={onConfirm}>Add to board</button></footer>
  </aside>
}
