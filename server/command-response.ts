import type { Response } from 'openai/resources/responses/responses'
import { commandSchema } from './board-tools'

/** Never apply a truncated function payload, even when its JSON happens to parse. */
export function readBoardCommand(response: Pick<Response, 'status' | 'incomplete_details' | 'output'>) {
  if (response.status === 'incomplete') {
    throw new Error(response.incomplete_details?.reason === 'max_output_tokens'
      ? 'The answer reached its length limit before finishing. Try extending one part of the equation at a time.'
      : 'The assistant stopped before completing the edit. Your board has not been changed.')
  }
  if (response.status !== 'completed') throw new Error('The assistant did not finish this edit. Your board has not been changed; try again.')
  const call = response.output.find(item => item.type === 'function_call' && item.name === 'apply_board_operations')
  if (!call || call.type !== 'function_call') throw new Error('The assistant did not produce a complete board edit. Try rephrasing.')
  let argumentsValue: unknown
  try { argumentsValue = JSON.parse(call.arguments) }
  catch { throw new Error('The assistant returned an incomplete edit. Your board has not been changed; try a shorter instruction.') }
  const command = commandSchema.safeParse(argumentsValue)
  if (!command.success) throw new Error('The assistant returned an invalid board edit. Try a shorter instruction.')
  return command.data
}
