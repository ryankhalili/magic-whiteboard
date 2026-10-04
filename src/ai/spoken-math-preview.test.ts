import { describe, expect, it } from 'vitest'
import katex from 'katex'
import type { BoardContext } from '../../shared/board'
import { generateMathTranscriptPreview } from './spoken-math-preview'

const context: BoardContext = { focus: null, pointer: null, selectedIds: [], lastCreatedIds: [], viewport: { x: 0, y: 0, w: 1000, h: 800 }, objects: [], dictationMode: 'math' }
const object = { id: 'equation', kind: 'math', latex: 'x^{2}+2', bounds: { x: 50, y: 60, w: 300, h: 100 }, rotation: 0 }
const editing: BoardContext = { ...context, selectedIds: [object.id], lastCreatedIds: [object.id], objects: [object] }
const preview = (transcript: string, ctx = context) => generateMathTranscriptPreview('audio_1', transcript, ctx)

describe('spoken mathematical draft rendering', () => {
  it.each([
    ['the integral of', String.raw`\int`],
    ['integral from two to five of sin x d x', String.raw`\int_{2}^{5} \sin x\,\mathrm{d}x`],
    ['the integral of sine of x from 2 to 5 dx', String.raw`\int_{2}^{5} \sin x\,\mathrm{d}x`],
    ['integral from negative infinity to infinity of x squared d x', String.raw`\int_{-\infty}^{\infty} {x}^{2}\,\mathrm{d}x`],
    ['y equals x squared plus three', String.raw`y = {x}^{2} + 3`],
    ['x cubed minus three times x plus two', String.raw`{x}^{3} - 3 \cdot x + 2`],
    ['x to the power of two', String.raw`{x}^{2}`],
    ['x raised to the third', String.raw`{x}^{3}`],
    ['one over two', String.raw`\frac{1}{2}`],
    ['fraction of x over y', String.raw`\frac{x}{y}`],
    ['open parenthesis x plus one close parenthesis divided by two', String.raw`\frac{\left(x + 1\right)}{2}`],
    ['square root of x', String.raw`\sqrt{x}`],
    ['natural log of x', String.raw`\ln x`],
    ['absolute value of x', String.raw`\left|x\right|`],
    ['alpha plus beta equals gamma', String.raw`\alpha + \beta = \gamma`],
    ['two pi r', String.raw`2 \pi r`],
    ['twenty five plus two point five', '25 + 2.5'],
    ['x less than or equal to five', String.raw`x \le 5`],
    ['cosine of theta', String.raw`\cos \theta`],
    ['sinh x', String.raw`\sinh x`],
    ['cosh x', String.raw`\cosh x`],
    ['tanh x', String.raw`\tanh x`],
    ['hyperbolic sine of x', String.raw`\sinh x`],
    ['hyperbolic cosine of x', String.raw`\cosh x`],
    ['hyperbolic tangent of x', String.raw`\tanh x`],
    ['sine of open parenthesis pi over two close parenthesis', String.raw`\sin \left(\frac{\pi}{2}\right)`],
    ['plus three', '+3'],
    ['equals zero', '= 0'],
    ['this now equals negative cosine of x bar from pi to 2pi', String.raw`= \left.-\cos x\right|_{\pi}^{2 \pi}`],
    ['This now equals negative cosine of x, bar from pi to 2 pi.', String.raw`= \left.-\cos x\right|_{\pi}^{2 \pi}`],
    ['integral of sine x, from two to five, dx', String.raw`\int_{2}^{5} \sin x\,\mathrm{d}x`],
    ['it is equal to negative cosine of x bar from pi to two pi', String.raw`= \left.-\cos x\right|_{\pi}^{2 \pi}`],
    ['now equals negative cosine of x bar from pi to two pi', String.raw`= \left.-\cos x\right|_{\pi}^{2 \pi}`],
    ['y equals negative cosine of x bar from zero to pi', String.raw`y = \left.-\cos x\right|_{0}^{\pi}`],
    ['x squared plus one bar from negative pi to two pi', String.raw`\left.{x}^{2} + 1\right|_{-\pi}^{2 \pi}`],
    ['negative cosine of x bar from pi over two to pi', String.raw`\left.-\cos x\right|_{\frac{\pi}{2}}^{\pi}`],
    ['one half plus one quarter', String.raw`\left(\frac{1}{2}\right) + \left(\frac{1}{4}\right)`],
    ['y = x^2 + 3.', String.raw`y = {x}^{2} + 3`],
  ])('renders %s as a valid uncommitted draft', (transcript, latex) => {
    const result = preview(transcript)
    expect(result).toMatchObject({ callId: 'transcript:audio_1', field: 'latex', kind: 'math', complete: false, operationType: 'create_math', value: latex })
    expect(() => katex.renderToString(result!.value, { throwOnError: true })).not.toThrow()
  })

  it.each([
    ['integral', String.raw`\int`],
    ['integral from', String.raw`\int_{\square}^{\square}`],
    ['integral from two', String.raw`\int_{2}^{\square}`],
    ['integral from two to', String.raw`\int_{2}^{\square}`],
    ['integral from two to five of', String.raw`\int_{2}^{5}`],
    ['integral from two to five of sin', String.raw`\int_{2}^{5} \sin \square`],
    ['integral from two to five of cosh', String.raw`\int_{2}^{5} \cosh \square`],
    ['integral from two to five of cosh x', String.raw`\int_{2}^{5} \cosh x`],
    ['integral from two to five of sin x d', String.raw`\int_{2}^{5} \sin x\,\mathrm{d}\square`],
    ['x plus', String.raw`x + \square`],
    ['x to the power of', String.raw`{x}^{\square}`],
    ['fraction one over', String.raw`\frac{1}{\square}`],
    ['square root', String.raw`\sqrt{\square}`],
    ['open parenthesis x plus', String.raw`\left(x + \square\right)`],
    ['this now equals', String.raw`= \square`],
    ['this now equals negative cosine of x bar', String.raw`= \left.-\cos x\right|`],
    ['this now equals negative cosine of x bar from', String.raw`= \left.-\cos x\right|_{\square}^{\square}`],
    ['this now equals negative cosine of x bar from pi', String.raw`= \left.-\cos x\right|_{\pi}^{\square}`],
    ['this now equals negative cosine of x bar from pi to', String.raw`= \left.-\cos x\right|_{\pi}^{\square}`],
    ['this now equals negative cosine of x bar from pi to two', String.raw`= \left.-\cos x\right|_{\pi}^{2}`],
  ])('keeps the incremental phrase %s renderable', (transcript, latex) => {
    expect(preview(transcript)?.value).toBe(latex)
    expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow()
  })

  it.each(['delete x', 'move the integral', 'solve x equals two', 'plot y equals x', 'undo', 'rotate x', 'actually replace two with three',
    'make it plus three instead', 'integrate x', 'what is sine x', 'x plus some number', 'x over there', 'one two',
    'integral from two five of x', 'x plus times two', 'x )', 'sine of pi over two', 'square root of x over y',
    'this now equals what', 'move this now equals two', 'bar from pi to two pi', 'x bar pi to two pi', '2,5', 'x, y',
    'x bar from pi to two pi plus one', 'x bar from pi delete x', String.raw`\href{https://example.com}{x}`, 'x; alert(1)', '', 'the'])('rejects unsupported or command speech: %s', transcript => {
    expect(preview(transcript)).toBeNull()
  })

  it('limits input length, token count, nested groups, and item identity', () => {
    expect(preview('x'.repeat(1501))).toBeNull()
    expect(preview('x + '.repeat(100))).toBeNull()
    expect(preview('('.repeat(21) + 'x')).toBeNull()
    expect(generateMathTranscriptPreview('', 'x', context)).toBeNull()
    expect(generateMathTranscriptPreview('a'.repeat(201), 'x', context)).toBeNull()
  })

  it('does not guess equations from ordinary assistant or text dictation', () => {
    expect(preview('x', { ...context, dictationMode: 'assistant' })).toBeNull()
    expect(preview('two', { ...context, dictationMode: 'assistant' })).toBeNull()
    expect(preview('integral of x', { ...context, dictationMode: 'assistant' })?.operationType).toBe('create_math')
    expect(preview('x squared', { ...context, dictationMode: 'text' })).toBeNull()
  })
})

describe('safe ephemeral dictation targets', () => {
  it('appends the spoken evaluation step to the original integral without solving or changing source', () => {
    const source = String.raw`\int_{\pi}^{2\pi}\sin(x)\,dx`
    const integral: BoardContext = { ...editing, objects: [{ ...object, latex: source }] }
    const before = JSON.stringify(integral)
    const result = preview('this now equals negative cosine of x bar from pi to 2pi', integral)
    expect(result).toMatchObject({ target: object.id, kind: 'edit', operationType: 'edit_content', complete: false,
      value: source + String.raw`= \left.-\cos x\right|_{\pi}^{2 \pi}` })
    expect(() => katex.renderToString(result!.value, { throwOnError: true })).not.toThrow()
    expect(JSON.stringify(integral)).toBe(before)
    expect(preview('this now equals negative cosine of x bar from pi to', integral)?.value).toBe(source + String.raw`= \left.-\cos x\right|_{\pi}^{\square}`)
  })

  it('appends to a single equation without changing source or context', () => {
    const original = JSON.stringify(editing)
    expect(preview('plus three', editing)).toMatchObject({ operationType: 'edit_content', kind: 'edit', target: object.id, value: 'x^{2}+2+3', bounds: object.bounds, complete: false })
    expect(JSON.stringify(editing)).toBe(original)
    expect(preview('plus four', editing)?.value).toBe('x^{2}+2+4') // Each interim revision uses the original source.
  })

  it('preserves LaTeX command boundaries when appending', () => {
    expect(preview('x', { ...editing, objects: [{ ...object, latex: String.raw`\sin` }] })?.value).toBe(String.raw`\sin x`)
  })

  it('continues a previously dictated integral without accepting unrelated of/dx phrases', () => {
    const integral: BoardContext = { ...editing, objects: [{ ...object, latex: String.raw`\int_2^5` }] }
    expect(preview('of sine x d x', integral)?.value).toBe(String.raw`\int_2^5\sin x\,\mathrm{d}x`)
    expect(preview('of sin(x) dx', integral)?.value).toBe(String.raw`\int_2^5\sin \left(x\right)\,\mathrm{d}x`)
    expect(preview('dx', { ...integral, objects: [{ ...object, latex: String.raw`\int_2^5 \sin x` }] })?.value).toBe(String.raw`\int_2^5 \sin x\,\mathrm{d}x`)
    expect(preview('of sine x d x', editing)).toBeNull()
    expect(preview('dx', context)).toBeNull()
    expect(preview('dx', { ...integral, objects: [{ ...object, latex: String.raw`\int_2^5 \sin x\,\mathrm{d}x` }] })).toBeNull()
  })

  it('replaces a verified source range and preserves surrounding source', () => {
    const selected: BoardContext = { ...editing, contentSelection: { shapeId: object.id, field: 'latex', coordinateSpace: 'text', start: 6, end: 7, text: '2' } }
    expect(preview('three', selected)?.value).toBe('x^{2}+3')
    expect(preview('three', { ...selected, contentSelection: { ...selected.contentSelection!, text: '5' } })).toBeNull()
    expect(preview('three', { ...selected, contentSelection: { ...selected.contentSelection!, start: -1, end: 0 } })).toBeNull()
  })

  it('does not interpret MathLive visual offsets as LaTeX source offsets', () => {
    const selected: BoardContext = { ...editing, contentSelection: { shapeId: object.id, field: 'latex', coordinateSpace: 'mathlive', start: 1, end: 2, text: 'x' } }
    expect(preview('y', selected)?.value).toBe('y^{2}+2')
    expect(preview('three', { ...selected, contentSelection: { ...selected.contentSelection!, text: '2' } })).toBeNull() // Two occurrences.
    expect(preview('three', { ...selected, contentSelection: { ...selected.contentSelection!, text: '' } })).toBeNull()
  })

  it('uses the canonical selected shape instead of a stale object alias', () => {
    const selected: BoardContext = { ...editing, objects: [object, { ...object, id: 'other', latex: 'z' }], contentSelection: { shapeId: object.id, objectId: 'other', field: 'latex', text: 'x' } }
    expect(preview('y', selected)).toMatchObject({ target: object.id, value: 'y^{2}+2' })
  })

  it('supports a source caret but rejects a replacement that breaks LaTeX', () => {
    expect(preview('plus three', { ...editing, contentSelection: { shapeId: object.id, field: 'latex', coordinateSpace: 'text', start: 7, end: 7, text: '' } })?.value).toBe('x^{2}+2+3')
    expect(preview('three', { ...editing, contentSelection: { shapeId: object.id, field: 'latex', coordinateSpace: 'text', start: 2, end: 3, text: '{' } })).toBeNull()
  })

  it('uses an empty focus for a fresh draft despite old selection and source selection', () => {
    const result = preview('x squared', { ...editing, contentSelection: { shapeId: object.id, field: 'latex', text: 'x' }, focus: { kind: 'region', targetIds: [], bounds: { x: 500, y: 500, w: 200, h: 150 } } })
    expect(result).toMatchObject({ operationType: 'create_math', value: '{x}^{2}' })
    expect(result?.target).toBeUndefined()
  })

  it('uses focus and last-created only when unambiguous', () => {
    const next = { ...object, id: 'next', latex: 'y' }
    expect(preview('plus one', { ...editing, objects: [object, next], focus: { kind: 'point', targetIds: ['next'], bounds: { x: 0, y: 0, w: 0, h: 0 } } })?.target).toBe('next')
    expect(preview('plus one', { ...editing, selectedIds: [] })?.target).toBe(object.id)
    expect(preview('plus one', { ...editing, selectedIds: ['equation', 'other'] })).toBeNull()
    expect(preview('plus one', { ...editing, selectedIds: ['missing'] })).toBeNull()
    expect(preview('plus one', { ...editing, objects: [{ ...object, locked: true }] })).toBeNull()
  })

  it('creates for an incompatible selected object but never replaces an incompatible source selection', () => {
    const textContext: BoardContext = { ...editing, objects: [{ ...object, kind: 'text', text: 'Hello', latex: undefined }] }
    expect(preview('x squared', textContext)?.operationType).toBe('create_math')
    expect(preview('x squared', { ...textContext, contentSelection: { shapeId: object.id, field: 'text', text: 'Hello' } })).toBeNull()
  })

  it('copies valid literal bounds and rejects invalid or undersized regions', () => {
    const bounds = { x: 300, y: 400, w: 240, h: 120 }
    const literal: BoardContext = { ...context, focusMode: 'literal', focus: { kind: 'region', targetIds: [], bounds } }
    expect(preview('x squared', literal)?.bounds).toEqual(bounds)
    expect(preview('x squared', literal)?.bounds).not.toBe(bounds)
    for (const bad of [{ ...bounds, x: Infinity }, { ...bounds, w: 0 }, { ...bounds, w: 79 }, { ...bounds, h: 47 }, { ...bounds, h: 10001 }]) {
      expect(preview('x squared', { ...literal, focus: { ...literal.focus!, bounds: bad } })).toBeNull()
    }
    expect(preview('x squared', { ...context, focusMode: 'literal' })).toBeNull()
  })

  it('requires both literal target inclusion and full page-bounds containment for edits', () => {
    const literal: BoardContext = { ...editing, focusMode: 'literal', focus: { kind: 'region', targetIds: [object.id], bounds: { x: 0, y: 0, w: 400, h: 300 } } }
    expect(preview('plus three', literal)?.target).toBe(object.id)
    expect(preview('plus three', { ...literal, focus: { ...literal.focus!, bounds: { x: 100, y: 0, w: 400, h: 300 } } })).toBeNull()
    expect(preview('plus three', { ...editing, focusMode: 'literal' })).toBeNull()
    const staleSelection: BoardContext = { ...literal, contentSelection: { shapeId: object.id, field: 'latex', text: 'x' }, focus: { ...literal.focus!, targetIds: ['elsewhere'] } }
    expect(preview('y', staleSelection)).toBeNull()
    expect(preview('plus three', { ...literal, objects: [{ ...object, rotation: Math.PI / 4, bounds: { x: -20, y: -20, w: 340, h: 340 } }] })).toBeNull()
  })
})
