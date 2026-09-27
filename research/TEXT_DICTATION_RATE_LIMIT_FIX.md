# Text dictation, rate limits, and reply language

## Changes

- Dictate text consumes input transcription directly. It creates editable text or appends to an unchanged compatible text target; questions remain literal prose. Transcript deltas supply disposable previews, and finalized phrases commit in original speech order. The queue is bounded to eight phrases and reuses the exact-audio fallback when a final transcript is missing.
- Continuation only rebases across verified changes made by the dictation queue itself. Manual edits, changed targets, mode switches, Stop, and session changes invalidate obsolete work. A newly created text object can remain the continuation target inside an unchanged empty focus region.
- Realtime throughput failures use provider retry hints or reset counters, with one bounded same-session retry. They do not invoke Luna repair or immediately reconnect. Successful or partially successful changes cannot be replayed. Credit, authentication, and context-size failures are handled separately. A wait over 60 seconds or a second rejection stops voice with an English notice.
- Voice instructions use the newest replaceable board snapshot. They no longer embed a stale connection-time snapshot, and successful tool outputs no longer repeat all board objects. Silent successful edits skip a confirmation generation.
- Assistant feedback defaults to English, independently of foreign-language board content. Input transcription also receives explicit faithful English transcription guidance. No-op repair responses appear as clarification notices rather than red edit failures.
- Removed the user-facing object dropdown. Direct canvas selection and the selected object's editing controls remain available.

## Verification

- Full automated suite: 789 tests across 47 files. Covers FIFO transcripts, missing-transcript recovery, mode/selection changes, Stop, continuation after creation, source-range safety, bounded state, retry timing, stale request events, partial success, quota failures, English reply policy, and compact tool results.
- TypeScript and production build passed. The existing large-bundle warning remains.
- A live Realtime ASR check used 4.774 seconds of synthetic English speech with the production client. Two finalized phrases produced one text object: “What is photosynthesis? This is a question in my notes.” No assistant response generation or Luna call occurred.
- Chrome verified the production page, removed object dropdown, retained source inspector, Dictate text selector/hint, and stopped microphone state. A brief microphone check also demonstrated that background sound can still be misrecognized; the temporary test text was undone. The input guidance is a mitigation, not a guarantee of perfect speech recognition.

No test intentionally exhausted the account's rate limit. Rate-limit recovery was tested with injected provider events, and physical-iPad microphone behavior still requires device testing.

## Provider references

- [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits): request/token throughput limits are separate from account usage or credit.
- [Realtime rate-limit events](https://developers.openai.com/api/reference/resources/realtime/server-events#rate_limits.updated): output-token reservations can temporarily reduce reported remaining capacity. A counter update alone does not trigger retry or pause.
