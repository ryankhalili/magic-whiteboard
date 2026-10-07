import { describe, expect, it } from 'vitest'
import { excerptRepairOperation } from '../src/library/excerptRepair'
import { localHistoryCommand } from '../shared/history'
import { constrainRepairCommand } from '../server/command-repair'
import { pinRecoveredCommand } from '../src/ai/voice-recovery'
import type { BoardContext } from '../shared/board'
const context: BoardContext = { selectedIds: ['excerpt'], lastCreatedIds: [], focus: null, pointer: null, viewport: { x: 0, y: 0, w: 1000, h: 700 }, objects: [{ id: 'excerpt', kind: 'textbook_item', bounds: { x: 0, y: 0, w: 500, h: 500 }, rotation: 0 }] }
describe('source repair and explicit history requests', () => {
  it('repairs a clipped selected PDF excerpt without stretching or selecting a different object', () => {
    expect(excerptRepairOperation('The top part was cropped out. Can you fix that?', context)).toEqual([{ type: 'library_action', action: 'repair_excerpt', target: 'excerpt' }])
    expect(excerptRepairOperation("Don't fix the cropped out top yet", context)).toBeNull()
    expect(excerptRepairOperation('The top was cut off, fix it', { ...context, selectedIds: ['other'] })).toBeNull()
    expect(excerptRepairOperation('Make it taller', context)).toBeNull()
  })
  it('permits only a single explicitly requested history action through both repair boundaries', () => {
    const instruction = 'No, wait, can you undo that?'
    const command = { operations: [{ type: 'undo' as const }], message: '' }
    expect(localHistoryCommand(instruction)).toBe('undo')
    expect(constrainRepairCommand(command, { instruction, context, failure: { kind: 'malformed_arguments', message: 'bad tool' } })).toEqual(command)
    expect(pinRecoveredCommand(command, context, instruction)).toEqual(command.operations)
    expect(() => pinRecoveredCommand(command, context, 'Do not undo that')).toThrow()
    expect(() => constrainRepairCommand(command, { instruction: 'Make a graph', context, failure: { kind: 'malformed_arguments', message: 'bad tool' } })).toThrow()
    expect(localHistoryCommand('undo that and erase everything')).toBeNull()
  })
})
