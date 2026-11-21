import { LINE_HEIGHT, MAX_TEXT_BYTES } from './limits.js'

export type Brightness = 0 | 1 | 2 | 3 | 4

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  brightness?: Brightness
}

export interface Picture {
  id: string
  x: number
  y: number
  w: number
  h: number
  key: string
  data: Uint8Array
}

export interface MenuItem {
  id: number
  name: string
}

export interface Frame {
  boxes: Box[]
  pictures?: Picture[]
  menu?: MenuItem[]
}

const encoder = new TextEncoder()
const ELLIPSIS = '…'

export const byteLength = (text: string): number => encoder.encode(text).length

export function clipBytes(text: string, max: number = MAX_TEXT_BYTES): string {
  if (byteLength(text) <= max) return text
  const room = max - byteLength(ELLIPSIS)
  let kept = ''
  let used = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > room) break
    kept += char
    used += size
  }
  return kept + ELLIPSIS
}

export function linesOf(boxes: readonly Pick<Box, 'x' | 'y' | 'text'>[], lineHeight: number = LINE_HEIGHT): string[] {
  const rows = new Map<number, { x: number; text: string }[]>()
  for (const box of boxes) {
    box.text.split('\n').forEach((text, index) => {
      if (!text.trim()) return
      const y = box.y + index * lineHeight
      rows.set(y, [...(rows.get(y) ?? []), { x: box.x, text: text.trim() }])
    })
  }
  return [...rows]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map(part => part.text)
        .join(' '),
    )
}
