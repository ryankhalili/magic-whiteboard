# Main integration and voice recovery

Integration date: 2026-09-27. Combined `origin/main` at `9845b29` (PDF textbook library, import/export, placement, slideshow) with `feat/interactive-math` at `b550502` (literal text dictation, English feedback, rate-limit recovery).

## Changes

- Voice snapshots have a 12,000 UTF-8 byte ceiling. Selected object identities take priority. Source that cannot fit is explicitly marked unavailable instead of presenting a truncated equation or paragraph as complete. Replacement preflight mirrors the controller's target aliases and batch selection changes; a local append can still use the complete saved source.
- Realtime history uses retention-ratio truncation with a 12,000-token post-instruction budget. A context-capacity failure refreshes the voice session once, retains completed board edits, and asks for only the unfinished instruction. It does not replay edits or spend a repair-model request on a capacity error. A second capacity failure pauses voice.
- Recovery after a filler interruption retains the original instruction. Ambiguous interruptions stop rather than applying guessed edits; validated content repairs can fall back to the failed operation's intent.
- PDF searches and inserts check cancellation, notebook/editor identity, source changes, and reference-book/highlight changes before committing. Search retries preserve their original book/page reference. This applies to voice, typed library shortcuts, and manual reference-panel insertion.
- Literal text dictation keeps precise local coordinates and tolerates floating-point noise. Library-panel metadata changes do not invalidate otherwise unchanged text continuation. Typing a word such as “undo” while actively dictating text writes that word.
- The object dropdown remains removed. The PDF browser smoke script now checks the selected object's inspector instead.

## Verification

`npm test` passed 1,282 tests in 73 files, with 8 intentionally skipped. `npm run check`, `npm run build`, and the staged-secret scan passed. Regression coverage includes large multibyte PDF context, failed context sends, stale response errors, context renewal without replay, omitted-source protection, filler provenance, delayed insertion cancellation, and fractional-coordinate text continuation. PDF import, indexing, lookup, crop, persistence, and export are covered by automated tests.

OpenAI accepted the merged Realtime configuration in a live configuration-only request. A separate bounded live transcription check sent 4.774 seconds of synthetic audio through Realtime: two phrases appended to one text block, with zero assistant response requests and zero Luna repair requests.

On an isolated localhost origin, Chrome UI checks confirmed worksheet/example creation, Undo/Redo, notebook creation, and persistence after reload. End-to-end PDF upload was not verified in this pass: the extension's file upload permission was disabled, and native-picker interaction was interrupted by concurrent user activity. A PNG download wait subsequently timed out, so it is not counted as a successful export check. No browser permission or security settings were changed.

The PDF export test now imports its renderer during test-file setup, keeping cold dependency compilation outside the individual rendering assertion's timeout. Production build warnings about large chunks and dependency annotations remain nonfatal.

## Limits

These checks do not establish error-free multi-hour sessions or physical iPad behavior. Account credit, per-minute provider limits, context capacity, and the app's local allowances are separate constraints. A PDF in the reference library is not automatically an editable board object: insert its page/excerpt, or use a library request that names it. Existing board-object IDs and notebook data formats are preserved.
