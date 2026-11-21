import { MAX_TEXT_BYTES } from './limits.js'

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

export interface Frame {
  boxes: Box[]
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

export const linesOf = (boxes: readonly Pick<Box, 'x' | 'y' | 'text'>[]): string[] =>
  [...boxes]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .flatMap(box => box.text.split('\n'))
    .filter(line => line.trim())
