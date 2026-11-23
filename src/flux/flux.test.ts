import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sound, Speaker } from '../audio.js'
import { Lifetime } from '../lifetime.js'
import type { LiveState, Turn } from '../live.js'
import {
  CONNECT_MS,
  FLUX,
  fluxLive,
  HELD_BYTES,
  PIECE_BYTES,
  QUIET_MS,
  REFUSALS,
  retryDelay,
  type FluxOptions,
  type FluxSocket,
} from './flux.js'

const RECORDED = readFileSync(join(import.meta.dirname, 'recorded.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Record<string, unknown>)
const PHRASE = 'what only this phone was told'

class Line implements FluxSocket {
  binaryType = 'blob'
  bufferedAmount = 0
  sent: Array<string | Uint8Array> = []
  closedWith: number | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedWith ??= code ?? 1000
  }
  opens(): void {
    this.onopen?.()
  }
  says(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
  }
  connects(): void {
    this.opens()
    this.says({ type: 'Connected' })
  }
  drops(code = 1006): void {
    this.onclose?.({ code })
  }
  get sound(): number {
    return this.sent.reduce((bytes, data) => bytes + (typeof data === 'string' ? 0 : data.length), 0)
  }
  get marks(): number[] {
    return this.sent.flatMap(data => (typeof data === 'string' ? [] : [data[0]]))
  }
}

const sound = (ms: number, speaker: Speaker = 'unknown', mark = 0, gap = false): Sound => ({
  pcm: new Uint8Array(ms * 32).fill(mark),
  speaker,
  gap,
})
const info = (turn_index: number, transcript: string, event = 'Update', from = 0, to = 1) => ({
  type: 'TurnInfo',
  event,
  turn_index,
  transcript,
  audio_window_start: from,
  audio_window_end: to,
})

function listening(options: Partial<FluxOptions> = {}) {
  const life = new Lifetime()
  const lines: Line[] = []
  const turns: Turn[] = []
  const states: LiveState[] = []
  const speech = fluxLive({
    host: 'https://relay.example/',
    ...options,
    open: url => {
      const line = new Line(url)
      lines.push(line)
      return line
    },
  })
  const hear = speech.start(
    life,
    turn => turns.push(turn),
    state => states.push(state),
  )
  return { life, lines, turns, states, hear }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('the relay of live speech', () => {
  it.each(['http://relay.example', 'ws://relay.example', 'http://127.0.0.2.example'])(
    'is refused when named %s: the secret and the sound would be readable',
    host => {
      expect(() => fluxLive({ host })).toThrow('https')
    },
  )

  it.each(['https://relay.example', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787'])('may be %s', host => {
    expect(() => fluxLive({ host })).not.toThrow()
  })
})

describe('live speech from Flux, through the relay', () => {
  it('says a recorded stream as three turns, each growing under one id and told final once', () => {
    const { lines, turns, hear } = listening()
    hear(sound(100))
    lines[0].opens()
    for (const message of RECORDED) lines[0].says(message)
    expect(turns.filter(turn => turn.final).map(turn => [turn.id, turn.words])).toEqual([
      [0, 'Good morning. Did you get a chance to look at the quarterly numbers I sent on Friday?'],
      [1, 'I did, yes. Revenue is up eleven percent, but support costs worry me.'],
      [2, "Let's put that on the agenda for Thursday."],
    ])
    expect(turns[0]).toEqual({ id: 0, words: 'Goodbye', final: false, cut: false, speaker: 'unknown' })
    expect(turns.map(turn => turn.id)).toEqual(turns.map(turn => turn.id).sort())
    expect(turns.some((turn, at) => at > 0 && !turn.final && !turns[at - 1].final && turns[at - 1].words === turn.words)).toBe(false)
  })

  it('names who spoke most of the stretch of sound a turn was made from', () => {
    const { lines, turns, hear } = listening()
    hear(sound(100, 'other'))
    lines[0].opens()
    lines[0].says(RECORDED[0])
    hear(sound(5_100, 'other'))
    hear(sound(6_560, 'self'))
    hear(sound(3_200, 'other'))
    for (const message of RECORDED.slice(1)) lines[0].says(message)
    expect(turns.filter(turn => turn.final).map(turn => turn.speaker)).toEqual(['other', 'self', 'other'])
  })

  it('names the speaker of each turn from its own stretch of the sound, not from all of it', () => {
    const { lines, turns, hear } = listening()
    hear(sound(1_000, 'self'))
    lines[0].connects()
    hear(sound(1_000, 'other'))
    hear(sound(1_000, 'self'))
    lines[0].says(info(0, 'one', 'EndOfTurn', 0, 1))
    lines[0].says(info(1, 'two', 'EndOfTurn', 1, 2))
    lines[0].says(info(2, 'three', 'EndOfTurn', 2, 3))
    expect(turns.map(turn => turn.speaker)).toEqual(['self', 'other', 'self'])
  })

  it('opens a line to the host the app named, and greets it with the model and the secret before any sound', () => {
    const { lines, hear } = listening({ secret: PHRASE })
    hear(sound(100))
    expect(lines.map(line => line.url)).toEqual(['wss://relay.example/api/v1/live'])
    expect(lines[0].binaryType).toBe('arraybuffer')
    expect(lines[0].sent).toEqual([])
    lines[0].opens()
    expect(lines[0].sent).toEqual([JSON.stringify({ model: FLUX, encoding: 'linear16', sample_rate: '16000', secret: PHRASE })])
  })

  it('asks for the model the app named, and sends no secret when the app has none', () => {
    const { lines, hear } = listening({ model: 'other/model' })
    hear(sound(100))
    lines[0].opens()
    expect(lines[0].sent).toEqual([JSON.stringify({ model: 'other/model', encoding: 'linear16', sample_rate: '16000' })])
  })

  it('holds the sound that comes while it connects, and sends it in order once Flux says it is connected', () => {
    const { lines, hear } = listening()
    hear(sound(100, 'unknown', 1))
    lines[0].opens()
    hear(sound(100, 'unknown', 2))
    expect(lines[0].sound).toBe(0)
    lines[0].says({ type: 'Connected' })
    expect(lines[0].marks).toEqual([1, 2])
    hear(sound(100, 'unknown', 3))
    expect(lines[0].marks).toEqual([1, 2, 3])
    expect(lines).toHaveLength(1)
  })

  it('keeps the last ten seconds exactly, whatever the size of the pieces it was handed', () => {
    const whole = listening()
    whole.hear(sound(12_000, 'unknown', 4))
    whole.lines[0].connects()
    expect(whole.lines[0].sound).toBe(HELD_BYTES)
    const parts = listening()
    parts.hear(sound(9_000, 'unknown', 1))
    parts.hear(sound(2_000, 'unknown', 2))
    parts.lines[0].connects()
    expect(parts.lines[0].sound).toBe(HELD_BYTES)
    expect(parts.lines[0].marks).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2])
  })

  it('cuts held sound between samples, never in the middle of one', () => {
    const { lines, hear } = listening()
    hear({ ...sound(0), pcm: new Uint8Array(HELD_BYTES) })
    hear({ ...sound(0), pcm: new Uint8Array(6).fill(3) })
    hear({ ...sound(0), pcm: new Uint8Array(3).fill(5) })
    lines[0].connects()
    expect(lines[0].sound).toBe(HELD_BYTES - 1)
  })

  it('sends no sound older than the app said is still worth hearing', () => {
    let at = 0
    const { lines, hear } = listening({ staleMs: 4_000, now: () => at })
    hear(sound(100, 'unknown', 1))
    at = 3_000
    hear(sound(100, 'unknown', 2))
    at = 5_000
    lines[0].connects()
    expect(lines[0].marks).toEqual([2])
  })

  it('at a break in the sound ends the turn that was growing as cut, and takes what follows on a new line', () => {
    const { lines, turns, states, hear } = listening()
    hear(sound(100, 'unknown', 1, true))
    expect(lines).toHaveLength(1)
    lines[0].connects()
    lines[0].says(info(0, 'before the'))
    hear(sound(100, 'unknown', 2, true))
    expect(lines[0].closedWith).toBe(1000)
    expect(turns.at(-1)).toEqual({ id: 0, words: 'before the', final: true, cut: true, speaker: 'unknown' })
    expect(lines).toHaveLength(2)
    lines[1].connects()
    expect(lines[1].marks).toEqual([2])
    lines[1].says(info(0, 'after'))
    expect(turns.at(-1)).toMatchObject({ id: 1, words: 'after', cut: false })
    expect(states).toEqual([])
  })

  it('opens no new line at a break when the listener ended the lifetime as it was told of the cut turn', () => {
    const life = new Lifetime()
    const lines: Line[] = []
    const open = (url: string) => lines[lines.push(new Line(url)) - 1]
    const hear = fluxLive({ host: 'https://relay.example', open }).start(life, turn => void (turn.cut && life.end()))
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'before the'))
    hear(sound(100, 'unknown', 2, true))
    expect(lines).toHaveLength(1)
    expect(lines[0].closedWith).toBe(1000)
  })

  it('opens one line, not two, when the app feeds it sound as it is told the line is down', () => {
    const life = new Lifetime()
    const lines: Line[] = []
    const open = (url: string) => lines[lines.push(new Line(url)) - 1]
    const hear = fluxLive({ host: 'https://relay.example', open }).start(
      life,
      () => {},
      state => state === 'down' && hear(sound(100)),
    )
    hear(sound(100))
    lines[0].connects()
    lines[0].drops()
    expect(lines).toHaveLength(1)
    vi.advanceTimersByTime(retryDelay(1))
    expect(lines).toHaveLength(2)
    life.end()
    expect(lines.map(line => line.closedWith !== undefined)).toEqual([true, true])
  })

  it('keeps only the last ten seconds of the sound it cannot send yet', () => {
    const { lines, hear } = listening()
    for (let second = 0; second < 15; second++) hear(sound(1_000, 'unknown', second))
    lines[0].connects()
    expect(lines[0].sound).toBe(HELD_BYTES)
    expect(lines[0].marks[0]).toBe(5)
  })

  it('after a drop ends the turn that was open, opens a new line, and numbers the turns on from where it was', () => {
    const { lines, turns, states, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'first', 'EndOfTurn'))
    lines[0].says(info(1, 'half a'))
    lines[0].drops()
    expect(turns.at(-1)).toEqual({ id: 1, words: 'half a', final: true, cut: true, speaker: 'unknown' })
    expect(states).toEqual(['down'])
    hear(sound(100))
    vi.advanceTimersByTime(retryDelay(1))
    expect(lines).toHaveLength(2)
    lines[1].connects()
    lines[1].says(info(0, 'second line'))
    expect(turns.at(-1)).toEqual({ id: 2, words: 'second line', final: false, cut: false, speaker: 'unknown' })
    expect(states).toEqual(['down', 'on'])
  })

  it('waits longer after each line that fails, up to eight seconds', () => {
    const { lines, hear } = listening()
    hear(sound(100))
    const waits: number[] = []
    for (let failed = 1; failed <= 6; failed++) {
      lines.at(-1)!.drops()
      const before = lines.length
      vi.advanceTimersByTime(retryDelay(failed) - 1)
      expect(lines).toHaveLength(before)
      vi.advanceTimersByTime(1)
      expect(lines).toHaveLength(before + 1)
      waits.push(retryDelay(failed))
    }
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000])
  })

  it('waits the short time again once a line has connected', () => {
    const { lines, hear } = listening()
    hear(sound(100))
    lines[0].drops()
    vi.advanceTimersByTime(retryDelay(1))
    lines[1].drops()
    vi.advanceTimersByTime(retryDelay(2))
    lines[2].connects()
    lines[2].drops()
    hear(sound(100))
    vi.advanceTimersByTime(retryDelay(1))
    expect(lines).toHaveLength(4)
  })

  it('opens no new line after a drop while there is no sound to send', () => {
    const { lines, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].drops()
    vi.advanceTimersByTime(60_000)
    expect(lines).toHaveLength(1)
    hear(sound(100))
    expect(lines).toHaveLength(2)
  })

  it.each(Object.values(REFUSALS))('stops for good when the relay refuses with %i, and says so once', code => {
    const { lines, states, hear } = listening()
    hear(sound(100))
    lines[0].opens()
    lines[0].drops(code)
    hear(sound(100))
    vi.advanceTimersByTime(60_000)
    expect(lines).toHaveLength(1)
    expect(states).toEqual(['refused'])
  })

  it('gives up on a line that does not connect in time, and tries another', () => {
    const { lines, states, hear } = listening()
    hear(sound(100))
    lines[0].opens()
    vi.advanceTimersByTime(CONNECT_MS)
    expect(lines[0].closedWith).toBeDefined()
    expect(states).toEqual(['down'])
    vi.advanceTimersByTime(retryDelay(1))
    expect(lines).toHaveLength(2)
  })

  it('closes the line when no sound has come for a while, ending the open turn, and opens one at the next sound', () => {
    const { lines, turns, states, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'trailing'))
    vi.advanceTimersByTime(QUIET_MS - 1)
    expect(lines[0].closedWith).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(lines[0].closedWith).toBe(1000)
    expect(turns.at(-1)).toEqual({ id: 0, words: 'trailing', final: true, cut: true, speaker: 'unknown' })
    hear(sound(100))
    expect(lines).toHaveLength(2)
    lines[1].connects()
    lines[1].says(info(0, 'again'))
    expect(turns.at(-1)).toMatchObject({ id: 1, words: 'again' })
    expect(states).toEqual([])
  })

  it('keeps trying to send the sound it holds, however long ago the last of it came', () => {
    const { lines, hear } = listening()
    hear(sound(100, 'unknown', 7))
    lines[0].drops()
    vi.advanceTimersByTime(QUIET_MS * 3)
    lines.at(-1)!.connects()
    expect(lines.at(-1)!.marks).toEqual([7])
    vi.advanceTimersByTime(QUIET_MS)
    expect(lines.at(-1)!.closedWith).toBe(1000)
  })

  it('drops a line whose sound is not getting out, and opens another', () => {
    const { lines, states, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].bufferedAmount = HELD_BYTES + 1
    hear(sound(100))
    expect(lines[0].closedWith).toBeDefined()
    expect(states).toEqual(['down'])
    vi.advanceTimersByTime(retryDelay(1))
    expect(lines).toHaveLength(2)
  })

  it('does not reopen a turn that has ended, and does not tell the same words twice', () => {
    const { lines, turns, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'one'))
    lines[0].says(info(0, 'one'))
    lines[0].says(info(0, 'one', 'EndOfTurn'))
    lines[0].says(info(0, 'one more'))
    expect(turns).toEqual([
      { id: 0, words: 'one', final: false, cut: false, speaker: 'unknown' },
      { id: 0, words: 'one', final: true, cut: false, speaker: 'unknown' },
    ])
  })

  it('ends a turn that was still growing when Flux goes on to the next one', () => {
    const { lines, turns, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'one'))
    lines[0].says(info(1, 'two'))
    expect(turns.map(turn => [turn.id, turn.words, turn.final, turn.cut])).toEqual([
      [0, 'one', false, false],
      [0, 'one', true, true],
      [1, 'two', false, false],
    ])
  })

  it('says a turn was cut only when the line or the sound ended it, never when Flux did', () => {
    const { lines, turns, hear } = listening()
    hear(sound(100))
    lines[0].opens()
    for (const message of RECORDED) lines[0].says(message)
    expect(turns.filter(turn => turn.cut)).toEqual([])
    lines[0].says(info(3, 'and then'))
    lines[0].drops()
    expect(turns.at(-1)).toMatchObject({ words: 'and then', final: true, cut: true })
  })

  it('says nothing more to a listener that ended the lifetime as it was told a turn', () => {
    const life = new Lifetime()
    const lines: Line[] = []
    const told: string[] = []
    const open = (url: string) => lines[lines.push(new Line(url)) - 1]
    const hear = fluxLive({ host: 'https://relay.example', open }).start(life, turn => {
      told.push(`${turn.words}${turn.final ? '.' : ''}`)
      if (turn.final) life.end()
    })
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'one'))
    lines[0].says(info(1, 'two'))
    expect(told).toEqual(['one', 'one.'])
  })

  it('sends a long piece of sound a second at a time, so the relay takes it', () => {
    const { lines, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    hear(sound(3_000, 'unknown', 9))
    const pieces = lines[0].sent.slice(2).map(data => (data as Uint8Array).length)
    expect(pieces).toEqual([PIECE_BYTES, PIECE_BYTES, PIECE_BYTES])
    expect(lines[0].marks.slice(1)).toEqual([9, 9, 9])
  })

  it('keeps a line that connected, however long the sound goes on', () => {
    const { lines, states, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    for (let second = 1; second <= CONNECT_MS / 1_000 + 1; second++) {
      vi.advanceTimersByTime(1_000)
      hear(sound(100))
    }
    expect(lines[0].closedWith).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(states).toEqual([])
  })

  it.each([['not json'], [{ type: 'Other' }], [{ type: 'TurnInfo', turn_index: 'x', transcript: 'a' }], [info(0, '   ')], [null], [[1]]])(
    'tells nothing for a message that is not a turn with words: %j',
    message => {
      const { lines, turns, hear } = listening()
      hear(sound(100))
      lines[0].connects()
      lines[0].says(message)
      expect(turns).toEqual([])
    },
  )

  it('ends with the lifetime: the line closes, and nothing more is told or sent', () => {
    const { life, lines, turns, states, hear } = listening()
    hear(sound(100))
    lines[0].connects()
    lines[0].says(info(0, 'so far'))
    life.end()
    expect(lines[0].closedWith).toBe(1000)
    lines[0].says(info(0, 'so far and more'))
    lines[0].drops()
    hear(sound(100))
    vi.advanceTimersByTime(60_000)
    expect(turns).toEqual([{ id: 0, words: 'so far', final: false, cut: false, speaker: 'unknown' }])
    expect(states).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0].sound).toBe(3_200)
  })
})
