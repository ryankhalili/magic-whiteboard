import { BOARD_INSTRUCTIONS, boardTools, type SnapshotContext } from './board-tools'

// rules only: the client's first context item carries the board and replaces itself as the board changes
export function realtimeConfig(_context?: SnapshotContext, spokenReplies = true, model = 'gpt-realtime-mini') {
  return {
    type: 'realtime', model, instructions: BOARD_INSTRUCTIONS,
    output_modalities: spokenReplies ? ['audio'] : ['text'],
    max_output_tokens: 1400, tools: boardTools, tool_choice: 'auto',
    // Bound conversation history separately from the full instructions/tools.
    // The client replaces board snapshots; retain room for that snapshot and audio.
    truncation: { type: 'retention_ratio', retention_ratio: 0.8, token_limits: { post_instructions: 12000 } },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'en',
          prompt: 'Transcribe the spoken English faithfully, including questions and mathematical terms. Do not translate into another language, answer the speaker, or invent words from silence or background noise. Preserve any clearly spoken foreign-language quotation as spoken.' },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 380, create_response: false, interrupt_response: true },
      },
      output: { voice: 'coral' },
    },
  }
}
