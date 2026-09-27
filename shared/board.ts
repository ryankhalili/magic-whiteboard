export type Bounds = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }
export type Focus = { kind: 'point' | 'region'; bounds: Bounds; targetIds: string[] }
export type FocusMode = 'reference' | 'literal'
export type AxisMode = 'equal' | 'auto'
export type AxisRange = { xMin: number; xMax: number; yMin: number; yMax: number }
export type ContentField = 'latex' | 'text' | 'expression'
export type ContentSelection = {
  shapeId: string; objectId?: string; field: ContentField; start?: number; end?: number; text?: string;
  coordinateSpace?: 'text' | 'mathlive'
}
export type DictationMode = 'assistant' | 'math' | 'text'
export type BoardObject = {
  id: string; kind: string; bounds: Bounds; rotation: number;
  expression?: string; latex?: string; text?: string; title?: string;
  xMin?: number; xMax?: number; yMin?: number; yMax?: number;
  axisMode?: AxisMode; displayedRange?: AxisRange;
  color?: string; geometry?: string; locked?: boolean; fontSize?: number
}
export type BoardContext = {
  focus: Focus | null; pointer: Point | null; selectedIds: string[];
  lastCreatedIds: string[]; viewport: Bounds; objects: BoardObject[];
  gesture?: { active: boolean; bounds: Bounds; start: Point; current: Point } | null;
  contentSelection?: ContentSelection | null; dictationMode?: DictationMode; focusMode?: FocusMode
}
export type BoardOperation = {
  type: 'create_plot' | 'create_math' | 'create_text' | 'create_geometry' | 'update_object' | 'edit_content' | 'transform_object' | 'delete_objects' | 'undo' | 'redo';
  target?: string; ids?: string[]; placement?: 'focus' | 'pointer' | 'auto';
  expression?: string; latex?: string; text?: string; title?: string;
  geometry?: 'triangle' | 'right_triangle' | 'rectangle' | 'ellipse' | 'arrow';
  color?: string; xMin?: number; xMax?: number; yMin?: number; yMax?: number;
  axisMode?: AxisMode;
  bounds?: Bounds; rotation?: number; rotateBy?: number; scale?: number;
  dx?: number; dy?: number; fitFocus?: boolean; fontSize?: number;
  followPointer?: boolean;
  field?: ContentField; start?: number; end?: number; replacement?: string; find?: string; replace?: string
}
export type BoardResult = { ok: boolean; message: string; ids: string[]; objects?: BoardObject[] }
export type BoardCommand = { operations: BoardOperation[]; message: string }
export type AppSettings = { name: string; paper: 'dots' | 'grid' | 'plain' | 'ruled'; mode: 'infinite' | 'page'; backgroundColor: string; focusMode?: FocusMode }
export const DEFAULT_SETTINGS: AppSettings = { name: 'Untitled notebook', paper: 'plain', mode: 'infinite', backgroundColor: '#ffffff', focusMode: 'reference' }
