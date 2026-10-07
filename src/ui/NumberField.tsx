import { useEffect, useRef, useState } from 'react'

export function NumberField({ label, value, min, max, step = 'any', onCommit, disabled = false }: { label: string; value: number; min?: number; max?: number; step?: number | 'any'; onCommit: (value: number) => unknown; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))))
  const focused = useRef(false), dirty = useRef(false)
  useEffect(() => { if (!focused.current) { setDraft(String(Number(value.toFixed(3)))); dirty.current = false } }, [value])
  const commit = () => {
    if (!dirty.current) return
    const number = Number(draft)
    if (draft.trim() && Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max)) {
      const result = onCommit(number)
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) setDraft(String(Number(value.toFixed(3))))
    }
    else setDraft(String(Number(value.toFixed(3))))
    dirty.current = false
  }
  return <label>{label}<input aria-label={label} type="number" value={draft} min={min} max={max} step={step} disabled={disabled} onFocus={() => { focused.current = true }} onChange={event => { dirty.current = true; setDraft(event.target.value) }} onBlur={() => { focused.current = false; commit() }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur() } }}/></label>
}
