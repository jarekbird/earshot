import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SAMPLE_RATE, type Sound, type Speaker } from './audio.js'
import { fluxOver, type FluxSocket } from './flux/flux.js'
import { Lifetime } from './lifetime.js'
import { scriptedLive, type LiveSpeech, type Turn } from './live.js'

const BYTES_PER_S = SAMPLE_RATE * 2
const WORD_BYTES = 0.3 * BYTES_PER_S
const sound = (ms: number, speaker: Speaker = 'unknown', gap = false): Sound => ({ pcm: new Uint8Array(ms * 32), speaker, gap })

interface Service {
  speech: LiveSpeech
  answers(): void
}

function standIn(lines: string[]): Service {
  return { speech: scriptedLive(lines), answers: () => {} }
}

class Line implements FluxSocket {
  binaryType = ''
  readyState = 1
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  greeted = false
  unheard = 0
  heard = 0
  turn = 0
  from = 0
  said = 0
  closed = false
  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') this.unheard += data.length
  }
  close(): void {
    this.closed = true
  }
}

function realTransport(lines: string[]): Service {
  const script = lines.map(line => line.split(/\s+/).filter(Boolean))
  const sockets: Line[] = []
  let at = 0
  let open: Line | undefined
  const speech = fluxOver(
    { host: 'https://relay.example', secret: 'what only this phone was told' },
    { now: () => 0, open: () => sockets[sockets.push(new Line()) - 1] },
  )
  const answers = () => {
    for (let quiet = false; !quiet;) {
      quiet = true
      const line = sockets.find(socket => !socket.closed && (!socket.greeted || socket.unheard >= WORD_BYTES))
      if (!line) return
      quiet = false
      if (line !== open) {
        if (open && open.said > 0) at++
        open = line
      }
      if (!line.greeted) {
        line.greeted = true
        line.onopen?.()
        line.onmessage?.({ data: JSON.stringify({ type: 'Connected' }) })
        continue
      }
      line.unheard -= WORD_BYTES
      line.heard += WORD_BYTES
      const words = script[at]
      if (!words) continue
      line.said++
      const final = line.said === words.length
      line.onmessage?.({
        data: JSON.stringify({
          type: 'TurnInfo',
          event: final ? 'EndOfTurn' : 'Update',
          turn_index: line.turn,
          transcript: words.slice(0, line.said).join(' '),
          audio_window_start: line.from / BYTES_PER_S,
          audio_window_end: line.heard / BYTES_PER_S,
        }),
      })
      if (!final) continue
      at++
      line.turn++
      line.said = 0
      line.from = line.heard
    }
  }
  return { speech, answers }
}

const BOTH: Array<[string, (lines: string[]) => Service]> = [
  ['the offline stand-in', standIn],
  ['the transport for real speech, with a service that says the same lines', realTransport],
]

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe.each(BOTH)('E16: live speech, as %s gives it', (_name, make) => {
  function listening(lines: string[], heard: (turn: Turn, feed: (sound: Sound) => void, life: Lifetime) => void = () => {}) {
    const life = new Lifetime()
    onTestFinished(() => life.end())
    const turns: Turn[] = []
    const { speech, answers } = make(lines)
    const hear = speech.start(life, turn => {
      turns.push({ ...turn })
      heard(turn, feed, life)
    })
    const feed = (given: Sound) => {
      hear(given)
      answers()
    }
    return { life, turns, feed }
  }
  const told = (turns: Turn[]) => turns.map(({ id, words, final, cut }) => [id, words, final, cut])

  it('tells a turn as it grows, under one id, and calls it final at its last word', () => {
    const { turns, feed } = listening(['good morning all'])
    feed(sound(300))
    feed(sound(600))
    expect(told(turns)).toEqual([
      [0, 'good', false, false],
      [0, 'good morning', false, false],
      [0, 'good morning all', true, false],
    ])
  })

  it('goes on to the next line as a new turn, numbered on', () => {
    const { turns, feed } = listening(['yes', 'no'])
    feed(sound(300))
    feed(sound(300))
    expect(told(turns)).toEqual([
      [0, 'yes', true, false],
      [1, 'no', true, false],
    ])
  })

  it('at a break in the sound ends the turn that was growing as final and cut, and tells what follows as a new turn', () => {
    const { turns, feed } = listening(['one two three', 'four'])
    feed(sound(300))
    feed(sound(300, 'unknown', true))
    expect(told(turns)).toEqual([
      [0, 'one', false, false],
      [0, 'one', true, true],
      [1, 'four', true, false],
    ])
  })

  it('names as speaker whoever spoke most of the sound a turn was made from', () => {
    const { turns, feed } = listening(['one two'])
    feed(sound(200, 'self'))
    feed(sound(400, 'other'))
    expect(turns.map(turn => [turn.words, turn.speaker])).toEqual([
      ['one', 'self'],
      ['one two', 'other'],
    ])
  })

  it('never tells a listener of a turn while it is still telling it of another, also when the listener feeds it sound from there', () => {
    let inside = 0
    let deepest = 0
    const { turns, feed } = listening(['one two three'], (turn, more) => {
      deepest = Math.max(deepest, ++inside)
      if (turn.words === 'one') more(sound(600))
      inside--
    })
    feed(sound(300))
    expect(told(turns).map(([, words]) => words)).toEqual(['one', 'one two', 'one two three'])
    expect(deepest).toBe(1)
  })

  it('says nothing more to a listener that ended the lifetime as it was told a turn', () => {
    const { turns, feed } = listening(['one two three'], (_turn, _feed, life) => life.end())
    feed(sound(900))
    feed(sound(300))
    expect(told(turns)).toEqual([[0, 'one', false, false]])
  })

  it('hands the listener a turn of its own: changing it changes nothing that is told later', () => {
    const { turns, feed } = listening(['one two'], turn => {
      turn.words = 'changed'
      turn.id = 99
    })
    feed(sound(300))
    feed(sound(300))
    expect(told(turns)).toEqual([
      [0, 'one', false, false],
      [0, 'one two', true, false],
    ])
  })

  it('says only that a listener failed, never the words it was handed, and goes on telling', () => {
    const said: string[] = []
    vi.stubGlobal('reportError', (error: Error) => void said.push(error.message))
    onTestFinished(() => void vi.unstubAllGlobals())
    const { turns, feed } = listening(['confidential words'], turn => {
      throw new Error(turn.words)
    })
    feed(sound(300))
    feed(sound(300))
    expect(said).toEqual(['Earshot: a listener of the live speech threw.', 'Earshot: a listener of the live speech threw.'])
    expect(turns).toHaveLength(2)
  })

  it('takes no sound and tells nothing once its lifetime has ended', () => {
    const { life, turns, feed } = listening(['one two'])
    feed(sound(300))
    life.end()
    feed(sound(300))
    expect(told(turns)).toEqual([[0, 'one', false, false]])
  })

  it('tells nothing for a piece of sound with nothing in it', () => {
    const { turns, feed } = listening(['one'])
    feed(sound(0))
    expect(turns).toEqual([])
  })
})
