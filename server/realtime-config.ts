import type { BoardContext } from '../shared/board'
import { BOARD_INSTRUCTIONS, boardTools } from './board-tools'

export function realtimeConfig(_context: BoardContext, spokenReplies = true, model = 'gpt-realtime-mini') {
  return {
    // The client sends fresh state after the data channel opens and before each
    // response. A connection-time snapshot here would remain stale in the
    // session instructions even after the user switches dictation mode.
    type: 'realtime', model, instructions: `${BOARD_INSTRUCTIONS}\n\nVOICE STATE: Read current board state from the newest Updated whiteboard state message sent by the client, or a subsequently requested get_board_context result. Session setup deliberately contains no initial board snapshot. Until the client supplies current state, no current mode, selection, source or placement is available; do not infer those values or edit the board. Never reuse a connection-time mode or an older tool result over a newer state message.`,
    output_modalities: spokenReplies ? ['audio'] : ['text'],
    max_output_tokens: 1400, tools: boardTools, tool_choice: 'auto',
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
