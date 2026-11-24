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

  it('gives a turn to whoever spoke most of the sound it was made from, as the transport for real speech does', () => {
    const { turns, hear } = listening(['one two three', 'four'])
    hear(sound(200, 'self'))
    hear(sound(700, 'other'))
    hear(sound(300, 'self'))
    expect(turns.map(turn => turn.speaker)).toEqual(['self', 'other', 'other', 'self'])
  })

  it('does not hand a word to whoever spoke only its last moment', () => {
    const { turns, hear } = listening(['yes'])
    hear(sound(299, 'self'))
    hear(sound(1, 'other'))
    expect(turns.map(turn => [turn.words, turn.speaker])).toEqual([['yes', 'self']])
  })

  it('counts nothing from before a break towards the next word', () => {
    const { turns, hear } = listening(['one two', 'three'])
    hear(sound(299))
    hear(sound(1, 'unknown', true))
    expect(turns).toEqual([])
    hear(sound(550))
    hear(sound(50, 'unknown', true))
    expect(turns.map(turn => `${turn.id} ${turn.words}${turn.cut ? ' cut' : ''}`)).toEqual(['0 one', '0 one cut'])
  })

  it('names the speaker of each turn that one piece of sound finishes, not only of the first', () => {
    const { turns, hear } = listening(['yes', 'no'])
    hear(sound(600, 'self'))
    expect(turns.map(turn => [turn.words, turn.speaker])).toEqual([
      ['yes', 'self'],
      ['no', 'self'],
    ])
  })

  it('at a break in the sound ends the turn that was growing as cut, as the transport for real speech does', () => {
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

  it('has moved on to the next line before it tells of a final turn, so a listener that feeds it sound from there hears the next line', () => {
    const turns: string[] = []
    const hear = scriptedLive(['one', 'two']).start(new Lifetime(), turn => {
      turns.push(`${turn.id} ${turn.words}${turn.final ? '.' : ''}`)
      if (turn.words === 'one') hear(sound(300))
    })
    hear(sound(300))
    expect(turns).toEqual(['0 one.', '1 two.'])
  })

  it('takes the sound that marked a break before it tells of the turn the break cut, so sound fed from there comes after it', () => {
    const turns: string[] = []
    const hear = scriptedLive(['one two', 'three four']).start(new Lifetime(), turn => {
      turns.push(`${turn.words} ${turn.speaker}${turn.cut ? ' cut' : ''}`)
      if (turn.cut) hear(sound(300, 'other'))
    })
    hear(sound(300, 'self'))
    hear(sound(300, 'self', true))
    expect(turns).toEqual(['one self', 'one self cut', 'three self', 'three four unknown'])
  })

  it('takes no more sound in once its last line is said', () => {
    const { turns, hear } = listening(['yes'])
    hear(sound(450))
    for (let more = 0; more < 5; more++) hear(sound(300))
    hear(sound(300, 'unknown', true))
    expect(turns.map(turn => turn.words)).toEqual(['yes'])
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
