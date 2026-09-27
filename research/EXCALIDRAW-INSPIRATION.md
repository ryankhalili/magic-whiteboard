# Excalidraw ideas for Magic Whiteboard

Historical review from `feat/interactive-math`, written before the canvas port. The merged branch now uses Excalidraw; see the [port report](EXCALIDRAW_PORT.md) and [interactive math merge verification](INTERACTIVE_MATH_MERGE.md) for its current implementation.

Reviewed 2026-09-26 against the official repository and developer documentation. Most recommendations below are implementation proposals. This branch adds **Zoom to object** using our own editor, and exposes existing front/back layering to AI commands. No Excalidraw dependency or source code was added in this review.

Excalidraw is a useful interaction reference for our existing canvas. Keep Magic Whiteboard's editable equations, numerical plots, constrained geometry, voice context, and notebook persistence; extend the object workflow around them. Replacing the canvas would introduce another data migration and require adapting these custom objects.

The [official README](https://github.com/excalidraw/excalidraw#features) identifies reusable shape libraries, bound/labeled arrows, image support, editable JSON, and PNG/SVG/clipboard export. It separately identifies collaboration, encrypted sharing, offline PWA behavior, and browser autosave as features of the hosted application. Installing its editor package does not automatically provide that entire hosted service.

## Two useful additions now

| Addition | Benefit here | Implementation in our existing engine |
| --- | --- | --- |
| Duplicate selection | Compare two versions of a graph or equation; reuse a diagram without reconstructing it. | Visible Object controls action plus Ctrl/Cmd+D outside text/math editors. Complete active gestures and flush valid source drafts; clone with fresh shape IDs, offset, select copies, and make the batch one undo step. Preserve asset references and remap any copied group relationships. |
| Zoom to selected / Reveal object | Find an equation outside the current view, or inspect the object referenced by the magic pen. | Union selected page bounds and call existing `zoomToBounds` with padding. Add an explicit Reveal action beside the object picker; retain Fit canvas for the entire board. Avoid moving the camera on every ordinary selection. |

These behaviors are grounded in Excalidraw's [duplicate action](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/actions/actionDuplicateSelection.tsx) and [targeted viewport API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api#scrolltocontent). Its duplicate action exposes a keyboard shortcut and records the change in history. Our source already has creation, selection, history, bounds, and camera primitives; these additions need no new package. Confirm duplicate undo/redo, image references, grouped shapes, pending edits, and input shortcut isolation before shipping.

## Next priorities

| Priority | Idea | Educational use and scope |
| --- | --- | --- |
| Next | Bound, labeled connectors | Flowcharts, force diagrams, and biological pathways. Store endpoint object IDs and anchors so arrows follow moves/resizes. Treat labels as editable data. Requires new binding and export behavior. |
| Next | Personal template library | Save a coordinate system, triangle with labels, or recurring worksheet layout as a reusable set of objects. Build on duplication and validated project serialization, with separate template metadata. |
| Next | Align/distribute and copy style | Arrange solution steps and compare plots consistently. Transfer only applicable style fields; do not copy mathematical content or geometry constraints. Excalidraw's [style actions](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/actions/actionStyles.ts) provide a concrete interaction reference. |
| Later | Frames and focused presentation | Collect a problem and its working into a named area, export that area, and step through explanations. Extend our current A4/infinite modes without pretending a frame is another notebook. |
| Later | Collaboration | Shared cursors, concurrent document changes, recovery, and permission handling form a separate architecture project. Our current browser-local notebooks are not a synchronization backend. |

## What to borrow for AI tool use

Excalidraw exposes a simplified element skeleton that is expanded into complete editable records, including support for arrows and text containers. Its scene API separates reading objects, applying updates, and history capture. This supports our existing direction: let the assistant request typed operations while deterministic code owns rendering, constraints, IDs, and undo. [Programmatic elements](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton), [scene API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api#updatescene).

Suggested future operations are `duplicate_objects`, `connect_objects`, `align_objects`, and `insert_template`. Supply the current selection, object IDs, source expressions, and bounds. Validate the complete operation batch before committing; return the resulting IDs so “move that here” refers to the same objects. Keep camera changes distinct from document changes and expose one-step undo. These are our proposed APIs, not Excalidraw API names.

For more involved diagrams, use a structured intermediate representation with a preview and an editable source. Excalidraw's current [UI source](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/locales/en.json) includes diagram chat, preview/insert, Mermaid editing, and repair messages. That is useful workflow inspiration; the presence of those interfaces does not supply a free hosted AI backend to an embedding app.

The official [Mermaid converter](https://github.com/excalidraw/mermaid-to-excalidraw) outputs Excalidraw-shaped data, so direct reuse would need an adapter for our engine. There is also documentation drift: its [API page](https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api) says only flowcharts become editable objects, while current [converter source](https://github.com/excalidraw/mermaid-to-excalidraw/blob/master/src/graphToExcalidraw.ts) handles flowchart, sequence, class, entity-relationship, and state diagrams, plus an image fallback. Check a pinned package version before promising coverage. Start with our own small node/edge schema after bound connectors exist.

## Commercial reuse

The repository's [MIT license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) permits commercial use, modification, and distribution with the required copyright and permission notice retained in copies or substantial portions. This is a permissive license; it does not require making our independent application source public. If copying implementation code, record the source revision and carry its notice into our distributed notices. Independently implementing an interaction idea is different from copying that code. Any adopted fonts, assets, libraries, or transitive dependencies still need their own license review. No licensing files were changed by this research.
