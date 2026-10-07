import { describe, expect, it } from 'vitest'
import { completeLibraryRetrieval } from '../src/library/retrievalIntent'
import { libraryQueryFromOperation } from '../src/board/controller'
import type { BoardOperation } from '../shared/board'

const open: BoardOperation[] = [{ type: 'library_action', action: 'open_book', book: 'Sakuri QM' }]
describe('finishing explicit library retrieval', () => {
  it.each(['Pull question 2 from chapter 6, please.', 'Hi, okay, can we pull question 2 from chapter 6 please?', 'put problem 6.2 on the board'])('turns open-only output into the requested lookup: %s', text => {
    const ops = completeLibraryRetrieval(open, text)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ type: 'insert_library', book: 'Sakuri QM' })
    expect(libraryQueryFromOperation(ops[0])).toMatchObject({ kind: 'item', label: text.includes('6.2') ? '6.2' : '2' })
    if (!text.includes('6.2')) expect(libraryQueryFromOperation(ops[0])).toMatchObject({ chapter: '6' })
  })
  it.each(['open the Sakuri textbook', 'do not pull question 2 from chapter 6', 'solve question 2 in chapter 6', 'open the book and show its contents', 'show the page I have open'])('preserves navigation and ambiguous instructions: %s', text => {
    expect(completeLibraryRetrieval(open, text)).toBe(open)
  })
  it('does not duplicate an already supplied insert or change mixed board commands', () => {
    for (const ops of [[...open, { type: 'insert_library', item: 'question 6.2' }], [...open, { type: 'create_text', text: 'notes' }]] as BoardOperation[][]) {
      expect(completeLibraryRetrieval(ops, 'pull question 2 from chapter 6')).toBe(ops)
    }
  })
  it('prefers the book explicitly named by the user over an incorrect model-selected book', () => {
    expect(completeLibraryRetrieval(open, 'pull question 2 from chapter 6 of the Griffiths textbook')[0].book).toBe('griffiths')
  })
})
