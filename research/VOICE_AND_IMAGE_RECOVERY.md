# Voice recovery and confirmed image generation

Verified September 27, 2026, on Windows with Chrome. This extends the merged Excalidraw integration.

## Behavior

- Malformed operation payloads are validated centrally. Unambiguous envelopes can be normalized; invalid or incomplete instructions get a bounded Luna correction using the original instruction and board context.
- Rejected math/text edits stay pinned to their original objects and source. A changed board, cancellation, partly applied batch, or exhausted retry budget prevents replay. Authentication and credit failures stop rather than looping.
- Voice recovery temporarily pauses microphone tracks and magic-pen gestures. The pencil remains available; changes that invalidate a correction cause it to be discarded. Audio spoken during repair is not queued. Progress is visible and recovery can be cancelled.
- Realtime sessions renew in short segments and reconnect with bounded attempts. Conversation bookkeeping and streamed tool arguments are bounded. Previously completed edits are not replayed.
- The large microphone circle already disconnected voice when gray; this update adds explicit Pause/Resume wording. The separate speaker button controls optional spoken replies. Spoken replies remain off by default.
- The cumulative local voice allowance defaults to 180 minutes. It is not a dollar cap, and existing consumption is retained. The client pauses after 90 seconds without speech.
- Image requests produce a reviewable description and shaded placement. Only the user's confirmation invokes the Images API. The default is `gpt-image-2.5-flare`, `quality: low`, one PNG. This is a quality setting, not reasoning effort.
- Images retain their approved placement and enter normal notebook storage, Undo/Redo, crop, and export. Reload resumes polling the same request. A generated image is checkpointed before clearing its recovery record.
- Duplicate confirmations, repeated POSTs, and reloads do not automatically generate additional images. Ambiguous or failed image generation never retries the provider automatically. Server results are temporarily cached; server restarts retain request-ID reservations but not pending result data.

## Automated verification

- `npm test`: 469 passing tests in 39 files.
- `npm run build`: TypeScript and Vite production build pass. Existing large-bundle and dependency annotation warnings remain.
- Voice stress uses fake time and a simulated WebRTC/provider: 260 turns across more than two simulated hours, over 25 renewed sessions, one microphone acquisition, exactly 260 intended applications, and bounded maps.
- Cases include malformed tool lists, incomplete/failed responses, rate limits, backoff, stale targets, manual source changes, fatal quota/authentication errors, stop during repair/reconnect, idle pause, session renewal, and oversized streamed arguments.
- Image cases include 100 simultaneous duplicate submissions, owner isolation, durable reservations, ambiguous timeout without paid retry, notebook switching, reload, checkpoint failure, double confirmation, malformed PNGs, byte limits, and changed Literal placement before confirmation.

## Chrome checks

An isolated local app used a fake OpenAI HTTP provider through the SDK's `OPENAI_BASE_URL`. No API credit was spent on failure injection or test images.

1. A malformed command response was repaired with one correction and inserted one equation.
2. A temporary HTTP 429 recovered and applied the requested edit once.
3. A delayed request was cancelled; its eventual response did not add an object.
4. An AI image proposal displayed an editable prompt and shaded region with zero image-provider calls.
5. Confirmation produced one image-provider call. Reload resumed the same job; one image appeared and survived notebook checkpointing.
6. Undo and Redo handled the generated image normally.
7. Missing Literal placement showed an actionable message without crashing the app.

Free model metadata requests using the configured project key returned HTTP 200 for `gpt-realtime-mini`, `gpt-6-luna`, and `gpt-image-2.5-flare`. This confirms model visibility, not successful paid image generation. Actual image generation was not purchased during these checks.

After deployment, the real Chrome **Check voice connection** control passed negotiation, board-context creation/replacement, and server-confirmed shutdown. The microphone was not activated. The restored temporary HTTPS preview returned HTTP 200.

## Remaining verification

The long-session test is simulated; it does not establish hours of uninterrupted real audio or iPad/Pencil behavior. Network outages, exhausted credit, expired keys, and unrecoverable instructions can still require user action. Real images should be tested through the new explicit approval control. Local allowances are cumulative counters, not OpenAI billing enforcement.
