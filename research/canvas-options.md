# Canvas and fork options

Research date: 2026-09-26.

**Recommended primary foundation: tldraw SDK and its Agent Starter Kit, conditional on accepting its production license requirements.** Use **Excalidraw as the MIT-licensed alternative** when permissive open-source licensing is essential. These recommendations are engineering judgments based on the documented extension interfaces; no comparative device benchmark was performed.

| Foundation | Useful starting point | License and practical caveat | Fit for this project |
| --- | --- | --- | --- |
| tldraw SDK + Agent Starter Kit | Infinite canvas; custom React shapes; agent context includes selection/regions, screenshots, shape data and history; tools manipulate canvas objects. | SDK is source available, explicitly not open source. Production requires a valid trial, commercial or discretionary noncommercial hobby key. The documented trial is 100 days. | Strongest hackathon route for editable graphs, math objects and spatial voice commands. |
| Excalidraw | React whiteboard with freehand drawing, shapes, images, undo, zoom/pan, JSON persistence and SVG/PNG export. | MIT. Rich plots/equations need an added semantic model and rendering integration. Collaboration in the hosted app is separate from the editor package. | Best permissively licensed alternative. |
| BlockSuite / AFFiNE | Page and edgeless editors sharing rich text and collaborative data; promising for eventual board-to-document workflows. | Standalone BlockSuite README specifies MPL-2.0. AFFiNE has mixed licensing: much client code is MIT, while backend/native directories have separate terms. A larger framework and product surface to learn. | Better when document authoring and collaboration dominate the product. |
| AppFlowy | Existing Flutter/Rust workspace, desktop/mobile clients and document infrastructure. | AGPLv3. Primarily a Notion-style workspace; whiteboard ink and mathematical objects would require substantial new work. | Less direct route to the spatial pen interaction. |
| Rnote | Pen-oriented vector notebook with pressure sensitivity, selection/rotation, PDF import/export and infinite/page layouts. | GPL-3.0-or-later; Rust/GTK4. Documented platforms are Linux, macOS and Windows. | Useful interaction reference; unattractive iPad fork. |
| Xournal++ | Mature desktop handwriting/PDF annotation, LaTeX insertion, audio and Lua plugins. | GPL-2.0; C++/GTK. Official README says mobile development stalled and the iOS app is unreleased. | Useful desktop reference, poor route to the requested iPad product. |

## Reuse that directly matches the idea

The [tldraw Agent Starter Kit](https://tldraw.dev/starter-kits/agent) already combines spatial selection with screenshots and structured shape data. It supports canvas actions and extension for custom shapes. [Custom shapes](https://tldraw.dev/examples/custom-shape) can store their own properties and render React content, making persistent mathematical objects a natural extension.

The official [tldraw PDF editor example](https://tldraw.dev/examples/pdf-editor) renders PDF pages using `pdfjs-dist` as locked canvas images, then uses `pdf-lib` to stamp annotations onto the original PDF. This is a useful first version of homework import, annotation and export. It does not establish that advanced searchable or vector annotation workflows are already solved.

## Application design recommendation

Store `MathShape`, `PlotShape`, `TextShape`, `InkShape` and `PdfPageShape` as persistent objects with stable IDs. A plot stores its expression and domain separately from its rendered appearance. Then “make it +3” updates the selected plot's expression, while “0 to 10” updates its domain. Keep this semantic data when exporting or saving the editable notebook.

Start with a small tool set: `create_math`, `create_plot`, `update_plot`, `transform_selection` and `convert_ink`. The magic-pen gesture sets region bounds and target IDs, with a temporary visible highlight. Pass those targets into the voice request as explicit context. The project's distinctive work is attention selection, conversation targeting, mathematical object schemas and editing UX.

## Licensing nuance

The [tldraw license page](https://tldraw.dev/community/license) explicitly says that the SDK is source available rather than open source, and production requires an active license key. The overview/repository currently has inconsistent descriptions of starter code licensing. Some text describes starter code as MIT, while other text says starters use the SDK license. Regardless of starter source licensing, the SDK production-key requirement still applies. Do not describe the complete proposed tldraw stack as MIT or unconditionally free to deploy.

[AFFiNE's root license](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/LICENSE) routes backend and native-directory code to [separate backend terms](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/packages/backend/server/LICENSE). Those terms distinguish Community Edition content and Enterprise Edition content. Avoid treating the entire repository as uniformly MIT.

## Primary sources

- [tldraw Agent Starter Kit](https://tldraw.dev/starter-kits/agent)
- [tldraw custom shapes](https://tldraw.dev/examples/custom-shape)
- [tldraw SDK license](https://tldraw.dev/community/license)
- [tldraw PDF editor example](https://tldraw.dev/examples/pdf-editor)
- [Excalidraw README](https://github.com/excalidraw/excalidraw/blob/master/README.md?plain=1)
- [Excalidraw MIT license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)
- [Excalidraw programmatic editor API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api)
- [BlockSuite README and license identification](https://raw.githubusercontent.com/toeverything/blocksuite/main/README.md)
- [AFFiNE repository](https://github.com/toeverything/AFFiNE)
- [AFFiNE root license](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/LICENSE)
- [AFFiNE backend license](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/packages/backend/server/LICENSE)
- [AppFlowy repository](https://github.com/AppFlowy-IO/AppFlowy)
- [Rnote repository](https://github.com/flxzt/rnote)
- [Xournal++ README](https://github.com/xournalpp/xournalpp/blob/master/README.md)
