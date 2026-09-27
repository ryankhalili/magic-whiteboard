import { describe, expect, it } from 'vitest'
import { contextFingerprint, isFatalVoiceError, isTransientVoiceError, pinRecoveredCommand, VoiceApiError } from '../src/ai/voice-recovery'
import type { BoardContext } from '../shared/board'

const context: BoardContext = { focus: null, pointer: { x: 10, y: 20 }, selectedIds: ['a'], lastCreatedIds: ['b'], objects: [{ id: 'a', kind: 'math', latex: 'x', rotation: 0, bounds: { x: 0, y: 0, w: 100, h: 100 } }], viewport: { x: 0, y: 0, w: 1000, h: 700 } }

describe('generic recovery boundary', () => {
  it('pins the original selection and rejects unrelated/destructive follow-up edits', () => {
    expect(pinRecoveredCommand({ operations: [{ type: 'update_object', target: 'selected', latex: 'x=0' }], message: '' }, context)).toEqual([{ type: 'update_object', target: 'a', latex: 'x=0' }])
    expect(() => pinRecoveredCommand({ operations: [{ type: 'update_object', target: 'b', latex: 'x=0' }], message: '' }, context)).toThrow('different object')
    expect(() => pinRecoveredCommand({ operations: [{ type: 'delete_objects', target: 'a' }], message: '' }, context)).toThrow('destructive')
    expect(() => pinRecoveredCommand({ operations: [{ type: 'transform_object', target: 'a', followPointer: true }], message: '' }, context)).toThrow('pointer-follow')
  })
  it('detects source, selection and placement changes without depending on object key order', () => {
    expect(contextFingerprint({ ...context, pointer: { y: 20, x: 10 } })).toBe(contextFingerprint(context))
    expect(contextFingerprint({ ...context, selectedIds: ['b'] })).not.toBe(contextFingerprint(context))
    expect(contextFingerprint({ ...context, objects: [{ ...context.objects[0], latex: 'x^2' }] })).not.toBe(contextFingerprint(context))
    expect(contextFingerprint({ ...context, pointer: { x: 11, y: 20 } })).not.toBe(contextFingerprint(context))
  })
  it('distinguishes temporary service failures from credit, auth and policy limits', () => {
    expect(isTransientVoiceError(new VoiceApiError('Temporary server outage', 503, true))).toBe(true)
    expect(isTransientVoiceError(new TypeError('Failed to fetch'))).toBe(true)
    for (const error of [new VoiceApiError('Invalid key', 401), new VoiceApiError('Rate allowance reached', 429, false), new Error('insufficient_quota'), new Error('The project credit limit was reached')]) {
      expect(isFatalVoiceError(error)).toBe(true)
      expect(isTransientVoiceError(error)).toBe(false)
    }
  })
})
