import { describe, expect, it } from 'vitest'
import { onTunnelHost } from '../src/library/LibraryPanel'
import { pageFromQuery } from '../src/library/ReferencePanel'

describe('library panel notes', () => {
  it('knows a quick tunnel address, where books stay with that address', () => {
    expect(onTunnelHost('calm-river-1234.trycloudflare.com')).toBe(true)
    expect(onTunnelHost('CALM-RIVER.TRYCLOUDFLARE.COM')).toBe(true)
    expect(onTunnelHost('localhost')).toBe(false)
    expect(onTunnelHost('192.168.1.20')).toBe(false)
    expect(onTunnelHost('trycloudflare.com.example.org')).toBe(false)
  })
})

describe('reference panel page search', () => {
  it('goes to the repeated page number nearest the page in view, else the first', () => {
    const labels = [null, '1', '2', '3', '1', '2', '3']
    expect(pageFromQuery(labels, 'page 2')).toBe(2)
    expect(pageFromQuery(labels, 'page 2', 5)).toBe(5)
    expect(pageFromQuery(labels, 'page 2', 1)).toBe(2)
  })

  it('goes to the file page when no printed page has the number', () => {
    const labels = [null, '10', '11', '12']
    expect(pageFromQuery(labels, 'page 11')).toBe(2)
    expect(pageFromQuery(labels, 'page 3')).toBe(2)
    expect(pageFromQuery(labels, 'page 9')).toBeNull()
    expect(pageFromQuery(labels, 'page v')).toBeNull()
  })
})
