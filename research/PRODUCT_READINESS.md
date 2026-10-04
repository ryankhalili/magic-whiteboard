# MagiBoard product readiness review

Reviewed October 3, 2026. This review covers the current local application and the changes in this working branch. It distinguishes implemented safeguards from the work needed for a paid, shared service. It is an engineering assessment, not a security certification or a claim that all educational tasks are supported.

The project has a useful foundation for a small supervised pilot: editable canvas objects, constrained mathematical tools, recoverable notebook saves, PDF import, local textbook search, and bounded AI correction. The next product milestone should be reliable daily use of a few complete workflows. Adding arbitrary tools faster than they can be tested would make the existing voice and document problems harder to diagnose.

## Current architecture and strengths

| Area | Evidence in the repository | Practical consequence |
| --- | --- | --- |
| Canvas commands | `shared/command-schema.ts`, `shared/tool-command.ts`, `src/board/controller.ts` | Model output is declarative and validated. Operations target stable object IDs and can be rejected before corrupting a board. |
| Math | `src/board/expression.ts`, `src/math/scientific.ts`, `shared/visualization.ts` | Expressions and visualization parameters are bounded. The app does not execute arbitrary generated JavaScript. New surfaces, revolutions and phase portraits are sampled visualizations. |
| Notebook recovery | `src/notebooks/library.ts`, `src/notebooks/canvasBackup.ts`, snapshot migration and App save lifecycle | The notebook manifest has a recovery copy; canvas checkpoints and original migration archives are preserved. Switching waits for saving. |
| Textbooks | `src/library/indexer.ts`, `guide.ts`, `search.ts`, `resolve.ts` | PDF text extraction, item anchors and BM25 search happen locally. A durable book guide records contents, detectable items, practice pages and text coverage. Exact matches avoid the optional remote ranker. |
| Voice recovery | `src/ai/realtime.ts`, `voice-recovery.ts`, `audio-transcript-recovery.ts`, `server/command-repair.ts` | Recovery is bounded, tied to the original instruction and checked against the current board. Uncertain or obsolete edits are not blindly replayed. |
| Usage protection | `server/usage-ledger.ts`, `server/security.ts` | Paid calls reserve cumulative allowances before starting. Unreadable usage records disable further paid requests. Image requests have durable duplicate protection. |
| Regression checks | `.github/workflows/ci.yml`, `tests/` | CI runs type checking, tests and a production build. These are necessary checks, not evidence of physical iPad behavior or general model accuracy. |

## Textbook changes in this iteration

The reader now exposes movement and resizing with pointer and keyboard controls, pinning, 50–300% zoom, fit to width, file-page navigation and a contents list. Pinning prevents accidental panel movement while allowing reading, search and zoom. Moving the reader no longer makes it jump or shrink when voice controls grow.

Each newly indexed or reindexed book stores a deterministic structure guide with the PDF bookmarks, resolvable printed contents entries and detected headings. The guide is downloadable as text. Its compact model context is capped at 2,500 characters. It does not upload or summarize an entire book with a paid model, and it does not assert an exercise-placement rule without evidence from detected pages.

Search now handles named theorems, compact `thm.` references, number-before-theorem headings, named figures, Unicode ligatures and words split across PDF lines. Candidate snippets show the matching passage. Bookmarks provide chapter scope even when printed chapter headings were not detected. A scanned book with useful bookmarks can offer the corresponding page; the UI says when page text is unavailable.

Remaining limitations are explicit: this is lexical retrieval plus structured references, not comprehensive semantic understanding. Image-only pages require visual browsing/cropping; automatic OCR is not implemented. Caption-based figure crops and inferred exercise boundaries remain heuristic. Repeated theorem names or exercise numbers can legitimately require choosing a chapter or candidate. Guide creation still requires one local text pass over the PDF, although subsequent lookups reuse the stored index.

## Release blockers for a hosted service

1. **Account and document authorization.** The present six-digit pairing code and in-memory sessions are suitable for a laptop plus paired devices. They are not user accounts, organization roles, tenant isolation or a billing identity. A hosted release needs authenticated ownership checks for every document, asset, asynchronous job and export. Use explicit tenant scope through database, storage and job queues; test cross-account access failures. [OWASP multi-tenant guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
2. **Durable backup and recovery across devices.** IndexedDB and localStorage belong to one browser origin. A new hostname, another browser profile or browser-data deletion can make work unavailable. Persistent-storage requests help but are not a backup. Add an obvious backup status and restore flow before promising long-term notebook retention; cloud synchronization needs versioning and conflict handling. Browser storage can be evicted and capacity requests can fail. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
3. **Per-user cost accounting.** The current ledger is a single local cumulative allowance, not a per-customer dollar balance. A command may contain bounded retries, Realtime uses a different billing path, and transcription/image usage must remain distinguishable. Before charging subscribers, record usage per provider/model/customer with idempotent jobs and enforce a server-side monthly allowance. Do not sell unlimited cloud AI until real usage distributions and maximum loss per account are measured.
4. **A clear data disclosure and deletion path.** Book bytes and indexes are local, but selected board content, visual context, speech and ranker candidate descriptions can leave the device when the corresponding AI feature is used. A local transcription option does not make cloud commands local. Explain this at the feature boundary and provide export/deletion controls. Decide retention, provider settings and school/minor-use requirements before a school deployment.
5. **Operational evidence.** The code has retries and tests, but no evidence here establishes unattended, multi-hour reliability on physical iPads. Add scrubbed diagnostics, request IDs, recovery outcomes and latency measurements. Do not log microphone audio, textbook passages, notebook contents or API keys by default. The interface should expose recovery, cancel and retry without promising that provider errors can always be repaired.

## Cleanup and performance priorities

The October 3 dependency audit initially reported **four high-severity findings**. A scoped override for Excalidraw's Sass dependency to **1.79.4** replaces its old watcher chain with Chokidar 4 and removes 13 installed package instances. A fresh `npm audit --json` after that update reports **zero findings across all severities**, and the production inventory/notices were regenerated. This describes the advisories reported for that lockfile at that time; it is not a security certification, an application penetration test, or evidence that future advisories cannot appear.

The main maintenance risks are concentration and duplicated lifecycle responsibilities. At review, `src/App.tsx` and `src/ai/realtime.ts` each exceed 1,000 lines. Those files coordinate asynchronous work, UI state, voice lifecycle, notebook switching and recovery. Extracting one tested responsibility at a time is safer than a cosmetic rewrite that changes callback ordering.

Recommended module boundaries are document persistence, command execution, library lookup, voice session lifecycle, and UI panels. Use one command registry for schemas, prompts, user-facing capabilities and examples where feasible. Keep compatibility adapters and recovery code until supported notebook migrations have explicit removal criteria; their length alone is not evidence of bloat.

The textbook reader virtualizes pages and renders at most two concurrently. Indexing yields between batches and stores a reusable guide. Large books still retain substantial text and line metadata in memory during the initial pass. Before importing arbitrary 400 MB books on iPad, benchmark peak memory and move extraction/index construction into a cancellable worker with progress and storage estimates. Prefer page-range OCR on demand to an automatic paid whole-book scan.

Track bundle size, first usable board time, input latency on a dense page, PDF import memory and image export time. Dynamic loading of the equation editor, PDF engine and scientific tools is a good next optimization only after measuring their actual startup cost. Keep the math/rendering budget bounded; never make an unlimited model-generated program part of the normal canvas render loop.

## Verification still needed

Library regression checks for this iteration passed **253 tests in 13 files**, with four optional local-fixture tests skipped. This includes book-guide mapping, ambiguous printed page labels, named theorem retrieval, bookmark chapter scopes, scanned-page fallbacks and legacy library behavior. The parent release process should record the final whole-project suite and browser checks separately.

The physical-device checklist should cover Apple Pencil drawing and palm behavior; drag/pin/zoom while navigating a long textbook; repeated microphone permission changes; app backgrounding and return; lock-screen interruption; long sessions; network loss; notebook switching while a request is pending; and low-storage save failures. Use restored backups and harmless fixtures, not the user's sole working notebook.

For each mathematical visualization, keep reference fixtures with known geometry and invariants. Explicit/implicit graphs and sampled 3D surfaces can miss narrow features or unsampled singularities. ODE phase trajectories are numerical approximations, not general PDE solvers. Verify revolution-axis semantics using an asymmetric curve. Manual object controls, live rendering, PNG/PDF output and restored notebooks must agree.

Keyboard labels and reader arrow-key controls improve access, but the full canvas has not had an assistive-technology audit. Test focus order, visible focus, toolbar shortcuts, editable math, microphone status announcements and non-visual access to equations with keyboard and screen readers. Diagram accessibility needs meaningful descriptions, not only an image of the result.

## Recommended milestones

| Milestone | Scope | Acceptance evidence |
| --- | --- | --- |
| Reliable personal daily use | Homework PDF workflow, predictable graph controls, reader retrieval, hold-to-talk, portable backups | Real iPad sessions, recoverable interruptions, export/restore comparisons, no duplicate edits or lost accepted writing |
| Small invited pilot | Account-scoped storage, optional synchronization, deletion/export, usage visibility, scrubbed diagnostics | Tenant-isolation tests, restore drills, per-user cost measurements and observed completion rates on real user tasks |
| Paid educational product | Billing and quotas, privacy requirements, support and incident procedures, accessibility, stable deployment | Repeatable release checks, representative users, known monthly unit economics and a supportable recovery process |
| Advanced scientific workspace | More 3D/ODE tools, optional OCR, animation/export service, richer diagram generation | Each capability has bounded execution, mathematically checked fixtures, understandable controls and declared limits |

Animations or Manim output should be a separate constrained rendering service if added. Use predefined scene templates or a sandbox with strict CPU, memory, time, filesystem and network limits. Arbitrary generated Python should not execute in the application server. General PDE simulation, symbolic theorem proving and universal handwriting recognition are distinct projects; presenting the current tools as those systems would mislead users.

The refreshed [distribution audit](COMMERCIALIZATION.md) records the current Excalidraw production tree and bundled-font terms. Resolve the remaining attribution gaps and Liberation-font distribution requirements before commercial release, and regenerate the inventory against the final lockfile. Permissive canvas licensing does not remove other third-party obligations.

## Integrated release verification

The integrated Windows run passed **1,381 tests across 80 files**, with eight optional/credential-backed fixture tests skipped. Type checking and the production build passed. The build still reports large chunks (main JavaScript about 1.17 MB gzip); reducing cold-start cost remains measured follow-up work, not a completed optimization claim.

Browser checks used separate synthetic review notebooks. They covered typed LaTeX creation and the visual equation editor, 3D surface creation/rotation, X/Y revolution settings and sweep, phase portraits, independent object placement, PNG output, and restored scientific metadata after a reload. Named and numbered theorem lookups returned the correct fixture passage; reader movement, pinning, 125% zoom, contents, and guide download worked. A discovered false TOC chapter start was fixed with a regression test.

A three-page homework PDF was imported through the UI, its rotated second page annotated with `x = 2`, and downloaded through Homework PDF. All three exported MediaBoxes, CropBoxes, rotations and page order matched the source. Visual inspection confirmed the annotation position; additional rendered regression fixtures verified exclusion of off-page scratchwork, crop/flip/canvas rotation, fillable forms, and legacy raster fallback. New ink and math annotations are flattened into a raster overlay; original PDF text/vector content is preserved when source bytes are available.

Voice permission races, cancellation, microphone gating, mode changes and final-turn handling were tested with simulated clients/events. This release has not been validated with continuous human microphone sessions or physical Apple Pencil/iPad use. The local ASR measurements used eight clean synthetic clips and silence, not noisy human speech. See [local voice experiment](LOCAL-VOICE.md) for measured timings and reproduction steps. Local ASR is not yet an in-app provider.

Visual review artifacts: [math tools](magiboard-math.png), [reader](magiboard-reader.png), and [homework page](magiboard-homework.png).
