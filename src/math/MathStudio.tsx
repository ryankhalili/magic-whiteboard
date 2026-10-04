import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { X } from 'lucide-react'
import type { BoardOperation, BoardResult } from '../../shared/board'
import { DEFAULT_MAGIC_PROPS, type MagicShape } from '../board/MagicShape'
import { PlotGraphic } from '../board/PlotGraphic'
import { autoYRange, validateExpression } from '../board/expression'
import { validateLatex } from '../board/latex'
import { validateScientific } from './scientific'
import './math-studio.css'

type Mode = 'equation' | 'plot' | 'surface' | 'revolution' | 'phase'
const presets: Record<Mode, { expression: string; secondary?: string; min: number; max: number }> = {
  equation: { expression: '\\int_0^\\pi \\sin(x)\\,dx', min: -5, max: 5 },
  plot: { expression: 'x^2', min: -5, max: 5 },
  surface: { expression: 'sin(sqrt(x^2+y^2))', min: -6, max: 6 },
  revolution: { expression: 'sqrt(x)', min: 0, max: 4 },
  phase: { expression: 'y', secondary: '-x', min: -3, max: 3 },
}
export function MathStudio({ onInsert, onClose }: { onInsert: (op: BoardOperation) => BoardResult; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null)
  const close = useEffectEvent(onClose)
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return }
      if (event.key !== 'Tab') return
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]') ?? [])]
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('keydown', keys, true); prior?.focus() }
  }, [])
  const [mode, setMode] = useState<Mode>('equation'), [source, setSource] = useState(presets.equation.expression)
  const [secondary, setSecondary] = useState('-x'), [min, setMin] = useState('-5'), [max, setMax] = useState('5'), [error, setError] = useState('')
  const choose = (next: Mode) => { const p = presets[next]; setMode(next); setSource(p.expression); setMin(String(p.min)); setMax(String(p.max)); setSecondary(p.secondary ?? '-x'); setError('') }
  const preview = useMemo(() => {
    try {
      if (mode === 'equation') return { operation: { type: 'create_math', latex: validateLatex(source) } as BoardOperation, html: katex.renderToString(source, { displayMode: true, throwOnError: true, trust: false, maxExpand: 300, maxSize: 20 }) }
      const xMin = Number(min), xMax = Number(max)
      if (!min.trim() || !max.trim() || !Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin || xMax - xMin > 1e7) throw new Error('Choose a finite minimum below the maximum.')
      const visualization = mode === 'plot' ? undefined : { type: mode, ...(mode === 'phase' ? { secondaryExpression: secondary } : {}) }
      const expression = visualization ? validateScientific(source, visualization).expression : validateExpression(source).expression
      const [yMin, yMax] = mode === 'plot' ? autoYRange(expression, xMin, xMax) : [mode === 'revolution' ? -5 : xMin, mode === 'revolution' ? 5 : xMax]
      const operation: BoardOperation = { type: 'create_plot', expression, visualization, xMin, xMax, yMin, yMax }
      const shape = { id: 'shape:studio-preview', type: 'magic', props: { ...DEFAULT_MAGIC_PROPS, ...(visualization ? { fontSize: 16, strokeWidth: mode === 'phase' ? 1.8 : .6 } : {}), w: 480, h: 320, expression, visualization, xMin, xMax, yMin, yMax }, meta: {} } as MagicShape
      return { operation, shape }
    } catch (e) { return { error: e instanceof Error ? e.message : 'Finish the expression to see a preview.' } }
  }, [mode, source, secondary, min, max])
  return <div className="studio-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}><section ref={dialog} role="dialog" aria-modal="true" aria-label="Insert math" className="math-studio" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}>
    <header><div><strong>Insert math</strong><p>Type an expression. The preview updates locally.</p></div><button aria-label="Close math editor" onClick={onClose}><X size={18}/></button></header>
    <nav aria-label="Math tool">{(['equation', 'plot', 'surface', 'revolution', 'phase'] as Mode[]).map(value => <button key={value} aria-pressed={mode === value} onClick={() => choose(value)}>{{ equation: 'Equation', plot: '2D graph', surface: '3D surface', revolution: 'Revolution', phase: 'Phase portrait' }[value]}</button>)}</nav>
    <label>{mode === 'equation' ? 'LaTeX expression' : mode === 'phase' ? 'dx/dt' : mode === 'surface' ? 'z = f(x,y)' : mode === 'revolution' ? 'Radius f(x)' : 'Function or equation'}<textarea autoFocus aria-label="Math expression" rows={2} value={source} onChange={e => setSource(e.target.value)} spellCheck={false}/></label>
    {mode === 'equation' && <div className="math-symbols">{[['Integral', '\\int_{}^{} '], ['Fraction', '\\frac{}{}'], ['Square root', '\\sqrt{}'], ['Sum', '\\sum_{}^{} '], ['Pi', '\\pi']].map(([label, token]) => <button key={label} onClick={() => setSource(s => s + token)}>{label}</button>)}</div>}
    {mode === 'phase' && <label>dy/dt<input aria-label="Second equation" value={secondary} onChange={e => setSecondary(e.target.value)}/></label>}
    {mode !== 'equation' && <div className="studio-range"><label>Domain minimum<input aria-label="Domain minimum" type="number" value={min} onChange={e => setMin(e.target.value)}/></label><label>Domain maximum<input aria-label="Domain maximum" type="number" value={max} onChange={e => setMax(e.target.value)}/></label></div>}
    <div className="studio-preview" aria-label="Math preview">{preview.html ? <div dangerouslySetInnerHTML={{ __html: preview.html }}/> : preview.shape ? <svg viewBox="0 0 480 320"><PlotGraphic shape={preview.shape}/></svg> : <p role="status">{preview.error}</p>}</div>
    {mode === 'phase' && <p className="studio-note">Autonomous ODE system in x and y. Numerical trajectories are approximations, not a PDE solution.</p>}
    {error && <p role="alert">{error}</p>}
    <footer><button onClick={onClose}>Cancel</button><button className="studio-insert" disabled={!preview.operation} onClick={() => { if (!preview.operation) return; const result = onInsert(preview.operation); if (result.ok) onClose(); else setError(result.message) }}>Add to board</button></footer>
  </section></div>
}
