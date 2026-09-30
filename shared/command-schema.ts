import { z } from 'zod'

const number = z.number().finite().min(-1_000_000).max(1_000_000)
const bounds = z.object({ x: number, y: number, w: z.number().positive().max(100_000), h: z.number().positive().max(100_000) })
// Reported ink/focus extents can be tiny; a requested object rectangle cannot.
const operationBounds = bounds.extend({
  x: number.describe('Left coordinate in board pixels, not normalized vertices or graph units.'),
  y: number.describe('Top coordinate in board pixels, not normalized vertices or graph units.'),
  w: z.number().min(16).max(10_000).describe('Physical object width in board pixels; a normal graph is 440.'),
  h: z.number().min(16).max(10_000).describe('Physical object height in board pixels; a normal graph is 320.'),
})
const id = z.string().max(200)
const vertices = z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(2).max(16)
const crop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(.01).max(1), h: z.number().min(.01).max(1) })
export const optionId = z.enum(['A', 'B', 'C'])
// create_image is made by the app from a resolved insert_library and is never accepted from the model
export const operationSchema = z.object({
  type: z.enum(['create_plot', 'create_math', 'create_text', 'create_geometry', 'update_object', 'edit_content', 'transform_object', 'delete_objects', 'undo', 'redo', 'propose_image', 'insert_library', 'library_action']),
  prompt: z.string().trim().min(1).max(4000).describe('For propose_image only: describe the requested image for user review before generation. This operation never generates or purchases an image.').optional(),
  target: id.describe('Existing object ID for an edit or transform, not for creation. A retained selected ID does not turn a new plot/content request at an empty focus into an edit; omit target on create operations.').optional(), ids: z.array(id).max(2000).optional(),
  placement: z.enum(['focus', 'pointer', 'auto']).describe('focus places content near the reference cue with readable natural dimensions; literal focus mode confines content to its region. Reference mode does not copy the gesture rectangle.').optional(),
  expression: z.string().max(256).describe('Exact graph function or COMPLETE equality, preserving both sides and the variable before =. Examples: vertical line x=1 -> "x=1"; horizontal line y=1 -> "y=1"; circle -> "x^2+y^2=9". Bare "1" means y=1, NEVER x=1. Do not strip x= from a vertical-line request.').optional(), latex: z.string().max(8000).optional(),
  text: z.string().max(12000).optional(), title: z.string().max(200).optional(),
  geometry: z.enum(['triangle', 'right_triangle', 'rectangle', 'ellipse', 'arrow', 'polygon', 'polyline']).optional(),
  vertices: vertices.describe('Custom polygon/polyline coordinates normalized into 0..1, listed in boundary order. Polygon closes automatically. For specified convex interior angles use angles instead; do not invent approximate vertices.').optional(),
  angles: z.array(z.number().positive().lt(180)).min(3).max(16).describe('Convex polygon interior angles in degrees, boundary order; sum must be (n-2)*180. The board constructs exact geometry. Example four sides: [91,91,90,88].').optional(),
  sides: z.number().int().min(3).max(16).describe('Number of sides for a regular polygon when no explicit angles or vertices are supplied.').optional(),
  fill: z.string().max(40).describe('Geometry fill color, hex or named; none makes it transparent.').optional(),
  fillOpacity: z.number().min(0).max(1).optional(), strokeWidth: z.number().min(.25).max(24).optional(),
  opacity: z.number().min(0).max(1).describe('Whole-object opacity.').optional(),
  layer: z.enum(['front', 'back']).describe('Use update_object with an explicit target to bring that object to front or send it to back. Keep content, dimensions, and locked objects unchanged.').optional(),
  showGrid: z.boolean().optional(), showAxes: z.boolean().optional(),
  crop: crop.describe('Images only: reversible viewport over source image, normalized x,y,width,height. x+w and y+h must not exceed1. Full image is {x:0,y:0,w:1,h:1}.').optional(),
  color: z.string().max(40).optional(), xMin: number.optional(), xMax: number.optional(),
  yMin: number.optional(), yMax: number.optional(),
  fitY: z.boolean().describe('Plots only: fit the Y window to y=f(x) over its current or requested X domain. Use update_object with fitY:true for fit curve, show the bottom/vertex, or normalize the window; no physical resize. Switches to independent axes. Explicit yMin/yMax take precedence. For implicit equations choose explicit axis ranges instead.').optional(),
  axisMode: z.enum(['equal', 'auto']).describe('For plots: equal makes one x unit and one y unit the same physical size (square units, even scaling, undistorted graph); auto fits axes independently. On a fresh graph request, include this property on create_plot; it does not turn creation into an edit. Use update_object only when changing an existing plot, never uniform object scale. Omit for new plots unless the user explicitly requests an axis mode; the board supplies its default.').optional(),
  bounds: operationBounds.describe('Physical canvas rectangle in BOARD PIXELS, never normalized 0..1 vertices or mathematical graph coordinates. Example {x:100,y:100,w:440,h:320}. Width and height must each be 16..10000. Use for a user-requested dimension/coordinate change or spatial arrangement such as side by side. For an explicit arrangement give each object distinct, nonoverlapping bounds with readable dimensions. OMIT for ordinary creation near a reference cue; use placement:focus and let the board choose natural dimensions. Do not copy bounds from a reference gesture. Literal focus mode still enforces the region.').optional(),
  rotation: number.optional(), rotateBy: number.optional(),
  scale: z.number().positive().max(100).describe('Uniform physical object resize only. This does NOT equalize x/y graph units or undo distorted axis scaling; use axisMode:equal for that.').optional(),
  dx: number.optional(), dy: number.optional(),
  fitFocus: z.boolean().describe('Fit within the literal focus region. Do not infer this from a reference gesture; reference mode permits natural dimensions beyond the cue.').optional(),
  fontSize: z.number().positive().max(200).optional(), followPointer: z.boolean().optional(),
  field: z.enum(['latex', 'text', 'expression']).describe('For edit_content, the source field being edited.').optional(),
  start: z.number().int().min(0).max(12000).describe('For edit_content: inclusive UTF-16 source offset; use only confirmed source offsets, never MathLive atom positions.').optional(),
  end: z.number().int().min(0).max(12000).describe('For edit_content: exclusive UTF-16 source offset. start=end inserts without removing anything.').optional(),
  replacement: z.string().max(12000).describe('For edit_content: ONLY the new fragment, not the entire updated source. With start/end, replaces that range. With no range/find, APPENDS to existing source. Example existing x^2, spoken plus three: replacement must be +3, NOT x^2+3. For a full rewritten source instead use update_object with latex/text/expression.').optional(),
  find: z.string().max(12000).describe('For edit_content: a literal substring occurring exactly once in the current source. No regular expressions.').optional(),
  replace: z.string().max(12000).describe('For edit_content with find: the replacement for that substring only. Empty string deletes it.').optional(),
  page: z.string().max(16).describe('insert_library: the PRINTED page number exactly as the teacher says it, like "22" or "xii". Never a file page count.').optional(),
  item: z.string().max(60).describe('insert_library: a numbered item with its kind word, like "problem 3.2", "example 3.12", "exercise 48", "checkpoint 3.26", "theorem 2.1", "section 3.2". A bare number like "3.2" is allowed. Keep a section or chapter the teacher names, like "exercise 48 in section 5.1".').optional(),
  query: z.string().max(300).describe('insert_library: a few words describing an item that has no number given, like "chain rule example". Omit when page or item is known.').optional(),
  book: z.string().max(200).describe('insert_library or library_action: a book title from library.books. Only when the teacher names a book; the open book is the default.').optional(),
  action: z.enum(['open_book', 'close_reference', 'store_import', 'board_import', 'pick']).describe('library_action only: open_book opens a book beside the board, close_reference closes it, store_import saves the waiting PDF (library.pendingImport) to the library, board_import puts it on the board, pick inserts one of the matches in library.highlights (set index).').optional(),
  index: z.number().int().min(1).max(3).describe('library_action pick only: the number of the highlighted match, 1 for the first title in library.highlights.').optional(),
  placementOption: optionId.describe('Pick one of context.placementOptions (A is the best free area) for a new object when there is no focus. Omit bounds and placement when you set it.').optional(),
})
export const commandSchema = z.object({ operations: z.array(operationSchema).max(12), message: z.string().max(1000) })
