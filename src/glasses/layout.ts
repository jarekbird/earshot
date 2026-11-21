import type { TargetInfo } from '../action.js'
import type { Box, Brightness } from './frame.js'
import { LINE_HEIGHT, MAX_BRIGHTNESS, SCREEN_HEIGHT, SCREEN_WIDTH } from './limits.js'
import { cleanText, fitText, oneLine, textWidth, wrapText } from './text.js'

export interface ListState {
  cursor: number
  top: number
}

export interface TextState {
  top: number
}

export const LIST_DIM: Brightness = 2
const MARKER = '>'
const GUTTER = 20
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
  const width = SCREEN_WIDTH - GUTTER
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

export function layoutText(view: { title?: string; body: string }, state: TextState): { boxes: Box[]; state: TextState } {
  const { rows, y, h, titleBox } = areas(view.title)
  const lines = wrapText(cleanText(view.body), SCREEN_WIDTH)
  const top = clamp(state.top, 0, Math.max(0, lines.length - rows))
  const more = `${top > 0 ? '▲' : ''}${top + rows < lines.length ? '▼' : ''}`
  return {
    state: { top },
    boxes: [
      ...titleBox(more ? `  ${more}` : ''),
      { id: 'body', x: 0, y, w: SCREEN_WIDTH, h, text: lines.slice(top, top + rows).join('\n'), brightness: MAX_BRIGHTNESS },
    ],
  }
}
