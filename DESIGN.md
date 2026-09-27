# Chalk Pal

Chalk Pal is a drawing and learning workspace for sketches, equations, graphs, worksheets, and spoken instructions. The canvas is the primary work surface. A new user should be able to start drawing without setup; assistant features remain available beside manual tools.

## Workspace organization

- Title bar: product name, editable notebook title, and local save status.
- Action bar: notebook/file actions on the left; library, image generation, voice, and help on the right.
- Toolbox: drawing, selection, writing, erasing, panning, and stroke width.
- Canvas: paper and work-area settings, contextual object controls, and assistant input.
- Palette and status bar: ink colors, object count, undo/redo, and zoom.

Keep notebook storage keys, the canvas schema identifier, and `.marginalia.json` files compatible. Display names can change independently of stored data.

The organization follows the project-context, focused-design, and browser-review workflow described in [Impeccable's getting started guide](https://impeccable.style/tutorials/getting-started/). The documentation page is a workflow reference.

## Visual direction

Use a clean, canvas-first interface: white surfaces, restrained blue accents, clear sans-serif typography, subtle borders, and rounded controls. Avoid vintage desktop frames, beveled edges, pixel art, and decorative textures. Group related actions and keep contextual controls near the work.

Selected tools and colors retain clear states and visible keyboard focus. Preserve the mobile toolbar and status-bar fixes. Keep all ink colors available through compact circular swatches, with a single current-color indicator. Respect reduced motion and use local system fonts.
