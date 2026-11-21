import { describe, expect, it } from 'vitest'
import type { TargetInfo } from '../action.js'
import { layoutList, layoutText, LIST_DIM } from './layout.js'
import { textWidth } from './text.js'

const targets = (count: number): TargetInfo[] =>
  Array.from({ length: count }, (_, n) => ({ id: `t${n}`, say: `Thread ${n}`, private: false }))
const by = <T extends { id: string }>(boxes: T[], id: string) => boxes.find(box => box.id === id)!

describe('layoutList', () => {
  it('draws a dim title and dim rows, and the row under the cursor bright, with a marker', () => {
    const { boxes } = layoutList({ title: 'Threads' }, targets(3), { cursor: 1, top: 0 })
    expect(boxes.map(box => box.id)).toEqual(['title', 'marker', 'rows', 'cursor'])
    expect(by(boxes, 'title')).toMatchObject({ x: 0, y: 0, w: 576, h: 27, text: 'Threads', brightness: LIST_DIM })
    expect(by(boxes, 'rows')).toMatchObject({ x: 20, y: 27, w: 556, h: 243, text: 'Thread 0\n\nThread 2', brightness: LIST_DIM })
    expect(by(boxes, 'cursor')).toMatchObject({ x: 20, y: 27, w: 556, h: 243, text: '\nThread 1', brightness: 4 })
    expect(by(boxes, 'marker')).toMatchObject({ x: 0, y: 27, w: 20, h: 243, text: '\n>', brightness: 4 })
  })

  it('moves nothing when the cursor moves, so the page is not rebuilt', () => {
    const shape = (cursor: number) =>
      layoutList({ title: 'Threads' }, targets(3), { cursor, top: 0 }).boxes.map(({ id, x, y, w, h }) => [id, x, y, w, h])
    expect(shape(2)).toEqual(shape(0))
  })

  it('uses the whole screen when there is no title', () => {
    const { boxes } = layoutList({}, targets(12), { cursor: 0, top: 0 })
    expect(boxes.map(box => box.id)).toEqual(['marker', 'rows', 'cursor'])
    expect(by(boxes, 'rows')).toMatchObject({ y: 0, h: 270 })
    expect(by(boxes, 'rows').text.split('\n').length).toBe(10)
  })

  it('keeps the cursor on the list', () => {
    expect(layoutList({}, targets(3), { cursor: 9, top: 0 }).state).toEqual({ cursor: 2, top: 0 })
    expect(layoutList({}, targets(3), { cursor: -4, top: 0 }).state).toEqual({ cursor: 0, top: 0 })
  })

  it('scrolls only as far as it must to keep the cursor in view, and says where it is', () => {
    const down = layoutList({ title: 'Threads' }, targets(20), { cursor: 12, top: 0 })
    expect(down.state).toEqual({ cursor: 12, top: 4 })
    expect(by(down.boxes, 'rows').text.split('\n')).toEqual([...Array.from({ length: 8 }, (_, n) => `Thread ${n + 4}`), ''])
    expect(by(down.boxes, 'cursor').text).toBe(`${'\n'.repeat(8)}Thread 12`)
    expect(by(down.boxes, 'title').text).toBe('Threads  13/20')
    expect(layoutList({ title: 'Threads' }, targets(20), { cursor: 10, top: 4 }).state).toEqual({ cursor: 10, top: 4 })
    expect(layoutList({ title: 'Threads' }, targets(20), { cursor: 2, top: 4 }).state).toEqual({ cursor: 2, top: 2 })
  })

  it('leaves no gap at the end when the list gets shorter', () => {
    expect(layoutList({ title: 'Threads' }, targets(10), { cursor: 9, top: 8 }).state).toEqual({ cursor: 9, top: 1 })
  })

  it('puts each item on one line that fits', () => {
    const long = [{ id: 'a', say: `first line\nsecond ${'word '.repeat(40)}`, private: false }]
    const row = by(layoutList({}, long, { cursor: 0, top: 0 }).boxes, 'cursor').text
    expect(row.includes('\n')).toBe(false)
    expect(row.startsWith('first line second word')).toBe(true)
    expect(row.endsWith('…')).toBe(true)
    expect(textWidth(row)).toBeLessThanOrEqual(556)
  })

  it('says so when there is nothing to list', () => {
    const empty = layoutList({ title: 'Threads', empty: 'No threads yet' }, [], { cursor: 3, top: 2 })
    expect(empty.state).toEqual({ cursor: 0, top: 0 })
    expect(by(empty.boxes, 'rows').text).toBe('No threads yet')
    expect(by(empty.boxes, 'cursor').text).toBe('')
    expect(by(empty.boxes, 'marker').text).toBe('')
    expect(by(layoutList({}, [], { cursor: 0, top: 0 }).boxes, 'rows').text).toBe('Nothing here')
  })
})

describe('layoutText', () => {
  const body = Array.from({ length: 30 }, (_, n) => `Line ${n}`).join('\n')

  it('draws a dim title and the body under it, split into lines that fit', () => {
    const { boxes } = layoutText({ title: 'Ana', body: `${'word '.repeat(40)}\n\nlast` }, { top: 0 })
    expect(boxes.map(box => box.id)).toEqual(['title', 'body'])
    expect(by(boxes, 'title')).toMatchObject({ x: 0, y: 0, w: 576, h: 27, text: 'Ana', brightness: LIST_DIM })
    const lines = by(boxes, 'body').text.split('\n')
    expect(by(boxes, 'body')).toMatchObject({ x: 0, y: 27, w: 576, h: 243, brightness: 4 })
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.at(-1)).toBe('last')
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(576)
  })

  it('shows as many lines as fit, from where it has been scrolled to', () => {
    const { boxes } = layoutText({ title: 'Ana', body }, { top: 4 })
    expect(by(boxes, 'body').text.split('\n')).toEqual(Array.from({ length: 9 }, (_, n) => `Line ${n + 4}`))
    expect(by(layoutText({ body }, { top: 0 }).boxes, 'body').text.split('\n').length).toBe(10)
  })

  it('does not scroll past either end', () => {
    expect(layoutText({ title: 'Ana', body }, { top: -3 }).state).toEqual({ top: 0 })
    expect(layoutText({ title: 'Ana', body }, { top: 99 }).state).toEqual({ top: 21 })
    expect(layoutText({ title: 'Ana', body: 'short' }, { top: 5 }).state).toEqual({ top: 0 })
  })

  it('marks in the title that there is more above or below', () => {
    const title = (top: number) => by(layoutText({ title: 'Ana', body }, { top }).boxes, 'title').text
    expect(title(0)).toBe('Ana  ▼')
    expect(title(4)).toBe('Ana  ▲▼')
    expect(title(21)).toBe('Ana  ▲')
    expect(by(layoutText({ title: 'Ana', body: 'short' }, { top: 0 }).boxes, 'title').text).toBe('Ana')
  })

  it('cleans what the font cannot draw', () => {
    expect(by(layoutText({ body: 'use `npm`\tnow' }, { top: 0 }).boxes, 'body').text).toBe("use 'npm'  now")
  })
})
