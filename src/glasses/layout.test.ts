import { describe, expect, it } from 'vitest'
import type { TargetInfo } from '../action.js'
import { text } from '../view.js'
import { layoutList, layoutText, LIST_DIM, LIST_ROW_WIDTH } from './layout.js'
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

  it('shows words as wide as LIST_ROW_WIDTH whole, and cuts wider ones, so an app can fit a row before it is drawn', () => {
    const letters = (count: number) => 'm'.repeat(count)
    let fits = 0
    while (textWidth(letters(fits + 1)) <= LIST_ROW_WIDTH) fits++
    const row = (say: string) => by(layoutList({}, [{ id: 'one', say, private: false }], { cursor: 0, top: 0 }).boxes, 'cursor').text
    expect(fits).toBeGreaterThan(0)
    expect(row(letters(fits))).toBe(letters(fits))
    expect(row(letters(fits + 1))).toMatch(/^m+…$/)
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

  it('follows the end only for end: true, so an app that already kept something of its own under that name is shown as before', () => {
    const body = Array.from({ length: 30 }, (_, n) => `Line ${n + 1}`).join('\n')
    const theirs = text({ title: 'Ana', body, end: new Date(0) as unknown as boolean })
    expect(theirs).toEqual(text({ title: 'Ana', body }))
    const { boxes, state } = layoutText(theirs as { body: string }, { top: 0 })
    expect(by(boxes, 'body').text.split('\n')[0]).toBe('Line 1')
    expect(state).toEqual({ top: 0 })
  })

  it('asked to stay at its end, shows the last lines, and goes on showing the last as more come', () => {
    const shown = (text: string) => by(layoutText({ title: 'Ana', body: text, end: true }, { top: 0 }).boxes, 'body').text.split('\n')
    expect(shown(body).at(-1)).toBe('Line 29')
    expect(shown(body)).toHaveLength(9)
    expect(shown(`${body}\nLine 30`).at(-1)).toBe('Line 30')
    expect(layoutText({ title: 'Ana', body, end: true }, { top: 0 }).state).toEqual({ top: 0, away: false })
  })

  it('asked to stay at its end, holds the place a swipe up took it to while more lines come, so the wearer can read back', () => {
    const up = layoutText({ title: 'Ana', body, end: true }, { top: -2 })
    expect(by(up.boxes, 'body').text.split('\n').at(-1)).toBe('Line 27')
    const grown = layoutText({ title: 'Ana', body: `${body}\nLine 30\nLine 31`, end: true }, up.state)
    expect(by(grown.boxes, 'body').text.split('\n').at(-1)).toBe('Line 27')
    const further = layoutText({ title: 'Ana', body: `${body}\nLine 30\nLine 31`, end: true }, { ...grown.state, top: grown.state.top - 2 })
    expect(by(further.boxes, 'body').text.split('\n').at(-1)).toBe('Line 25')
  })

  it('asked to stay at its end, follows the end again once the wearer has swiped back down to it', () => {
    const up = layoutText({ title: 'Ana', body, end: true }, { top: -2 })
    const back = layoutText({ title: 'Ana', body, end: true }, { ...up.state, top: up.state.top + 2 })
    expect(back.state).toEqual({ top: 0, away: false })
    const grown = layoutText({ title: 'Ana', body: `${body}\nLine 30`, end: true }, back.state)
    expect(by(grown.boxes, 'body').text.split('\n').at(-1)).toBe('Line 30')
  })

  it('asked to stay at its end, lets go of its oldest lines rather than its newest when they are too many bytes for the glasses', () => {
    const long = Array.from({ length: 12 }, () => 'i'.repeat(115)).join('\n')
    const { boxes } = layoutText({ body: `${long}\nLATEST`, end: true }, { top: 0 })
    const text = by(boxes, 'body').text
    expect(text.split('\n').at(-1)).toBe('LATEST')
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(999)
  })

  it('asked to stay at its end, lets the wearer swipe up to a first line that the byte limit kept off the last page', () => {
    const dense = ['a' + 'i'.repeat(111), ...Array.from({ length: 8 }, () => 'i'.repeat(115))].join('\n')
    const atEnd = layoutText({ title: 'Transcript', body: dense, end: true }, { top: 0 })
    expect(by(atEnd.boxes, 'body').text.split('\n')).toHaveLength(8)
    expect(by(atEnd.boxes, 'body').text.startsWith('a')).toBe(false)
    expect(atEnd.scrolls).toBe(true)
    expect(by(atEnd.boxes, 'title').text).toContain('▲')
    const up = layoutText({ title: 'Transcript', body: dense, end: true }, { ...atEnd.state, top: atEnd.state.top - 2 })
    const shown = by(up.boxes, 'body').text
    expect(shown.startsWith('a')).toBe(true)
    expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(999)
    expect(by(up.boxes, 'title').text).toContain('▼')
    const down = layoutText({ title: 'Transcript', body: dense, end: true }, { ...up.state, top: up.state.top + 2 })
    expect(down.state).toEqual({ top: 0, away: false })
  })

  it.each([
    ['a swipe', 2],
    ['a screenful', 8],
  ])(
    'asked to stay at its end, leaves no line unread between pages when moved by %s, up or down, however few lines a page holds',
    (_name, wanted) => {
      const dense = Array.from({ length: 20 }, (_, at) => `${String(at).padStart(2, '0')}${'í'.repeat(110)}`).join('\n')
      const view = { title: 'Log', body: dense, end: true }
      const numbers = (boxes: ReturnType<typeof layoutText>['boxes']) =>
        by(boxes, 'body')
          .text.split('\n')
          .map(line => Number(line.slice(0, 2)))
      let laid = layoutText(view, { top: 0 })
      const up = [numbers(laid.boxes)]
      for (let moves = 0; moves < 40 && up.at(-1)![0] > 0; moves++) {
        laid = layoutText(view, { ...laid.state, top: laid.state.top - laid.stride(wanted).up })
        up.push(numbers(laid.boxes))
      }
      expect(up.at(-1)![0]).toBe(0)
      for (let page = 1; page < up.length; page++) expect(up[page].at(-1)! + 1).toBeGreaterThanOrEqual(up[page - 1][0])
      const down = [numbers(laid.boxes)]
      for (let moves = 0; moves < 40 && down.at(-1)!.at(-1)! < 19; moves++) {
        laid = layoutText(view, { ...laid.state, top: laid.state.top + laid.stride(wanted).down })
        down.push(numbers(laid.boxes))
      }
      expect(down.at(-1)!.at(-1)).toBe(19)
      for (let page = 1; page < down.length; page++) expect(down[page][0]).toBeLessThanOrEqual(down[page - 1].at(-1)! + 1)
      expect(new Set([...up, ...down].flat()).size).toBe(20)
    },
  )

  it('moves an ordinary text by the swipe or the screenful it always did', () => {
    expect(layoutText({ title: 'Ana', body }, { top: 4 }).stride(2)).toEqual({ up: 2, down: 2 })
    expect(layoutText({ title: 'Ana', body }, { top: 4 }).stride(8)).toEqual({ up: 8, down: 8 })
  })

  it('asked to stay at its end, shows a short text from its first line', () => {
    expect(by(layoutText({ body: 'one\ntwo', end: true }, { top: 0 }).boxes, 'body').text).toBe('one\ntwo')
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
