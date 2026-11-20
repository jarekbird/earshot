import { getAdvW, getTextWidth } from '@evenrealities/pretext'

const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g
const ELLIPSIS = '…'

export const textWidth = (text: string): number => getTextWidth(text)

export const hasGlyph = (char: string): boolean => getAdvW(char.codePointAt(0) ?? 0) > 0

export const cleanText = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/`/g, "'").replace(HIDDEN, '')

export const oneLine = (text: string): string => cleanText(text).replace(/\s+/g, ' ').trim()

export function fitText(text: string, px: number): string {
  const whole = text.trimEnd()
  if (getTextWidth(whole) <= px) return whole
  const chars = Array.from(whole)
  const cut = (count: number) => chars.slice(0, count).join('').trimEnd() + ELLIPSIS
  const fits = (count: number) => getTextWidth(cut(count)) <= px
  if (!fits(0)) return ''
  let most = 0
  let limit = chars.length - 1
  while (most < limit) {
    const middle = (most + limit + 1) >> 1
    if (fits(middle)) most = middle
    else limit = middle - 1
  }
  return cut(most)
}

const advance = (char: string, next = ''): number => getTextWidth(char + next) - getTextWidth(next)

// The firmware breaks a line after a space, a hyphen, or a Chinese, Japanese or Korean character.
function breaksAfter(char: string): boolean {
  if (char === ' ' || char === '-') return true
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xac00 && code <= 0xd7af)
}

function wrapParagraph(chars: string[], px: number): string[] {
  const lines: string[] = []
  let start = 0
  let ink = 0
  let width = 0
  let breakAt = -1
  const endLine = (to: number, next: number) => {
    lines.push(chars.slice(start, to).join('').trimEnd())
    start = ink = next
    width = 0
    breakAt = -1
  }
  while (chars[ink] === ' ') width += advance(' ', chars[++ink])
  let at = ink
  while (at < chars.length) {
    const char = chars[at]
    if (at === ink && char === ' ') {
      start = ink = ++at
    } else if (width + advance(char) <= px) {
      width += advance(char, chars[at + 1])
      if (breaksAfter(char)) breakAt = at
      at++
    } else if (char === ' ') {
      endLine(at, ++at)
    } else if (breakAt !== -1) {
      at = breakAt + 1
      endLine(at, at)
    } else if (at > ink) {
      endLine(at, at)
    } else if (start < ink) {
      start = ink
      width = 0
    } else {
      width = advance(char)
      at++
    }
  }
  lines.push(chars.slice(start).join('').trimEnd())
  return lines
}

export const wrapText = (text: string, px: number): string[] =>
  text.split('\n').flatMap(paragraph => wrapParagraph(Array.from(paragraph), px))
