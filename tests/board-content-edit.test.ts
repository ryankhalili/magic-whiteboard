import { describe, expect, it } from 'vitest'
import { applyContentEdit } from '../src/board/contentEdit'

describe('character-level source editing', () => {
  it('appends dictation without overwriting existing content', () => {
    expect(applyContentEdit('The answer is ', { replacement: 'forty-two.' })).toBe('The answer is forty-two.')
  })
  it('replaces only an explicitly selected UTF-16 source range', () => {
    expect(applyContentEdit('A 🌱 grows', { start: 2, end: 4, replacement: 'tree' })).toBe('A tree grows')
    expect(applyContentEdit('x + 2 + 2', { start: 4, end: 5, replacement: '3' })).toBe('x + 3 + 2')
  })
  it('does literal matching, with no regex interpretation', () => {
    expect(applyContentEdit('x^2 + 2', { find: 'x^2', replace: 'sin(x)' })).toBe('sin(x) + 2')
  })
  it('rejects ambiguous, stale, or out-of-bounds selection without altering the source', () => {
    expect(() => applyContentEdit('x + x', { find: 'x', replace: 'y' })).toThrow(/more than once/)
    expect(() => applyContentEdit('x + 2', { find: '3', replace: '4' })).toThrow(/not found/)
    expect(() => applyContentEdit('hello', { start: 1, end: 50, replacement: '' })).toThrow(/range/)
    expect(() => applyContentEdit('hello', { start: 1, replacement: '' })).toThrow(/range/)
  })
})
