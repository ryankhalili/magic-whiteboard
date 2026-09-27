const INKS = [
  ['Black', '#202124'], ['Slate', '#64748b'], ['Maroon', '#8d3444'], ['Red', '#dc2626'],
  ['Orange', '#ea580c'], ['Ochre', '#c18e32'], ['Green', '#15803d'], ['Teal', '#218b8b'],
  ['Blue', '#2563eb'], ['Navy', '#283b74'], ['Violet', '#7c3aed'], ['Plum', '#963c86'],
  ['White', '#ffffff'], ['Silver', '#c4cbd1'], ['Rose', '#e4a0af'], ['Coral', '#f28e85'],
  ['Peach', '#f2b98e'], ['Yellow', '#efcf67'], ['Mint', '#a5c7ac'], ['Aqua', '#a6d5d4'],
  ['Sky', '#8eb8d8'], ['Periwinkle', '#999bd1'], ['Lavender', '#c2a4d7'], ['Pink', '#d9a2c4'],
] as const

export function InkPalette({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const label = INKS.find(([, value]) => value === color)?.[0] ?? 'Custom'
  return <section className="ink-palette" aria-label="Ink colors">
    <div className="current-ink" aria-hidden="true"><span/><span style={{ background: color }}/></div>
    <div className="palette-swatches">{INKS.map(([name, value]) =>
      <button key={value} type="button" aria-label={`Ink color ${name.toLowerCase()}`} aria-pressed={color === value} title={name}
        className={color === value ? 'chosen' : ''} style={{ '--ink': value } as React.CSSProperties} onClick={() => onChange(value)}/>
    )}</div>
    <div className="palette-caption"><strong>{label}</strong><span>Make your mark.</span></div>
    <span className="palette-hint">A pencil, a little curiosity, and room to play.</span>
  </section>
}
