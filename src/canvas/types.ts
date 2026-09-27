import type { Bounds, Point, GeometryKind, ImageCrop } from '../../shared/board'

export type TLShapeId = string
export type TLAssetId = string
export type MagicShapeProps = {
  w: number; h: number; kind: 'plot' | 'math' | 'text' | 'geometry'; expression: string; latex: string;
  text: string; title: string; color: string; xMin: number; xMax: number; yMin: number; yMax: number;
  geometry: GeometryKind; fontSize: number;
  vertices?: Point[]; angles?: number[]; sides?: number;
  fill?: string; fillOpacity?: number; strokeWidth?: number; showGrid?: boolean; showAxes?: boolean
}
export type StrokePoint = Point & { z?: number; pressure?: number }
export type DrawProps = {
  points: StrokePoint[]; w?: number; h?: number; color: string; size: 's' | 'm' | 'l' | 'xl' | number;
  strokeWidth?: number; segments?: Array<{ type?: string; points: StrokePoint[] }>;
  [key: string]: unknown
}
export type ImageProps = { assetId: string | null; w: number; h: number; altText?: string; crop?: ImageCrop; [key: string]: unknown }
export type LegacyProps = { w?: number; h?: number; color?: string; text?: string; [key: string]: unknown }
export interface ShapePropsMap {
  magic: MagicShapeProps; draw: DrawProps; image: ImageProps; group: Record<string, never>;
  geo: LegacyProps; text: LegacyProps
}
export type ShapeKind = keyof ShapePropsMap
export type TLShape<K extends ShapeKind = ShapeKind> = K extends ShapeKind ? {
  id: TLShapeId; typeName: 'shape'; type: K; x: number; y: number; rotation: number;
  parentId: string; index: string | number; isLocked: boolean; opacity: number;
  props: ShapePropsMap[K]; meta: Record<string, unknown>
} : never
export type TLImageShape = TLShape<'image'>
export type TLDrawShape = TLShape<'draw'>
export type TLShapePartial<S extends TLShape = TLShape> = S extends TLShape ?
  Pick<S, 'id' | 'type'> & Partial<Omit<S, 'id' | 'type' | 'props'>> & { props?: Partial<S['props']> } : never
export type TLCreateShapePartial<S extends TLShape = TLShape> = S extends TLShape ?
  Pick<S, 'type'> & Partial<Omit<S, 'type' | 'props'>> & { props?: Partial<S['props']> } : never
export type AssetRecord = {
  id: string; typeName: 'asset'; type: 'image'; meta: Record<string, unknown>;
  props: { src: string; name?: string; w: number; h: number; mimeType?: string; isAnimated?: boolean; [key: string]: unknown }
}
export type PageRecord = { id: string; typeName: 'page'; name: string; index?: string | number; meta?: Record<string, unknown> }
export type DocumentRecord = TLShape | AssetRecord | PageRecord | { id: string; typeName: string; [key: string]: unknown }
export type Camera = { x: number; y: number; z: number }
export type TLEditorSnapshot = {
  document: { schema: Record<string, unknown>; store: Record<string, DocumentRecord> };
  session?: { currentPageId?: string; camera?: Camera; selectedShapeIds?: string[]; [key: string]: unknown }
}
export type ImageExportOptions = {
  format?: 'png'; bounds?: Bounds; padding?: number; background?: boolean;
  pixelRatio?: number; scale?: number; darkMode?: boolean
}
export type ImageExportResult = { blob: Blob; width?: number; height?: number }
