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
      { id: 0, words: 'good', final: false, cut: false, speaker: 'unknown' },
      { id: 0, words: 'good morning', final: false, cut: false, speaker: 'unknown' },
      { id: 0, words: 'good morning all', final: true, cut: false, speaker: 'unknown' },
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

  it('gives a turn to whoever was speaking as most of its words were said', () => {
    const { turns, hear } = listening(['one two three', 'four'])
    hear(sound(200, 'self'))
    hear(sound(700, 'other'))
    hear(sound(300, 'self'))
    expect(turns.map(turn => turn.speaker)).toEqual(['other', 'other', 'other', 'self'])
  })

  it('names the speaker of each turn that one piece of sound finishes, not only of the first', () => {
    const { turns, hear } = listening(['yes', 'no'])
    hear(sound(600, 'self'))
    expect(turns.map(turn => [turn.words, turn.speaker])).toEqual([
      ['yes', 'self'],
      ['no', 'self'],
    ])
  })

  it('ends the turn at a break in the sound, says it was cut, and starts the next line after it', () => {
    const { turns, hear } = listening(['one two three', 'four'])
    hear(sound(300))
    hear(sound(300, 'unknown', true))
    expect(turns.map(({ id, words, final, cut }) => [id, words, final, cut])).toEqual([
      [0, 'one', false, false],
      [0, 'one', true, true],
      [1, 'four', true, false],
    ])
  })

  it('says nothing more once its lifetime has ended', () => {
    const { life, turns, hear } = listening(['one two', 'three'])
    hear(sound(300))
    life.end()
    hear(sound(900))
    expect(turns.map(turn => turn.words)).toEqual(['one'])
  })

  it('says nothing more to a listener that ended the lifetime as it was told a turn', () => {
    const life = new Lifetime()
    const turns: string[] = []
    const hear = scriptedLive(['one two', 'three']).start(life, turn => {
      turns.push(turn.words)
      life.end()
    })
    hear(sound(900))
    expect(turns).toEqual(['one'])
  })

  it('plays the script from its start for each listener, however their sound is mixed', () => {
    const speech = scriptedLive(['one two', 'three four'])
    const heard = { a: [] as string[], b: [] as string[] }
    const a = speech.start(new Lifetime(), turn => heard.a.push(`${turn.id} ${turn.words}`))
    const b = speech.start(new Lifetime(), turn => heard.b.push(`${turn.id} ${turn.words}`))
    a(sound(300))
    b(sound(600))
    a(sound(300, 'unknown', true))
    a(sound(600))
    expect(heard).toEqual({ a: ['0 one', '0 one', '1 three', '1 three four'], b: ['0 one', '0 one two'] })
  })
})
