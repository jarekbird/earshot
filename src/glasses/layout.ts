import type { TargetInfo } from '../action.js'
import type { Box, Brightness } from './frame.js'
import { LINE_HEIGHT, MAX_BRIGHTNESS, MAX_TEXT_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from './limits.js'
import { cleanText, fitText, oneLine, textWidth, wrapText } from './text.js'

interface ListState {
  cursor: number
  top: number
}

export interface TextState {
  top: number
  away?: boolean
}

export const LIST_DIM: Brightness = 2
const BYTES = new TextEncoder()
const MARKER = '>'
const GUTTER = 20
export const LIST_ROW_WIDTH = SCREEN_WIDTH - GUTTER
const NOTHING = 'Nothing here'
const LINES = Math.floor(SCREEN_HEIGHT / LINE_HEIGHT)

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function areas(title: string | undefined) {
  const rows = title === undefined ? LINES : LINES - 1
  const y = title === undefined ? 0 : LINE_HEIGHT
  const titleBox = (suffix: string): Box[] => {
    if (title === undefined) return []
    const text = fitText(oneLine(title), SCREEN_WIDTH - textWidth(suffix)) + suffix
    return [{ id: 'title', x: 0, y: 0, w: SCREEN_WIDTH, h: LINE_HEIGHT, text, brightness: LIST_DIM }]
  }
  return { rows, y, h: rows * LINE_HEIGHT, titleBox }
}

export function layoutList(
  view: { title?: string; empty?: string },
  targets: readonly TargetInfo[],
  state: ListState,
): { boxes: Box[]; state: ListState } {
  const { rows, y, h, titleBox } = areas(view.title)
  const cursor = clamp(state.cursor, 0, Math.max(0, targets.length - 1))
  const top = clamp(clamp(state.top, cursor - rows + 1, cursor), 0, Math.max(0, targets.length - rows))
  const width = LIST_ROW_WIDTH
  const shown = targets.slice(top, top + rows).map(target => fitText(oneLine(target.say), width))
  const others = shown.map((row, index) => (index === cursor - top ? '' : row))
  const before = '\n'.repeat(cursor - top)
  const some = targets.length > 0
  const where = targets.length > rows ? `  ${cursor + 1}/${targets.length}` : ''
  return {
    state: { cursor, top },
    boxes: [
      ...titleBox(where),
      { id: 'marker', x: 0, y, w: GUTTER, h, text: some ? before + MARKER : '', brightness: MAX_BRIGHTNESS },
      { id: 'rows', x: GUTTER, y, w: width, h, text: some ? others.join('\n') : (view.empty ?? NOTHING), brightness: LIST_DIM },
      { id: 'cursor', x: GUTTER, y, w: width, h, text: some ? before + shown[cursor - top] : '', brightness: MAX_BRIGHTNESS },
    ],
  }
}

export interface Stride {
  up: number
  down: number
}

export function layoutText(
  view: { title?: string; body: string; end?: boolean },
  state: TextState,
): { boxes: Box[]; state: TextState; scrolls: boolean; at: number; atEnd: boolean; stride: (wanted: number) => Stride } {
  const { rows, y, h, titleBox } = areas(view.title)
  const lines = wrapText(cleanText(view.body), SCREEN_WIDTH)
  const fits = (from: number, to: number) => BYTES.encode(lines.slice(from, to).join('\n')).length <= MAX_TEXT_BYTES
  const endOf = (from: number) => {
    let to = Math.min(lines.length, from + rows)
    while (view.end && to > from + 1 && !fits(from, to)) to--
    return to
  }
  let last = Math.max(0, lines.length - rows)
  while (view.end && last < lines.length - 1 && !fits(last, lines.length)) last++
  const following = view.end === true && !state.away
  const top = clamp(following ? last + state.top : state.top, 0, last)
  const end = endOf(top)
  const more = `${top > 0 ? '▲' : ''}${end < lines.length ? '▼' : ''}`
  return {
    state: view.end ? (top >= last ? { top: 0, away: false } : { top, away: true }) : { top },
    scrolls: last > 0,
    at: top,
    atEnd: top >= last,
    stride: wanted => {
      if (!view.end) return { up: wanted, down: wanted }
      let up = Math.max(1, Math.min(wanted, top))
      while (up > 1 && endOf(top - up) < top) up--
      return { up, down: Math.max(1, Math.min(wanted, end - top)) }
    },
    boxes: [
      ...titleBox(more ? `  ${more}` : ''),
      { id: 'body', x: 0, y, w: SCREEN_WIDTH, h, text: lines.slice(top, end).join('\n'), brightness: MAX_BRIGHTNESS },
    ],
  }
}
