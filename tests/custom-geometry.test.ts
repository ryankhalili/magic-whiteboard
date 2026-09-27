import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fitGeometryVertices, polygonInteriorAngles, resolveGeometry, validateGeometryVertices } from '../shared/geometry'
import { GeometryGraphic } from '../src/board/GeometryGraphic'
import type { MagicShape } from '../src/board/MagicShape'

describe('custom polygon constraints', () => {
  it('constructs an actual four-sided polygon with 91°,91°,90°,88° interior angles', () => {
    const angles = [91, 91, 90, 88]
    const result = resolveGeometry({ geometry: 'polygon', sides: 4, angles })
    expect(result.geometry).toBe('polygon')
    expect(result.vertices).toHaveLength(4)
    expect(result.vertices!.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true)
    polygonInteriorAngles(result.vertices!).forEach((actual, i) => expect(actual).toBeCloseTo(angles[i], 8))
    expect(result.aspectRatio).toBeGreaterThan(.5)
    expect(result.aspectRatio).toBeLessThan(2)
  })

  it('preserves actual angles when a wide or tall canvas box resizes the diagram', () => {
    const angles = [70, 100, 80, 110], { vertices } = resolveGeometry({ angles })
    for (const bounds of [{ x: 50, y: 10, w: 800, h: 150 }, { x: -4, y: 2, w: 120, h: 900 }]) {
      const fitted = fitGeometryVertices(vertices!, bounds)
      polygonInteriorAngles(fitted).forEach((angle, i) => expect(angle).toBeCloseTo(angles[i], 8))
      expect(fitted.every(p => p.x >= bounds.x - 1e-9 && p.y >= bounds.y - 1e-9 && p.x <= bounds.x + bounds.w + 1e-9 && p.y <= bounds.y + bounds.h + 1e-9)).toBe(true)
    }
  })

  it.each([[91, 91, 90, 89], [60, 60, 70], [0, 90, 90, 180], [200, 40, 60, 60], [NaN, 90, 90, 90]])('rejects impossible convex interior angles %j', (...angles) => {
    expect(() => resolveGeometry({ geometry: 'polygon', angles })).toThrow()
  })

  it('explains the required angle sum and side count', () => {
    expect(() => resolveGeometry({ angles: [90, 90, 90, 91] })).toThrow('must add to 360')
    expect(() => resolveGeometry({ sides: 5, angles: [90, 90, 90, 90] })).toThrow('needs 5 interior angles')
    expect(() => resolveGeometry({ geometry: 'rectangle', angles: [91, 91, 90, 88] })).toThrow('Use polygon')
  })

  it('rejects crossing, zero-length, degenerate, out-of-range and mismatched explicit vertices', () => {
    expect(() => validateGeometryVertices([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }])).toThrow('intersect')
    expect(() => validateGeometryVertices([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow('distinct')
    expect(() => validateGeometryVertices([{ x: 0, y: 0 }, { x: .5, y: .5 }, { x: 1, y: 1 }])).toThrow('no usable area')
    expect(() => resolveGeometry({ vertices: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] })).toThrow('between 0 and 1')
    expect(() => resolveGeometry({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], angles: [91, 91, 90, 88] })).toThrow('do not match')
  })

  it('supports regular polygons up to16 sides and nonclosed two-point paths', () => {
    const regular = resolveGeometry({ geometry: 'polygon', sides: 16 })
    expect(regular.vertices).toHaveLength(16)
    polygonInteriorAngles(regular.vertices!).forEach(angle => expect(angle).toBeCloseTo(157.5, 8))
    expect(resolveGeometry({ geometry: 'polyline', vertices: [{ x: 0, y: .5 }, { x: 1, y: .5 }] }).vertices).toHaveLength(2)
    expect(() => resolveGeometry({ geometry: 'polygon', sides: 17 })).toThrow('3–16')
    expect(() => resolveGeometry({ geometry: 'polyline', angles: [60, 60, 60] })).toThrow('closed polygons')
  })

  it('renders the four actual edges, labels, fill and angles from the same geometry', () => {
    const geometry = resolveGeometry({ geometry: 'polygon', angles: [91, 91, 90, 88] })
    const shape = { props: { ...geometry, kind: 'geometry', w: 420, h: 300, color: '#202124', text: 'A,B,C,D', title: '', fontSize: 24, fill: '#2563eb', fillOpacity: .2, strokeWidth: 4 } } as unknown as MagicShape
    const svg = renderToStaticMarkup(createElement(GeometryGraphic, { shape }))
    expect(svg).toContain('data-geometry="polygon"')
    expect(svg).toContain('fill="#2563eb"')
    expect(svg).toContain('fill-opacity="0.2"')
    expect(svg).toContain('stroke-width="4"')
    expect(svg.match(/91°/g)).toHaveLength(2)
    expect(svg).toContain('88°')
    expect(svg).toContain('>D</text>')
    const firstPath = /<path d="([^"]+)"/.exec(svg)![1]
    expect(firstPath.match(/L/g)).toHaveLength(3)
    expect(firstPath.endsWith(' Z')).toBe(true)
    const coordinates = firstPath.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
    const drawnVertices = Array.from({ length: coordinates.length / 2 }, (_, i) => ({ x: coordinates[i * 2], y: coordinates[i * 2 + 1] }))
    polygonInteriorAngles(drawnVertices).forEach((angle, i) => expect(angle).toBeCloseTo([91, 91, 90, 88][i], 8))
  })
})
