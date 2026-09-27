# Excalidraw port — implementation and verification

Branch: `codex/excalidraw-port`. Verified September 26–27, 2026.

This report covers the initial port. See the [interactive math merge report](INTERACTIVE_MATH_MERGE.md) for the later integration and its 291-test run and ego-browser verification.

Excalidraw is viable as this app's canvas base. This branch uses the published
`@excalidraw/excalidraw@0.18.1` React component with the app's focused toolbar.
It replaces the handwritten canvas interaction layer while retaining notebook
compatibility, editable math/graph source, AI operations, and one shared history.

## Integration boundary

Excalidraw handles ink, selection, dragging, resizing, rotation, grouping, pan,
zoom, and native clipboard gestures. The application document remains the source
of truth. `excalidrawScene.ts` translates between document records and native
elements, including rotation pivots, pressure samples, opacity, locks, and order.

Custom math, text, graphs, and geometry render as transparent PNG images in the
native scene. Full source records remain in application storage and element
metadata. Live DOM editors preserve MathLive, LaTeX, graph-expression, and text
editing. Moving an object reuses its image; changing its content regenerates it.
The image-render queue is bounded and discards obsolete results.

The app owns history for native gestures and AI edits. It finishes an active
native interaction before an external edit, notebook replacement, or export.
Native Excalidraw history is cleared to avoid competing undo stacks.

The upstream package is included as a dependency. Restricting visible tools does
not produce a stripped engine build. The measured production entry chunk is
about 3.16 MB minified / 1.03 MB gzip, plus lazy chunks, styles, and fonts. Vite
reports a large-chunk warning. Extracting or forking selected internals would be
separate work with ongoing upstream maintenance costs.

## Verification

The commands `npm test`, `npm run check`, `npm run build`, and `npm audit` pass.
The final automated run passed 206 tests in 20 files.
The dependency audit reports zero known vulnerabilities in the installed tree.

Browser work used the requested **@Browser** plugin against development
(`localhost:3010`) and production (`localhost:3011`) servers. Separate origins
and named QA notebooks kept these checks away from the existing port-3000 library.

| Area | Browser result |
| --- | --- |
| Example content | Graph, equation, text, and triangle render in the native scene |
| Drawing | Pencil strokes, color/width changes, ink over graphs/backgrounds, erasing, undo/redo |
| Selection/transforms | Drag, free resize with Shift, native rotation, multi-select/nudge, duplicate and copy/paste |
| History | Individual gestures and repeated duplicates undo independently; redo restores them |
| Direct editors | Multiline text, LaTeX source, MathLive visual entry, and graph source changes |
| Graph controls | Range changes, equal/auto axis scaling, natural size, and invalid-expression rejection |
| Real AI | Selected-graph updates and literal-region equation creation |
| AI during drag | Held a real server response until a native drag was in progress; the AI update kept the moved pose, the later pointer release did not replay old geometry, and two Undo actions separately reverted AI content and movement |
| Images | Sample worksheet as a locked background, annotations, background removal/undo, and movable image upload |
| Notebooks | Create/rename, switching, repeated reloads, stable object identities, editable source, and paper settings |
| Export/import | PNG, PDF, editable JSON; reimported a worksheet notebook with its image and paper settings intact |
| Visual export checks | Opened PNGs and rendered both worksheet and content PDFs; checked math, graphs, text, image backgrounds, and A4 clipping |
| Tablet layout | 768×1024 and 1024×768; fit, pan, zoom, and no horizontal document overflow |
| Simulated touch | Chromium two-finger pinch changed zoom from 42% to 66% without losing objects |
| Plain HTTP LAN | Ran all ten smoke checks on the machine's LAN address with `isSecureContext`, `crypto.subtle`, and `crypto.randomUUID` unavailable; all six custom objects completed native image rendering |
| Local font delivery | Production font endpoint returned WOFF2 bytes identical to the built asset |
| Voice service | Real connection diagnostic passed without activating the microphone |
| Production diagnostics | No console errors or warnings after the smoke and interaction checks |

The repeatable script is [`tests/browser/excalidraw-smoke.js`](../tests/browser/excalidraw-smoke.js).
It is a single `async (page) => …` function for the Browser plugin's run-code tool.
Open the app at a desktop viewport and supply that file to the tool. The script
creates a separate timestamped notebook, uses ordinary UI input, checks observable
document state, and reports ten workflow checks. It passed on both builds and
again over plain HTTP on the actual LAN address.
It does not make paid AI calls or activate audio.

Local screenshots and exported files from this run are in ignored `test-results/`.

## Issues caught and fixed

- Initial native scene initialization could overwrite an already-restored notebook.
  The bridge now waits for native initialization and pushes the restored document.
- A queued pointer completion could replay old state after an AI edit or Undo.
  Completion generations invalidate that callback and pending external state wins.
- Duplicate insertion order could create an extra history edit. The adapter now
  imports duplicates at their native position in the same transaction.
- Native hand panning bypassed one pointer callback. Stage/window tracking now
  completes these gestures too.
- Transparent SVG image data needed base64 encoding for Excalidraw's decoder.
- Live DOM content above all ink produced incorrect stacking. Native image
  rendering now provides scene order while preserving source editing.
- Native and application image-drop handlers could both import the same file.
  The application captures supported image drops once.
- Fit-to-content could place content underneath the left toolbar on a tablet.
  The fit margin now leaves room for the controls.
- Plain HTTP LAN pages lack Web Crypto digest and native UUID APIs. Content image
  identities and local record creation now use fallbacks when those APIs are absent.

## Remaining limits

This is a tested port, not a guarantee of defect-free behavior. Actual Apple
Pencil pressure/tilt, palm rejection, mixed pen/touch cancellation, Safari file
downloads, and a live spoken voice session need physical-device acceptance tests.
The voice connection diagnostic and Chromium touch simulation do not establish
those behaviors.

Custom content uses bounded-resolution PNGs (up to 2× source size, 4096 pixels
per edge and about four megapixels). Extreme zoom can expose pixels. The app's
exporter renders from editable source rather than those preview images.
Large-notebook latency and memory use have not been load-tested. The adapter and
private CSS selectors need regression checks when upgrading Excalidraw.

Code/font license notices were regenerated and local font delivery added. See
the README and `THIRD_PARTY_NOTICES.txt` for the font-specific terms and retained
attribution gaps. This work does not include a new distribution clearance.
