import { BOARD_INSTRUCTIONS, boardTools, type SnapshotContext } from './board-tools'

// rules only: the client's first context item carries the board and replaces itself as the board changes
export function realtimeConfig(_context?: SnapshotContext, spokenReplies = true, model = 'gpt-realtime-mini') {
  return {
    type: 'realtime', model, instructions: BOARD_INSTRUCTIONS,
    output_modalities: spokenReplies ? ['audio'] : ['text'],
    max_output_tokens: 1400, tools: boardTools, tool_choice: 'auto',
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 380, create_response: false, interrupt_response: true },
      },
      output: { voice: 'coral' },
    },
  }
}
