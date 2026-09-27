import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types'
import type { Editor } from './editor'
import { Box, colorValue, getStrokeWidth, strokePoints } from './geometry'
import { shapeOpacity } from './content'
import { cropFromNative, cropToNative } from './imageCrop'
import { disconnectedInkBounds, isDisconnectedInk, resizeDisconnectedInk } from './disconnectedInk'
import { validateNativeSceneImport } from './nativeImportValidation'
import type { AssetRecord, TLCreateShapePartial, TLShape, TLShapePartial } from './types'

type Point = { x: number; y: number }
type SceneMetadata = { schemaVersion: 1; shape: TLShape; offset: Point }
export type ExcalidrawScene = { elements: ExcalidrawElement[]; files: BinaryFiles }
export type EditorSceneChanges = { creates: TLCreateShapePartial[]; updates: TLShapePartial[]; deletes: string[]; assets: AssetRecord[] }
export const LIVE_CONTENT_FILE_ID = '__magic_whiteboard_live_content__'
const liveContentFile: BinaryFileData = {
  id: LIVE_CONTENT_FILE_ID as BinaryFileData['id'], mimeType: 'image/svg+xml', created: 1,
  dataURL: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==' as BinaryFileData['dataURL'],
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const rotate = (p: Point, angle: number): Point => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const near = (a: number, b: number) => Math.abs(a - b) < 1e-7
const keepNumber = (value: number, previous: number | undefined) => previous !== undefined && near(value, previous) ? previous : value
const angleNear = (a: number, b: number) => near(Math.sin(a), Math.sin(b)) && near(Math.cos(a), Math.cos(b))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const supportedShapes = new Set(['magic', 'draw', 'image', 'geo', 'text'])

function metadata(element: ExcalidrawElement): SceneMetadata | undefined {
  const value = element.customData?.magicWhiteboard as SceneMetadata | undefined
  return value?.schemaVersion === 1 && value.shape && supportedShapes.has(value.shape.type) ? value : undefined
}

function ancestorIds(editor: Editor, shape: TLShape): string[] {
  const ids: string[] = [], seen = new Set([shape.id])
  let parent = editor.getShape(shape.parentId)
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id); ids.push(parent.id); parent = editor.getShape(parent.parentId)
  }
  return ids
}

function shapeGroupIds(editor: Editor, shape: TLShape): string[] {
  const extra = Array.isArray(shape.meta.excalidrawGroupIds) ? shape.meta.excalidrawGroupIds.filter((id): id is string => typeof id === 'string') : []
  return [...new Set([...extra, ...ancestorIds(editor, shape)])]
}

function pointBounds(points: readonly (readonly number[])[]): Box {
  return Box.From(points.filter(p => finite(p[0]) && finite(p[1])).map(p => ({ x: p[0], y: p[1] })))
}

function elementCenter(element: ExcalidrawElement): Point {
  return element.type === 'freedraw' || element.type === 'line' || element.type === 'arrow'
    ? pointBounds(element.points).center : { x: element.width / 2, y: element.height / 2 }
}

function stableSeed(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return hash >>> 1
}

/** Construct elements without importing Excalidraw's DOM-dependent runtime. */
function shapeToElement(editor: Editor, shape: TLShape, previous?: ExcalidrawElement, renderedFile?: Pick<BinaryFileData, 'id'>): ExcalidrawElement {
  const matrix = editor.getShapePageTransform(shape), angle = Math.atan2(matrix.b, matrix.a)
  const props = shape.props as { w?: number; h?: number; color?: string }
  const native = shape.meta.excalidrawElement as ExcalidrawElement | undefined
  let offset: Point = { x: 0, y: 0 }, center: Point = { x: (props.w ?? 100) / 2, y: (props.h ?? 100) / 2 }
  let width = props.w ?? 100, height = props.h ?? 100
  let drawing: Pick<ExcalidrawFreeDrawElement, 'points' | 'pressures' | 'simulatePressure' | 'lastCommittedPoint'> | undefined
  if (isDisconnectedInk(shape)) {
    const bounds = disconnectedInkBounds(shape)
    offset = { x: bounds.x, y: bounds.y }
    width = bounds.w; height = bounds.h; center = { x: width / 2, y: height / 2 }
  } else if (shape.type === 'draw') {
    const points = strokePoints(shape.props)
    offset = points[0] ? { x: points[0].x, y: points[0].y } : offset
    const local = (points.length ? points : [{ x: 0, y: 0 }]).map(p => [p.x - offset.x, p.y - offset.y]) as unknown as ExcalidrawFreeDrawElement['points']
    const bounds = pointBounds(local)
    center = bounds.center; width = bounds.w; height = bounds.h
    drawing = { points: local, pressures: points.map(p => clamp(p.pressure ?? p.z ?? .5, 0, 1)), simulatePressure: shape.props.simulatePressure === true, lastCommittedPoint: null }
  }
  const worldCenter = matrix.applyToPoint({ x: offset.x + center.x, y: offset.y + center.y })
  const common = {
    id: shape.id, x: worldCenter.x - center.x, y: worldCenter.y - center.y, width, height,
    angle: angle as ExcalidrawElement['angle'], strokeColor: colorValue(props.color ?? 'black'), backgroundColor: 'transparent',
    fillStyle: 'solid' as const, strokeWidth: shape.type === 'draw' ? getStrokeWidth(shape.props) : 0,
    strokeStyle: 'solid' as const, roundness: null, roughness: 0, opacity: clamp(shapeOpacity(editor, shape) * 100, 0, 100),
    seed: previous?.seed ?? stableSeed(shape.id), version: previous?.version ?? 1, versionNonce: previous?.versionNonce ?? 0,
    index: previous?.index ?? null, isDeleted: false, groupIds: shapeGroupIds(editor, shape), frameId: null,
    boundElements: null, updated: previous?.updated ?? 1, link: null, locked: editor.isShapeOrAncestorLocked(shape),
    customData: { ...previous?.customData, magicWhiteboard: { schemaVersion: 1, shape, offset } satisfies SceneMetadata },
  }
  let element: ExcalidrawElement
  if (drawing && native && (native.type === 'line' || native.type === 'arrow')) element = {
    ...native, ...common, type: native.type, points: drawing.points,
    backgroundColor: native.backgroundColor, fillStyle: native.fillStyle, roughness: native.roughness,
    roundness: native.roundness, strokeStyle: native.strokeStyle,
  }
  else if (drawing) element = { ...common, type: 'freedraw', ...drawing }
  else if (shape.type === 'image') element = {
    ...common, type: 'image', fileId: shape.props.assetId as BinaryFileData['id'] | null,
    status: 'saved', scale: Array.isArray(shape.props.excalidrawScale) ? shape.props.excalidrawScale as [number, number] : [1, 1],
    crop: cropToNative(shape.props, editor.getAsset(shape.props.assetId)?.props.w ?? shape.props.w, editor.getAsset(shape.props.assetId)?.props.h ?? shape.props.h),
  }
  else if (native && native.id === shape.id && !isDisconnectedInk(shape)) {
    // Native clipboard shapes retain their original rendering and extra fields across save/reload.
    element = { ...native, ...common, type: native.type, strokeWidth: native.strokeWidth, backgroundColor: native.backgroundColor, fillStyle: native.fillStyle, roughness: native.roughness, roundness: native.roundness, strokeStyle: native.strokeStyle } as ExcalidrawElement
    if (element.type === 'text' && shape.type === 'text') element = { ...element, text: shape.props.text ?? '', originalText: shape.props.text ?? '', fontSize: Number(shape.props.fontSize) || element.fontSize }
  }
  else element = { ...common, type: 'image', fileId: renderedFile?.id ?? liveContentFile.id, status: 'saved', scale: [1, 1], crop: null }
  if (!previous) return element
  // Excalidraw increments versions itself during a gesture. Preserve its exact element when no
  // application data changed so React effects cannot turn onChange into a synchronization loop.
  if (same(element, previous)) return previous
  return { ...element, version: previous.version + 1, versionNonce: (previous.versionNonce + 1) >>> 0, updated: previous.updated + 1 }
}

export function editorToExcalidrawScene(editor: Editor, previousElements: readonly ExcalidrawElement[] = [], renderedFiles: ReadonlyMap<string, BinaryFileData> = new Map()): ExcalidrawScene {
  const previous = new Map(previousElements.map(element => [element.id, element])), files: BinaryFiles = {}
  const elements = editor.getCurrentPageShapesSorted().filter(shape => shape.type !== 'group').map(shape => {
    if (shape.type === 'image' && shape.props.assetId) {
      const asset = editor.getAsset(shape.props.assetId)
      if (asset?.props.src) files[asset.id] = {
        id: asset.id as BinaryFileData['id'], dataURL: asset.props.src as BinaryFileData['dataURL'],
        mimeType: (asset.props.mimeType ?? asset.props.src.match(/^data:([^;,]+)/)?.[1] ?? 'image/png') as BinaryFileData['mimeType'], created: 1,
      }
    }
    const renderedFile = renderedFiles.get(shape.id)
    const element = shapeToElement(editor, shape, previous.get(shape.id), renderedFile)
    if (element.type === 'image' && element.fileId === LIVE_CONTENT_FILE_ID) files[LIVE_CONTENT_FILE_ID] = liveContentFile
    else if (element.type === 'image' && renderedFile && element.fileId === renderedFile.id) files[renderedFile.id] = renderedFile
    return element
  })
  return { elements, files }
}

function defaultShape(element: ExcalidrawElement, pageId: string): TLShape | undefined {
  const base = { id: element.id, typeName: 'shape' as const, x: 0, y: 0, rotation: 0, parentId: pageId, index: 0, isLocked: false, opacity: 1, meta: {} }
  if (element.type === 'freedraw' || element.type === 'line' || element.type === 'arrow') return { ...base, type: 'draw', props: { points: [], color: element.strokeColor, size: element.strokeWidth } }
  if (element.type === 'image') return element.fileId === LIVE_CONTENT_FILE_ID ? undefined : { ...base, type: 'image', props: { w: element.width, h: element.height, assetId: element.fileId } }
  if (element.type === 'text') return { ...base, type: 'text', props: { w: element.width, h: element.height, text: element.text, color: element.strokeColor, fontSize: element.fontSize } }
  if (element.type === 'selection') return undefined
  return { ...base, type: 'geo', props: { w: element.width, h: element.height, color: element.strokeColor, geo: element.type, fill: element.backgroundColor === 'transparent' ? 'none' : 'solid' } }
}

function shapeFromElement(editor: Editor, element: ExcalidrawElement): TLShape | undefined {
  if (![element.x, element.y, element.width, element.height, element.angle, element.opacity].every(finite) || element.width < 0 || element.height < 0) return undefined
  const existing = editor.getShape(element.id), data = metadata(element)
  const source = existing ?? data?.shape ?? defaultShape(element, editor.getCurrentPageId())
  if (!source || source.type === 'group') return undefined
  if (existing) {
    const canonical = shapeToElement(editor, existing, element, element.type === 'image' && element.fileId ? { id: element.fileId } : undefined)
    const presentation = (value: ExcalidrawElement) => {
      const { version: _version, versionNonce: _nonce, updated: _updated, customData: _data, index: _index, ...rest } = value
      return rest
    }
    if (same(presentation(canonical), presentation(element))) return { ...existing }
  }
  const originalAncestors = existing ? ancestorIds(editor, existing) : []
  // Existing legacy groups stay as transform parents while Excalidraw still groups the leaf.
  // Ungrouped or duplicated leaves move to page coordinates instead of retaining a stale parent.
  const keepParent = !!existing && originalAncestors.every(id => element.groupIds.includes(id))
  const parentId = keepParent ? source.parentId : editor.getCurrentPageId()
  const parent = keepParent ? editor.getShapeParentTransform(source) : null
  const parentAngle = parent ? Math.atan2(parent.b, parent.a) : 0
  const center = elementCenter(element), rotatedCenter = rotate(center, element.angle)
  const offset = data?.offset ?? { x: 0, y: 0 }, rotatedOffset = rotate(offset, element.angle)
  const worldOrigin = { x: element.x + center.x - rotatedCenter.x - rotatedOffset.x, y: element.y + center.y - rotatedCenter.y - rotatedOffset.y }
  const localOrigin = parent ? parent.clone().invert().applyToPoint(worldOrigin) : worldOrigin
  let parentOpacity = 1
  if (parentId !== editor.getCurrentPageId()) {
    const parentShape = editor.getShape(parentId)
    if (parentShape) parentOpacity = shapeOpacity(editor, parentShape)
  }
  const angle = element.angle - parentAngle
  const meta = { ...source.meta }, groups = element.groupIds.filter(id => !keepParent || !originalAncestors.includes(id))
  if (groups.length) meta.excalidrawGroupIds = [...groups]
  else delete meta.excalidrawGroupIds
  if (!data && element.type !== 'freedraw' && element.type !== 'image') {
    const { customData: _customData, ...native } = element
    meta.excalidrawElement = native
  } else if (meta.excalidrawElement) {
    const { customData: _customData, ...native } = element
    meta.excalidrawElement = native
  }
  const next = {
    ...source, id: element.id, parentId, meta,
    x: keepNumber(localOrigin.x, existing?.x), y: keepNumber(localOrigin.y, existing?.y),
    rotation: existing && angleNear(angle, existing.rotation) ? existing.rotation : angle,
    opacity: parentOpacity === 0 ? source.opacity : keepNumber(clamp(element.opacity / 100 / parentOpacity, 0, 1), existing?.opacity),
    isLocked: existing && editor.isShapeOrAncestorLocked(existing.parentId) ? existing.isLocked : element.locked,
  } as TLShape
  if (next.type === 'draw' && isDisconnectedInk(next) && element.type === 'image') {
    // Use the gesture's original metadata instead of progressively rescaling
    // the last onChange result. This also prevents repeated flip events from
    // toggling the stored paths back and forth before the next scene push.
    const baseline = data?.shape && isDisconnectedInk(data.shape) ? data.shape : next
    next.props = resizeDisconnectedInk(baseline, element.width, element.height, element.scale)
  } else if (next.type === 'draw' && (element.type === 'freedraw' || element.type === 'line' || element.type === 'arrow')) {
    const previousPoints = strokePoints(next.props)
    const points = element.points.map((p, index) => {
      const old = previousPoints[index]
      const pressure = element.type === 'freedraw' ? element.pressures[index] ?? .5 : .5
      const x = keepNumber(p[0] + offset.x, old?.x), y = keepNumber(p[1] + offset.y, old?.y)
      if (old && x === old.x && y === old.y && near(pressure, old.pressure ?? old.z ?? .5)) return old
      return { x, y, z: pressure }
    })
    const pointsUnchanged = same(points, previousPoints)
    next.props = { ...next.props, points, color: colorValue(next.props.color) === element.strokeColor ? next.props.color : element.strokeColor, strokeWidth: element.strokeWidth }
    if (!pointsUnchanged && next.props.segments) next.props.segments = [{ type: 'free', points }]
    if (element.type === 'freedraw' && (element.simulatePressure || next.props.simulatePressure !== undefined)) next.props.simulatePressure = element.simulatePressure
    // Do not add explicit values to old shapes when their effective values already match.
    if (source.type === 'draw' && source.props.strokeWidth === undefined && near(getStrokeWidth(source.props), element.strokeWidth)) delete next.props.strokeWidth
    if (next.props.w !== undefined) next.props.w = element.width
    if (next.props.h !== undefined) next.props.h = element.height
  } else if (next.type !== 'draw') {
    next.props = { ...next.props, w: keepNumber(element.width, (source.props as { w?: number }).w), h: keepNumber(element.height, (source.props as { h?: number }).h) }
    if (next.type === 'image' && element.type === 'image') {
      next.props.assetId = element.fileId
      if (element.scale[0] !== 1 || element.scale[1] !== 1 || next.props.excalidrawScale) next.props.excalidrawScale = [...element.scale]
      if (element.crop || next.props.crop || next.props.excalidrawCrop) next.props.crop = element.crop ? cropFromNative(element.crop) : { x: 0, y: 0, w: 1, h: 1 }
      delete next.props.excalidrawCrop
    }
    if (next.type === 'text' && element.type === 'text') next.props = { ...next.props, text: element.text, fontSize: element.fontSize, color: element.strokeColor }
  }
  return next
}

/** Returns the source object, with the live element's dimensions during resize or duplication. */
export function getShapeForExcalidrawElement(editor: Editor, element: ExcalidrawElement): TLShape | undefined {
  return shapeFromElement(editor, element)
}

/** A pure diff. The caller owns gesture/history boundaries and applies it in one editor.run(). */
export function sceneToEditorChanges(editor: Editor, elements: readonly ExcalidrawElement[], files: BinaryFiles = {}): EditorSceneChanges {
  validateNativeSceneImport(editor, elements, files)
  const changes: EditorSceneChanges = { creates: [], updates: [], deletes: [], assets: [] }
  const live = elements.filter(element => !element.isDeleted), liveIds = new Set(live.map(element => element.id))
  const current = editor.getCurrentPageShapesSorted().filter(shape => shape.type !== 'group')
  // Leave a locked source intact even if a malformed or stale scene omitted it.
  changes.deletes = current.filter(shape => !liveIds.has(shape.id) && !editor.isShapeOrAncestorLocked(shape)).map(shape => shape.id)
  const survivingCurrentIds = current.filter(shape => liveIds.has(shape.id)).map(shape => shape.id)
  // A new stroke appends naturally, but Excalidraw inserts duplicates immediately above their
  // source. Assign that stacking order in this same edit; otherwise the following onChange would
  // need a second document update solely to move the duplicate back into its native position.
  const appendedNewIds = live.filter(element => !editor.getShape(element.id)).map(element => element.id)
  const reordered = !same([...survivingCurrentIds, ...appendedNewIds], live.map(element => element.id))
  let nextIndex = Math.max(0, ...current.map(shape => typeof shape.index === 'number' ? shape.index : 0))
  for (const [index, element] of live.entries()) {
    const existing = editor.getShape(element.id)
    if (existing && editor.isShapeOrAncestorLocked(existing)) continue
    const shape = shapeFromElement(editor, element)
    if (!shape) continue
    if (reordered) shape.index = index + 1
    else if (!existing) shape.index = ++nextIndex
    if (existing) { if (!same(shape, existing)) changes.updates.push(shape as TLShapePartial) }
    else changes.creates.push(shape as TLCreateShapePartial)
    if (shape.type === 'image' && shape.props.assetId) {
      const file = files[shape.props.assetId], asset = editor.getAsset(shape.props.assetId)
      if (file && file.dataURL !== asset?.props.src && !changes.assets.some(item => item.id === file.id)) changes.assets.push({
        id: file.id, typeName: 'asset', type: 'image', meta: asset?.meta ?? {},
        props: { ...asset?.props, src: file.dataURL, mimeType: file.mimeType, name: asset?.props.name ?? 'Pasted image', w: asset?.props.w ?? (element.type === 'image' ? element.crop?.naturalWidth : undefined) ?? element.width, h: asset?.props.h ?? (element.type === 'image' ? element.crop?.naturalHeight : undefined) ?? element.height },
      })
    }
  }
  if (reordered) {
    // Group containers are not Excalidraw elements. Reorder their document records too,
    // otherwise sending a legacy group behind another object would snap back on the next sync.
    const groupRanks = new Map<string, number>()
    for (const [index, element] of live.entries()) {
      const source = editor.getShape(element.id)
      if (!source) continue
      for (const groupId of ancestorIds(editor, source)) {
        if (element.groupIds.includes(groupId) && !groupRanks.has(groupId)) groupRanks.set(groupId, index + 1)
      }
    }
    for (const [id, index] of groupRanks) {
      const group = editor.getShape(id)
      if (group?.type === 'group' && group.index !== index && !editor.isShapeOrAncestorLocked(group)) changes.updates.push({ id, type: 'group', index })
    }
  }
  return changes
}
