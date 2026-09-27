export const DEFAULT_TEXT_MODEL = 'gpt-6-luna'

/** Keep ordinary edits responsive while leaving room for math and a complete tool payload. */
export function textModelSettings(model = DEFAULT_TEXT_MODEL) {
  return model === 'gpt-6-luna'
    ? { model, reasoning: { effort: 'low' as const }, max_output_tokens: 4096 }
    : { model, max_output_tokens: 1500 }
}
