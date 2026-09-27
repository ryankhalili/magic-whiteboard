# Interactive math on the Excalidraw canvas

Integrated `feat/interactive-math` at `92c5d7f` into `codex/excalidraw-port`.
Verified September 26–27, 2026, using Node 22 and the requested ego-browser.

## Result

The interactive math features run on the Excalidraw drawing surface. The merge
retains the Excalidraw adapter, notebook format, editable source, shared undo
history, and local font delivery. It adds the persistent object inspector,
implicit equations, constrained polygons, appearance controls, image cropping,
and pending-source persistence from the feature branch.

The adapter still owns the boundary between the application document and native
canvas elements. Custom content is rendered into native images while its source
and constraints remain editable. No new dependency was needed for this merge.

## Integration fixes

- Converted the inspector's normalized image crop into Excalidraw's pixel crop,
  and converted native changes back into the portable document. Earlier native
  crops migrate on load. Native images and exports use the same crop and flips;
  crop anchoring accounts for rotation and flipped axes.
- Replaced the native view-mode toggle during inline editing with an interaction
  shield. Excalidraw deselected the object when view mode changed, which hid the
  inspector after Done. Editing now retains the selection and inspector, and a
  click outside commits the source before selecting another object.
- Kept inline editors clear of the inspector and command bar by adjusting the
  camera when necessary. Checked both tablet orientations.
- Memoized implicit-curve sampling so selection and camera updates do not repeat
  the numerical sampling work. Bumped the content-render version for new visuals.
- Reconciled the documentation with the actual Excalidraw implementation and
  retained the feature branch's development workflow and historical research.

## Automated checks

- `npm run check`: passed.
- `npm test -- --reporter=dot`: 291 tests passed in 26 files.
- `npm run build`: passed. The existing large-chunk warning remains; the main
  entry is about 3.19 MB minified / 1.04 MB gzip.
- `npm audit --omit=dev`: zero reported vulnerabilities.
- `git diff --check`: passed.

New adapter regressions cover crop conversion, native resize/reset, rotated
reset with undo/redo, reload, flipped SVG export, old crop migration, and native
duplication of constrained geometry. Incoming tests cover implicit plots,
geometry constraints, batch placement, appearance, source validation, and
pending-source persistence. The SVG unit fixture now renders inside an SVG root,
avoiding React's HTML casing warning; its 41-test file passed after that fix.

## Browser checks

One ego-browser task space exercised development on `localhost:3012` and the
production build on `localhost:3013`. Named QA notebooks and separate origins
kept these checks separate from the existing port-3000 library. Actions used
ordinary controls, native pointer/keyboard input, real file choosers/downloads,
and DOM observations rather than private application APIs.

| Area | Verified behavior |
| --- | --- |
| Drawing and history | Colored pencil strokes, erasing, pan, native drag, independent resize, repeated duplication, grouping, group drag and copy/paste, and separate undo/redo steps |
| Graphs | `sin(x)`, vertical lines, circles and `x*y=1`; invalid drafts retain the last valid graph; restore, ranges, equal/independent units, grid/axes visibility, and line width |
| Equations and text | MathLive visual typing, LaTeX source with preview, invalid-source recovery, multiline text, Done retaining selection, and undo/redo |
| Inspector | Object picker, collapse/reopen, zoom to object, locking, size, rotation, opacity, fill, line width, and layer controls; manual controls also work in Literal mode |
| Constrained geometry | A real AI request produced a quadrilateral with 91°, 91°, 90°, 88° angles and A–D labels; styled, resized, rotated, reloaded, and exported it |
| AI graphs | A real request created separate `x=1` and `x^2+y^2=9` plots, preserving full equations |
| AI during drag | A real graph update arrived during a held drag; content changed without losing the moved pose; two Undo actions separately restored source and position |
| Images | Actual movable-image upload, 25% left/right cropping of a four-color fixture, native display showing only the middle green/blue bands, rotation, reset, undo, and reload |
| Notebooks | Create/rename, immediate switch after source editing, isolation, reload, editable JSON export, and import into another notebook |
| Worksheets and paper | Locked A4 worksheet, ink over it, eraser preserving the background, background removal/undo, grid paper, and paper color |
| Exports | PNG, PDF, and editable JSON; inspected exported images and rasterized PDFs for math, geometry, image crop, worksheet ink, and A4 bounds |
| Work area | Magic-pen region selection and clearing |
| Tablet layout | 768×1024 and 1024×768, no horizontal overflow, inline controls accessible beside the inspector |
| Simulated touch | Native two-finger pinch changed zoom from 106% to 159% while retaining six objects |
| Voice service | Real connection diagnostic passed on the production build without activating the microphone |
| Runtime diagnostics | No captured page errors, unhandled rejections, runtime exceptions, or application error alerts in the final production checks |

The repeatable [ego-browser smoke script](../tests/browser/ego-interactive-math-smoke.js)
passed all six workflow groups on the production build. Run it inside an existing
ego-browser task space at a 1440×1000 viewport:

```js
const { runInteractiveMathSmoke } = await import('/absolute/repo/tests/browser/ego-interactive-math-smoke.js')
console.log(await runInteractiveMathSmoke(page))
```

It creates timestamped QA notebooks and uses no paid AI calls or audio. Manual
browser checks above additionally exercised real AI, file transfer, exports,
tablet layout, and touch. Local evidence is in the ignored directory
`test-results/interactive-math/`, including `production-smoke.json`,
`production-imported.png`, `production-worksheet.pdf`, `production-worksheet-pdf.png`,
`combined.marginalia.json`, `combined.pdf`, and `tablet-editing.png`.

## Remaining validation

Physical iPad Safari, Apple Pencil pressure/tilt and palm rejection, mixed
pen/touch cancellation, device downloads, and a live spoken voice session still
need device testing. Desktop Chromium simulation and a service connection check
do not validate these hardware-specific behaviors. Large-notebook performance
has not been load-tested. Custom canvas previews retain the port's raster zoom
limit; exports render from editable source. The existing Excalidraw bundle-size
tradeoff also remains.
