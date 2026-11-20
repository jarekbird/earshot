import { measureTextWrap } from '@evenrealities/pretext'
import { describe, expect, it } from 'vitest'
import { cleanText, fitText, hasGlyph, oneLine, textWidth, wrapText } from './text.js'

const PROSE = [
  'The quick brown fox jumps over the lazy dog, then stops to think about what it has just done.',
  'Привет мир, это длинная строка текста для проверки переноса строк на очках.',
  'café naïve façade: a well-known co-operative re-opened its long-awaited self-service counter',
  'Open src/glasses/font.ts:142 and compare it with check/manifest.ts before the release at 14:30.',
  'To Type AVATAR We Yo. WAVE AWAY Tomorrow, Yesterday, Today; LTV PA. To. Ty. Va. Wa. Ye.',
  '日本語のテキストは文字の間で改行できます。漢字とかなが混ざっています。',
  'Mixed 日本語 and English words in one line, with a ✓ the font cannot draw and an emoji 😀 too.',
  'two  spaces   and    more     between      words       all        the         way',
  'one\n\ntwo words here\nthree',
]
const WIDTHS = [60, 120, 200, 288, 400, 576]

describe('textWidth', () => {
  // Drawn widths measured between two bars in the Even Hub simulator 0.9.5.
  it('is the width the glasses draw', () => {
    const drawn = (text: string) => textWidth(`|${text}|`) - textWidth('||')
    expect(drawn('The quick brown fox jumps over the lazy dog')).toBe(386)
    expect(drawn('src/glasses/font.ts:142')).toBe(195)
    expect(drawn('To Type AVATAR We Yo.')).toBe(200)
    expect(drawn('café naïve façade')).toBe(156)
    expect(drawn('Привет мир')).toBe(114)
    expect(drawn('WWWWWWWWWWWWWWWWWWWW')).toBe(320)
  })

  it('counts the pairs of letters the font pulls together', () => {
    expect(textWidth('AV')).toBeLessThan(textWidth('A') + textWidth('V'))
  })

  it('gives a character the font cannot draw the gap the glasses leave for it', () => {
    expect(textWidth('✓')).toBe(4)
    expect(textWidth('`')).toBe(4)
    expect(textWidth('')).toBe(0)
  })
})

describe('hasGlyph', () => {
  it('knows what the font draws', () => {
    for (const drawn of ['a', ' ', '…', '●', 'é', 'П', '日']) expect(hasGlyph(drawn), drawn).toBe(true)
    for (const missing of ['✓', '`', '\t', '\n', '\u200b']) expect(hasGlyph(missing), JSON.stringify(missing)).toBe(false)
  })
})

describe('cleanText', () => {
  it('swaps what the font cannot draw for what it can', () => {
    expect(cleanText('use `npm`')).toBe("use 'npm'")
    expect(cleanText('a\tb')).toBe('a  b')
  })

  it('makes every line end the same', () => {
    expect(cleanText('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour')
  })

  it('removes characters that take no room and draw nothing', () => {
    expect(cleanText('a\u200bb\u00adc\u202ed\ufeffe\u0007f')).toBe('abcdef')
  })

  it('leaves spaces, blank lines and other characters alone', () => {
    expect(cleanText('  two  spaces\n\n\nand ✓ 日本')).toBe('  two  spaces\n\n\nand ✓ 日本')
  })
})

describe('oneLine', () => {
  it('cleans the text and puts it on one line', () => {
    expect(oneLine('  first `line`\r\n\n\tsecond   line \n')).toBe("first 'line' second line")
  })
})

describe('fitText', () => {
  it('keeps text that fits, without the spaces at its end', () => {
    expect(fitText('hello  ', 200)).toBe('hello')
    expect(fitText('', 200)).toBe('')
  })

  it('cuts text that is too wide and ends it with an ellipsis, as wide as it can be', () => {
    const fitted = fitText('a'.repeat(100), 120)
    expect(fitted).toMatch(/^a+…$/)
    expect(textWidth(fitted)).toBeLessThanOrEqual(120)
    expect(textWidth(`a${fitted}`)).toBeGreaterThan(120)
  })

  it('leaves no space before the ellipsis', () => {
    expect(fitText('hello world', textWidth('hello …') + 2)).toBe('hello…')
  })

  it('never cuts a character in half', () => {
    expect(fitText('😀😀😀😀', textWidth('😀😀…'))).toBe('😀😀…')
  })

  it('gives what little fits when there is almost no room', () => {
    expect(fitText('hello', textWidth('…'))).toBe('…')
    expect(fitText('hello', textWidth('…') - 1)).toBe('')
    expect(fitText('hello', 0)).toBe('')
  })
})

describe('wrapText', () => {
  it('fills each line before starting the next', () => {
    expect(wrapText('aaa bbb ccc ddd', textWidth('aaa bbb'))).toEqual(['aaa bbb', 'ccc ddd'])
  })

  it('keeps blank lines between paragraphs', () => {
    expect(wrapText('one\n\ntwo', 300)).toEqual(['one', '', 'two'])
    expect(wrapText('', 300)).toEqual([''])
  })

  it('breaks after a hyphen', () => {
    expect(wrapText('well-known', textWidth('well-known') - 1)).toEqual(['well-', 'known'])
  })

  it('breaks between characters of Chinese, Japanese and Korean', () => {
    expect(wrapText('日本語日本語', textWidth('日本語'))).toEqual(['日本語', '日本語'])
  })

  it('drops the spaces around a break', () => {
    expect(wrapText('aaa   bbb', textWidth('aaa') + 2)).toEqual(['aaa', 'bbb'])
  })

  // The simulator draws the spaces that start a line.
  it('keeps the spaces that start a paragraph, and counts their width', () => {
    expect(wrapText('  indented\n    more', 300)).toEqual(['  indented', '    more'])
    expect(wrapText('  aaa bbb', textWidth('  aaa'))).toEqual(['  aaa', 'bbb'])
    expect(wrapText('  aaa bbb', textWidth('aaa bbb'))).toEqual(['  aaa', 'bbb'])
  })

  it('drops the starting spaces when they leave no room for a character', () => {
    expect(wrapText('          WW', textWidth('W'))).toEqual(['W', 'W'])
    expect(wrapText('     ', 10)).toEqual([''])
  })

  it('breaks a word that is wider than the line, losing nothing', () => {
    const lines = wrapText('W'.repeat(40), 200)
    expect(lines.join('')).toBe('W'.repeat(40))
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(200)
    expect(lines.length).toBe(Math.ceil(40 / Math.floor(200 / textWidth('W'))))
  })

  it('gives a character wider than the line a line of its own', () => {
    expect(wrapText('€€€', 10)).toEqual(['€', '€', '€'])
    expect(wrapText('a €', 10)).toEqual(['a', '€'])
    expect(wrapText('abc', 0)).toEqual(['a', 'b', 'c'])
  })

  it('makes lines the glasses do not break again', () => {
    for (const text of PROSE) {
      for (const px of WIDTHS) {
        const lines = wrapText(text, px)
        for (const line of lines) expect(textWidth(line), `${px}: ${line}`).toBeLessThanOrEqual(px)
        const shown = lines.filter(Boolean).join('\n')
        expect(measureTextWrap(shown, px).lineCount, `${px}: ${text}`).toBe(lines.filter(Boolean).length)
      }
    }
  })

  it('breaks ordinary text where the glasses would break it', () => {
    for (const text of PROSE) {
      for (const px of WIDTHS) {
        expect(wrapText(text, px).length, `${px}: ${text}`).toBe(measureTextWrap(text, px).lineCount)
      }
    }
  })

  it('ends, loses nothing and stays inside the line for any text', () => {
    let seed = 20261120
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below
    const alphabet = Array.from('aAVTWoy.,/-  \nеП日語✓😀€fijlt:')
    for (let round = 0; round < 3000; round++) {
      const text = Array.from({ length: 1 + random(60) }, () => alphabet[random(alphabet.length)]).join('')
      const px = random(300)
      const lines = wrapText(text, px)
      for (const line of lines) expect(textWidth(line) <= px || Array.from(line).length === 1, `${px}: ${line}`).toBe(true)
      expect(lines.join('').replace(/\s+/g, ''), `${px}: ${text}`).toBe(text.replace(/\s+/g, ''))
      const shown = lines.filter(Boolean)
      if (px >= 24) expect(measureTextWrap(shown.join('\n'), px).lineCount, `${px}: ${text}`).toBe(shown.length)
    }
  })
})
