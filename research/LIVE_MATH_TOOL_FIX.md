# Integral tool recovery and live math drafts

September 27, 2026.

The reported `Unknown whiteboard tool` message came from a dispatch branch that bypassed semantic repair. The exact unsupported name from that user's turn was not retained. The new handler uses exact same-call function metadata, supports completed output-item events, rejects conflicting or invented names, and attempts one correction from the original instruction. It never guesses an alias or replays a successful edit. The prompt now explicitly distinguishes callable functions from operation types such as `create_math`.

In **Dictate math**, incoming transcription chunks now produce an ephemeral, validated LaTeX draft for a bounded common vocabulary. Model output supersedes that draft; only final validated operations change the document. Guards clear obsolete drafts after changes to source, selection, placement, mode, session, or repair state. Open MathLive/source editors show a separate read-only draft; speculative content never becomes the editable field value.

The input transcription service can wait for a short pause before emitting chunks. This feature does not promise word-by-word compilation during uninterrupted speech, and ambiguous spoken mathematics waits for the model.

## Verification

- Full suite: 566 tests pass across 40 files.
- Tests cover missing/conflicting/unsupported function names, duplicate event delivery, original-transcript arrival, cancellation, stale selections, and no replay after partial success.
- Preview tests cover incremental integrals, continuations, safe source selections, Literal constraints, ambiguous/control input, KaTeX validity, model precedence, and out-of-order events.
- Two small real Realtime requests using text input produced `apply_board_operations` and valid `\\int_2^5 \\sin(x)\\,dx` in Assistant and Dictate math modes. No microphone was used.
- A real Luna repair converted an unsupported integral tool request into a valid `create_math` operation for the integral of cosh(x).
- Chrome used an isolated local fixture importing the real InlineEditor and preview converter. With saved source `x^2` and a speculative `x^2+3` draft, the editable field remained `x^2`. Typing `+4` saved exactly `x^2+4`. Transcription input progressed from “the integral of” to “the integral of sine x d x,” and the rendered draft progressed from an integral symbol to the full expression without changing stored source.
- TypeScript and the production build pass. Existing bundle-size warnings remain.

These checks cover the regression paths; microphone timing and recognition still need physical-device testing.
