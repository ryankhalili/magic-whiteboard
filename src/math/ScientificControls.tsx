import { useEffect, useState } from 'react'
import type { MagicShape } from '../board/MagicShape'
import type { BoardOperation, BoardResult } from '../../shared/board'
import { NumberField } from '../ui/NumberField'

export function ScientificControls({ shape, disabled, update }: { shape: MagicShape; disabled: boolean; update: (fields: Omit<BoardOperation, 'type' | 'target'>) => BoardResult }) {
  const p = shape.props, spec = p.visualization!
  const [secondary, setSecondary] = useState(spec.secondaryExpression ?? '')
  useEffect(() => { setSecondary(spec.secondaryExpression ?? '') }, [spec.secondaryExpression])
  const set = (changes: Partial<typeof spec>) => update({ visualization: { ...spec, ...changes } })
  return <details className="inspector-section" open><summary>{spec.type === 'phase' ? 'Phase portrait' : '3D view'}</summary>
    {spec.type === 'phase' && <label className="field-label">dy/dt<input aria-label="Phase dy/dt" value={secondary} disabled={disabled} onChange={e => setSecondary(e.target.value)} onBlur={() => { if (!set({ secondaryExpression: secondary }).ok) setSecondary(spec.secondaryExpression ?? '') }}/></label>}
    <div className="inspector-number-grid">
      <NumberField label={spec.type === 'revolution' ? 'Axial minimum' : 'X minimum'} value={p.xMin} disabled={disabled} onCommit={xMin => update({ xMin })}/>
      <NumberField label={spec.type === 'revolution' ? 'Axial maximum' : 'X maximum'} value={p.xMax} disabled={disabled} onCommit={xMax => update({ xMax })}/>
      {spec.type !== 'revolution' && <><NumberField label="Y minimum" value={p.yMin} disabled={disabled} onCommit={yMin => update({ yMin })}/><NumberField label="Y maximum" value={p.yMax} disabled={disabled} onCommit={yMax => update({ yMax })}/></>}
      {spec.type !== 'phase' && <><NumberField label="View yaw" value={spec.yaw ?? -35} min={-360} max={360} disabled={disabled} onCommit={yaw => set({ yaw })}/><NumberField label="View elevation" value={spec.pitch ?? 28} min={-85} max={85} disabled={disabled} onCommit={pitch => set({ pitch })}/></>}
      {spec.type === 'revolution' && <NumberField label="Sweep degrees" value={spec.sweep ?? 360} min={1} max={360} disabled={disabled} onCommit={sweep => set({ sweep })}/>}
      {spec.type === 'phase' && <NumberField label="Integration time" value={spec.duration ?? 8} min={.1} max={40} disabled={disabled} onCommit={duration => set({ duration })}/>}
    </div>
    {spec.type !== 'phase' && <div className="inspector-layer-buttons"><button disabled={disabled} onClick={() => set({ yaw: ((spec.yaw ?? -35) + 30 + 360) % 360 })}>Rotate view 30°</button><button disabled={disabled} onClick={() => set({ yaw: -35, pitch: 28 })}>Reset view</button></div>}
    {spec.type === 'revolution' && <label className="inspector-select">Revolve around<select aria-label="Revolution axis" value={spec.axis ?? 'x'} disabled={disabled} onChange={e => set({ axis: e.target.value as 'x' | 'y' })}><option value="x">X axis</option><option value="y">Y axis</option></select></label>}
    <div className="inspector-checks">{spec.type === 'phase' && <label><input type="checkbox" checked={p.showGrid !== false} disabled={disabled} onChange={e => update({ showGrid: e.target.checked })}/>Grid</label>}<label><input type="checkbox" checked={p.showAxes !== false} disabled={disabled} onChange={e => update({ showAxes: e.target.checked })}/>Axes</label></div>
    <p className="inspector-hint">{spec.type === 'phase' ? 'dx/dt is the expression above. Lines show sampled ODE trajectories from several starting points, forward and backward in time.' : spec.type === 'surface' ? 'The expression gives z from x and y. All three dimensions use the same scale.' : 'The expression is radius as a function of the axial coordinate x. This draws the swept surface.'}</p>
  </details>
}
