import { describe, expect, it } from 'vitest'
import { detectLibraryIntent } from '../src/library/intent'

const idle = { importPending: false, hasBooks: true }
const pending = { importPending: true, hasBooks: true }
const empty = { importPending: false, hasBooks: false }

describe('detectLibraryIntent', () => {
  it('inserts clear page and item requests without the model', () => {
    expect(detectLibraryIntent('page 22', idle)).toEqual({ action: 'insert', query: { kind: 'page', label: '22', raw: 'page 22' } })
    expect(detectLibraryIntent('problem 3.2', idle)).toMatchObject({ action: 'insert', query: { kind: 'item', label: '3.2' } })
    expect(detectLibraryIntent('Put example 3.12 on the board.', idle)).toMatchObject({ action: 'insert', query: { itemKind: 'example', label: '3.12' } })
    expect(detectLibraryIntent('show me page 23 from the calculus book', idle)).toMatchObject({ action: 'insert', query: { kind: 'page', label: '23', book: 'calculus' } })
    expect(detectLibraryIntent('can you bring up exercise 48 please', idle)).toMatchObject({ action: 'insert', query: { itemKind: 'exercise', label: '48' } })
    expect(detectLibraryIntent('3.2', idle)).toMatchObject({ action: 'insert', query: { kind: 'item', label: '3.2' } })
    expect(detectLibraryIntent('open page 10', idle)).toMatchObject({ action: 'insert', query: { kind: 'page', label: '10' } })
  })

  it('leaves anything unclear to the model', () => {
    for (const text of ['solve problem 3.2', 'write the answer to problem 3.2', 'the chain rule example from the book', 'plot y = x^2',
      'write the quadratic formula', 'draw a triangle', 'make page 2 bigger please and add a title', 'problem 3 on page 22', 'write pi', '']) {
      expect(detectLibraryIntent(text, idle)).toBeNull()
    }
  })

  it('needs books before inserting or opening', () => {
    expect(detectLibraryIntent('page 22', empty)).toBeNull()
    expect(detectLibraryIntent('open calculus', empty)).toBeNull()
  })

  it('routes a pending import only while one is pending', () => {
    for (const text of ['store it', 'Save it.', 'save to library', 'keep it in the library', 'please store it', 'add it to my library', 'library']) {
      expect(detectLibraryIntent(text, pending)).toEqual({ action: 'route_import', to: 'library' })
    }
    for (const text of ['put it on the board', 'on the board', 'board', 'put the pdf on the whiteboard', 'Okay put it on the board']) {
      expect(detectLibraryIntent(text, pending)).toEqual({ action: 'route_import', to: 'board' })
    }
    expect(detectLibraryIntent('store it', idle)).toBeNull()
    expect(detectLibraryIntent('put it on the board', idle)).toBeNull()
    expect(detectLibraryIntent('put page 22 on the board', pending)).toMatchObject({ action: 'insert' })
  })

  it('opens a named book and closes the reference panel', () => {
    expect(detectLibraryIntent('open the calculus book', idle)).toEqual({ action: 'open_book', book: 'calculus' })
    expect(detectLibraryIntent('open calculus', idle)).toEqual({ action: 'open_book', book: 'calculus' })
    expect(detectLibraryIntent('pull up the physics textbook', idle)).toEqual({ action: 'open_book', book: 'physics' })
    expect(detectLibraryIntent('open the book', idle)).toEqual({ action: 'open_book', book: '' })
    expect(detectLibraryIntent('close the book', idle)).toEqual({ action: 'close_reference' })
    expect(detectLibraryIntent('hide the reference panel', empty)).toEqual({ action: 'close_reference' })
    for (const text of ['open settings', 'show the graph', 'open the menu', 'show me the derivative', 'open a new board']) {
      expect(detectLibraryIntent(text, idle)).toBeNull()
    }
  })
})
