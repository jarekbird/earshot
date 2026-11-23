import { describe, expect, it } from 'vitest'
import type { Sound, Speaker } from './audio.js'
import { Lifetime } from './lifetime.js'
import { scriptedLive, type Turn } from './live.js'

const sound = (ms: number, speaker: Speaker = 'unknown', gap = false): Sound => ({ pcm: new Uint8Array(ms * 32), speaker, gap })

function listening(lines: string[], msPerWord = 300) {
  const life = new Lifetime()
  const turns: Turn[] = []
  const hear = scriptedLive(lines, msPerWord).start(life, turn => turns.push(turn))
  return { life, turns, hear }
}

describe('scripted live speech, the offline stand-in', () => {
  it('says a line a word at a time as sound comes in, and calls the turn final at its last word', () => {
    const { turns, hear } = listening(['good morning all'])
    hear(sound(299))
    expect(turns).toEqual([])
    hear(sound(1))
    hear(sound(600))
    expect(turns).toEqual([
      { id: 0, words: 'good', final: false, speaker: 'unknown' },
      { id: 0, words: 'good morning', final: false, speaker: 'unknown' },
      { id: 0, words: 'good morning all', final: true, speaker: 'unknown' },
    ])
  })

  it('goes on to the next line as a new turn, and says nothing once the lines are used up', () => {
    const { turns, hear } = listening(['yes', 'no'])
    hear(sound(3_000))
    expect(turns.map(({ id, words, final }) => [id, words, final])).toEqual([
      [0, 'yes', true],
      [1, 'no', true],
    ])
  })

  it('gives a turn to whoever spoke most of it', () => {
    const { turns, hear } = listening(['one two three', 'four'])
    hear(sound(200, 'self'))
    hear(sound(700, 'other'))
    hear(sound(300, 'self'))
    expect(turns.map(turn => turn.speaker)).toEqual(['other', 'other', 'other', 'self'])
  })

  it('ends the turn at a break in the sound, and starts the next line after it', () => {
    const { turns, hear } = listening(['one two three', 'four'])
    hear(sound(300))
    hear(sound(300, 'unknown', true))
    expect(turns.map(({ id, words, final }) => [id, words, final])).toEqual([
      [0, 'one', false],
      [0, 'one', true],
      [1, 'four', true],
    ])
  })

  it('says nothing more once its lifetime has ended, and keeps its place for the next start', () => {
    const speech = scriptedLive(['one two', 'three'], 300)
    const first = new Lifetime()
    const turns: string[] = []
    const hear = speech.start(first, turn => turns.push(turn.words))
    hear(sound(300))
    first.end()
    hear(sound(900))
    speech.start(new Lifetime(), turn => turns.push(turn.words))(sound(300))
    expect(turns).toEqual(['one', 'three'])
  })
})
