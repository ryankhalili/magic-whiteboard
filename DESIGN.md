# Doodle Desk

Doodle Desk is a drawing and learning workspace for sketches, equations, graphs, worksheets, and spoken instructions. The canvas is the primary work surface. A new user should be able to start drawing without setup; assistant features remain available beside manual tools.

## Workspace organization

- Title bar: product name, editable notebook title, and local save status.
- Action bar: notebook/file actions on the left; library, image generation, voice, and help on the right.
- Toolbox: drawing, selection, writing, erasing, panning, and stroke width.
- Canvas: paper and work-area settings, contextual object controls, and assistant input.
- Palette and status bar: ink colors, object count, undo/redo, and zoom.

Keep notebook storage keys, the canvas schema identifier, and `.marginalia.json` files compatible. Display names can change independently of stored data.

The organization follows the project-context, focused-design, and browser-review workflow described in [Impeccable's getting started guide](https://impeccable.style/tutorials/getting-started/). The supplied vintage Paint image establishes the visual direction; the documentation page is a workflow reference.

## Vintage Paint finish

Use Tahoma/Verdana for controls and Courier New for the welcome message. Muted blue-gray chrome (`#c3cfd4`), a darker blue title bar (`#44677d`), square beveled controls, an inset canvas, and a two-row ink palette recall early desktop drawing software. Warm paper-colored details and subdued pink, yellow, mint, and lavender inks soften the utilitarian frame.

Keep the canvas legible and free of decorative textures. Retro borders belong to the interface, never to exported artwork. Use real actions instead of decorative window buttons. Selected tools and colors have pressed states; all controls retain visible keyboard focus and accessible names. The toolbox becomes a single column on narrow screens. Respect reduced motion and use local system fonts.
