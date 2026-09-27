import { describe, expect, it } from 'vitest'
import { Editor, type TLShape } from '../src/canvas/editor'
import { createBoardController } from '../src/board/controller'
import { normalizeSnapshot } from '../src/canvas/migration'
import { renderShapesToSvg } from '../src/files/imageExporter'
import { fitGeometryVertices, polygonInteriorAngles } from '../shared/geometry'
import { commandSchema, contextSchema } from '../server/board-tools'

function setup() {
  const editor = new Editor()
  const controller = createBoardController(editor, () => ({ focus: null, pointer: null, selectedIds: editor.getSelectedShapeIds(), lastCreatedIds: [], objects: [], viewport: { x: 0, y: 0, w: 1000, h: 800 } }))
  return { editor, controller }
}

describe('interactive object features', () => {
  it('constructs the requested four angles, styles and transforms the same object, and reloads without changing its geometry', () => {
    const { editor, controller } = setup()
    const made = controller.applyOperations([{ type: 'create_geometry', geometry: 'polygon', angles: [91,91,90,88], fill: '#2563eb', fillOpacity: .3, strokeWidth: 4, opacity: .8 }])
    expect(made.ok, made.message).toBe(true)
    const id = made.ids[0]
    const shape = editor.getShape<TLShape<'magic'>>(id)!
    expect(shape.props.geometry).toBe('polygon')
    expect(shape.props.vertices).toHaveLength(4)
    expect(polygonInteriorAngles(shape.props.vertices!)).toEqual(expect.arrayContaining([expect.closeTo(91,4), expect.closeTo(90,4), expect.closeTo(88,4)]))
    expect(controller.applyOperations([{ type: 'transform_object', target: id, rotation: 90, bounds: { x: 20, y: 20, w: 600, h: 160 } }]).ok).toBe(true)
    const after = editor.getShape<TLShape<'magic'>>(id)!
    const fitted = fitGeometryVertices(after.props.vertices!, { x: 24, y: 24, w: 552, h: 112 })
    polygonInteriorAngles(fitted).forEach((angle,i) => expect(angle).toBeCloseTo([91,91,90,88][i],5))
    editor.loadSnapshot(normalizeSnapshot(editor.getSnapshot()))
    expect(editor.getShape<TLShape<'magic'>>(id)!.props).toMatchObject({ fill: '#2563eb', fillOpacity: .3, strokeWidth: 4, angles: [91,91,90,88] })
    expect(editor.getShape(id)!.opacity).toBe(.8)
    expect(contextSchema.parse({ focus: null, pointer: null, selectedIds: [id], lastCreatedIds: [], viewport: { x:0,y:0,w:1000,h:800 }, objects: controller.getObjects() }).objects[0].vertices).toHaveLength(4)
  })
  it('rejects impossible angles atomically without substituting a triangle', () => {
    const { editor, controller } = setup()
    const result = controller.applyOperations([{ type: 'create_text', text: 'uncommitted' }, { type:'create_geometry', geometry:'polygon', angles:[90,90,90,88] }])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/360/)
    expect(editor.getCurrentPageShapes()).toHaveLength(0)
  })
  it('keeps a custom open polyline editable after reload', () => {
    const {editor,controller}=setup()
    const made=controller.applyOperations([{type:'create_geometry',geometry:'polyline',vertices:[{x:0,y:0},{x:1,y:.5}]}])
    expect(made.ok,made.message).toBe(true)
    editor.loadSnapshot(editor.getSnapshot())
    expect(editor.getShape<TLShape<'magic'>>(made.ids[0])!.props.geometry).toBe('polyline')
    expect(controller.applyOperations([{type:'update_object',target:made.ids[0],color:'#dc2626'}]).ok).toBe(true)
  })
  it('preserves vertical/circular equations and plot display controls through a saved checkpoint', async () => {
    const { editor, controller } = setup()
    const made = controller.applyOperations([{type:'create_plot',expression:'x=1', showGrid:false, showAxes:false, strokeWidth:5}, {type:'create_plot',expression:'x^2+y^2=9'}])
    expect(made.ok,made.message).toBe(true)
    editor.loadSnapshot(editor.getSnapshot())
    expect(editor.getShape<TLShape<'magic'>>(made.ids[0])!.props).toMatchObject({expression:'x=1', showGrid:false, showAxes:false, strokeWidth:5})
    const output = await renderShapesToSvg(editor, made.ids)
    expect(output.svg).toContain('x=1')
    expect(output.svg).not.toContain('y = x=1')
    expect(output.svg).toContain('stroke-width="5"')
  })
  it('crops the image viewport reversibly, preserves bytes, and exports the same crop', async () => {
    const { editor, controller } = setup()
    const src = 'data:image/png;base64,iVBORw0KGgo='
    editor.createAssets([{ id:'asset:image', typeName:'asset', type:'image', meta:{}, props:{src,name:'Image',w:800,h:600} }])
    editor.createShape({id:'shape:image',type:'image',x:0,y:0,props:{assetId:'asset:image',w:400,h:300}})
    const result = controller.applyOperations([{type:'update_object',target:'shape:image',crop:{x:.25,y:0,w:.5,h:1},opacity:.6}])
    expect(result.ok,result.message).toBe(true)
    expect(editor.getShape<TLShape<'image'>>('shape:image')).toMatchObject({ x:100, y:0, props:{w:200,h:300} })
    expect(editor.getAsset('asset:image')!.props.src).toBe(src)
    const output = await renderShapesToSvg(editor,['shape:image'])
    expect(output.svg).toContain('viewBox="0.25 0 0.5 1"')
    expect(output.svg).toContain('opacity="0.6"')
    const checkpoint=editor.getSnapshot()
    editor.undo(); expect(editor.getShape<TLShape<'image'>>('shape:image')!.props.crop).toBeUndefined()
    editor.loadSnapshot(checkpoint)
    expect(editor.getShape<TLShape<'image'>>('shape:image')!.props.crop).toEqual({x:.25,y:0,w:.5,h:1})
    expect(controller.applyOperations([{type:'update_object',target:'shape:image',crop:{x:.9,y:0,w:.5,h:1}}]).ok).toBe(false)
    expect(controller.applyOperations([{type:'update_object',target:'shape:image',crop:{x:0,y:0,w:1,h:1}}]).ok).toBe(true)
    expect(editor.getShape<TLShape<'image'>>('shape:image')).toMatchObject({x:0,y:0,props:{w:400,h:300}})
  })
  it('anchors a rotated crop in the original image coordinate system', () => {
    const {editor,controller}=setup()
    editor.createShape({id:'shape:rotated',type:'image',x:40,y:50,rotation:Math.PI/2,props:{assetId:'asset:none',w:400,h:300}})
    expect(controller.applyOperations([{type:'update_object',target:'shape:rotated',crop:{x:.25,y:.1,w:.5,h:.8}}]).ok).toBe(true)
    const cropped=editor.getShape<TLShape<'image'>>('shape:rotated')!
    expect(cropped.x).toBeCloseTo(10); expect(cropped.y).toBeCloseTo(150)
    expect(cropped.props).toMatchObject({w:200,h:240})
    controller.applyOperations([{type:'update_object',target:cropped.id,crop:{x:0,y:0,w:1,h:1}}])
    const restored=editor.getShape(cropped.id)!
    expect(restored.x).toBeCloseTo(40); expect(restored.y).toBeCloseTo(50)
  })
  it('reorders siblings without unlocking backgrounds or changing group structure, and undoes the change', () => {
    const {editor}=setup()
    editor.createShapes([
      {id:'shape:background',type:'image',index:0,isLocked:true,props:{assetId:'asset:none',w:400,h:300}},
      {id:'shape:a',type:'magic',index:1}, {id:'shape:b',type:'magic',index:2},
      {id:'shape:group',type:'group',index:3},
      {id:'shape:child1',type:'magic',parentId:'shape:group',index:0},
      {id:'shape:child2',type:'magic',parentId:'shape:group',index:1},
    ])
    const order=()=>editor.getCurrentPageShapesSorted().map(shape=>shape.id)
    const original=order()
    editor.markHistoryStoppingPoint('layers')
    editor.sendToBack(['shape:b'])
    expect(order().slice(0,3)).toEqual(['shape:b','shape:background','shape:a'])
    expect(editor.getShape('shape:background')!.isLocked).toBe(true)
    editor.markHistoryStoppingPoint('after-layers'); editor.undo()
    expect(order()).toEqual(original)
    editor.bringToFront(['shape:background']); expect(order()).toEqual(original)
    editor.bringToFront(['shape:child1'])
    expect(order().slice(-2)).toEqual(['shape:child2','shape:child1'])
    expect(editor.getShape('shape:child1')!.parentId).toBe('shape:group')
  })
  it('validates style ranges and retains geometry fields in the API contract', () => {
    const op = {type:'create_geometry',geometry:'polygon',angles:[91,91,90,88],fill:'#dc2626',fillOpacity:.4,strokeWidth:3,opacity:.8}
    expect(commandSchema.parse({operations:[op],message:''}).operations[0]).toEqual(op)
    const {controller}=setup()
    expect(controller.applyOperations([{type:'create_geometry',strokeWidth:0}]).ok).toBe(false)
    expect(controller.applyOperations([{type:'create_geometry',opacity:2}]).ok).toBe(false)
  })
  it('lets AI commands arrange layers atomically with styling and undo', () => {
    const {editor,controller}=setup()
    const made=controller.applyOperations([{type:'create_geometry',geometry:'rectangle'}, {type:'create_geometry',geometry:'ellipse'}])
    const [first,second]=made.ids
    const op={type:'update_object' as const,target:first,layer:'front' as const,fill:'#93c5fd'}
    expect(commandSchema.parse({operations:[op],message:''}).operations[0].layer).toBe('front')
    expect(controller.applyOperations([op]).ok).toBe(true)
    expect(editor.getCurrentPageShapesSorted().map(s=>s.id)).toEqual([second,first])
    editor.undo()
    expect(editor.getCurrentPageShapesSorted().map(s=>s.id)).toEqual([first,second])
    expect(editor.getShape<TLShape<'magic'>>(first)!.props.fill).toBeUndefined()
    const failed=controller.applyOperations([op,{type:'create_geometry',geometry:'polygon',angles:[90,90,90,89]}])
    expect(failed.ok).toBe(false)
    expect(editor.getCurrentPageShapesSorted().map(s=>s.id)).toEqual([first,second])
  })
})
