import { describe, expect, it } from 'vitest'
import type { Response } from 'openai/resources/responses/responses'
import { readBoardCommand } from '../server/command-response'
import { textModelSettings } from '../server/model-config'

const complete: Pick<Response,'status'|'incomplete_details'|'output'> = {
  status:'completed',incomplete_details:null,
  output:[{type:'function_call',name:'apply_board_operations',call_id:'call_test',arguments:JSON.stringify({message:'Done.',operations:[{type:'update_object',target:'shape:math',latex:'\\int \\cosh(x)\\,dx = \\sinh(x)+C'}]})}],
}
describe('typed command response completion',()=>{
  it('accepts a complete tool payload for an existing equation',()=>{
    expect(readBoardCommand(complete).operations[0]).toMatchObject({target:'shape:math',latex:'\\int \\cosh(x)\\,dx = \\sinh(x)+C'})
  })
  it('never accepts parseable partial output from an exhausted response',()=>{
    expect(()=>readBoardCommand({...complete,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})).toThrow(/length limit/)
  })
  it('reports malformed or missing tool output without leaking unvalidated output',()=>{
    expect(()=>readBoardCommand({...complete,output:[{...complete.output[0],arguments:'{"operations":['} as Response['output'][number]]})).toThrow(/incomplete edit/)
    expect(()=>readBoardCommand({...complete,output:[]})).toThrow(/complete board edit/)
    expect(()=>readBoardCommand({...complete,status:'failed'})).toThrow(/has not been changed/)
  })
  it('gives Luna a bounded reasoning budget while preserving legacy override compatibility',()=>{
    const luna=textModelSettings()
    expect(luna.model).toBe('gpt-6-luna')
    expect(luna.reasoning?.effort).toBe('low')
    expect(luna.max_output_tokens).toBeGreaterThan(1500)
    expect(textModelSettings('gpt-4.1-mini')).not.toHaveProperty('reasoning')
  })
})
