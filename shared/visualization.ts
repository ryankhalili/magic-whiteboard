import { z } from 'zod'

/** Declarative, bounded scientific graphics. No model-generated code is executed. */
export const visualizationSchema = z.object({
  type: z.enum(['surface', 'revolution', 'phase']),
  secondaryExpression: z.string().max(240).optional().describe('Phase portrait only: dy/dt. The operation expression is dx/dt.'),
  axis: z.enum(['x', 'y']).optional().describe('Axis of revolution; radius is expression(t), with t represented by x.'),
  sweep: z.number().finite().min(1).max(360).optional().describe('Revolution angle in degrees.'),
  yaw: z.number().finite().min(-360).max(360).optional(),
  pitch: z.number().finite().min(-85).max(85).optional(),
  showWireframe: z.boolean().optional().describe('3D surface mesh lines; independent of coordinate grid, axis lines and numeric ticks. Defaults to true.'),
  duration: z.number().finite().min(.1).max(40).optional().describe('Phase trajectory integration time in each direction.'),
  seeds: z.array(z.object({ x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) })).max(12).optional(),
}).strict()
export type VisualizationSpec = z.infer<typeof visualizationSchema>
