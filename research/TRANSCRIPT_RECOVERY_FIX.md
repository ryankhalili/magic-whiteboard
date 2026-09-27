# Delayed transcript recovery and evaluation-bar dictation

September 27, 2026. Follow-up to [the earlier integral recovery change](LIVE_MATH_TOOL_FIX.md).

The reported message, “The last utterance could not be transcribed safely,” came from a client deadline of only 1.5 seconds while waiting for the independent input transcript. A malformed or incomplete voice response could start correction before that transcript arrived. A later retry could therefore work even though the first request stopped. The user's original audio/event trace was not retained, so the exact first response failure is not known.

Recovery now waits up to six seconds for the original finalized transcript, then retrieves only that turn's committed audio item. It first reuses a transcript attached to the retrieved item; otherwise it sends the original PCM to the dedicated transcription endpoint. Original transcripts arriving while retrieval or transcription is pending win the race and cancel the fallback. Late events from other turns cannot supply the instruction. The microphone pauses during recovery and resumes afterward; Stop cancels pending work.

The retrieval has a four-second deadline, the ASR request has an 18-second deadline, and the complete client recovery has a one-minute ceiling. The existing semantic correction still has its own 30-second server budget. Audio is bounded to 100 ms–30 seconds, converted to WAV in memory, and never written to disk. The endpoint uses the existing pairing/origin checks, rate limit, and durable command allowance before invoking the provider. Tokens are recorded when supplied by the provider. No API key reaches the browser.

The recovery handler does not generate assistant text to stand in for a transcript. A live experiment with a conversational model's “transcribe only” prompt sometimes produced an answer instead. The shipped path uses retrieved audio and the speech-to-text API. The API supports [retrieving the full original audio item](https://developers.openai.com/api/reference/resources/realtime/server-events#conversation.item.retrieved).

Recovery cannot replay a successful or partially successful batch after a subsequent response failure. A late finalized transcript that differs from the instruction being repaired prevents the correction from applying. Source, selection, placement, and cancellation guards remain in force.

The preview parser and dictation prompt now recognize “this now equals negative cosine of x bar from pi to two pi.” The next step appends to the original equation using paired evaluation-bar delimiters; it does not solve the integral or invent endpoint values. Incomplete bounds are displayed only as temporary drafts.

## Live verification

- Full automated suite: 659 tests pass across 42 files. TypeScript and the production build pass; existing bundle-size warnings remain.
- Regression cases include a transcript arriving after five seconds, failed transcription, missing/retrieved transcripts, exact audio ownership, duplicate delivery, late final disagreement, cancellation, timeouts, changed source, partial-success replay prevention, and unusable speech leaving the healthy voice connection open.
- A locally synthesized recording of the user's phrase sent to the actual Realtime API returned an `edit_content` operation for the original equation, with ` = \\left.-\\cos(x)\\right|_{\\pi}^{2\\pi}`.
- A test drove the production Realtime client over a WebSocket test transport while deliberately suppressing independent transcription and the retrieved item's transcript, and injecting an incomplete original response. The client retrieved the real original audio, used the real dedicated transcription service, called Luna once, and applied one valid continuation to the same equation. It made one retrieval, one ASR call, one repair call, and one board application; the microphone state resumed.
- Chrome rendered the incremental evaluation-bar draft in an isolated fixture importing the real converter and editor. The complete draft showed the original integral followed by the evaluated antiderivative; an unfinished upper bound stayed a draft placeholder. Stored source remained unchanged.

These are regression and synthetic-audio checks, not a guarantee of error-free recognition or an hours-long physical iPad session. Indistinct speech, exhausted credit, unavailable original audio, changed targets, and service failures can still require a repeat. Audio spoken while recovery pauses the microphone is not queued.
