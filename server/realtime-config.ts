import type { BoardContext } from '../shared/board'
import { boardTools, contextInstructions } from './board-tools'

export function realtimeConfig(context: BoardContext, spokenReplies = true, model = 'gpt-realtime-mini') {
  return {
    type: 'realtime', model, instructions: contextInstructions(context),
    output_modalities: spokenReplies ? ['audio'] : ['text'],
    max_output_tokens: 1400, tools: boardTools, tool_choice: 'auto',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 380, create_response: false, interrupt_response: true },
      },
      output: { voice: 'coral' },
    },
  }
}
