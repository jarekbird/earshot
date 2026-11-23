import { SAMPLE_RATE, type Sound, type Speaker } from './audio.js'
import type { Lifetime } from './lifetime.js'

export interface Turn {
  id: number
  words: string
  final: boolean
  cut: boolean
  speaker: Speaker
}

export type LiveState = 'on' | 'down' | 'refused'

export interface LiveSpeech {
  start(life: Lifetime, heard: (turn: Turn) => void, told?: (state: LiveState) => void): (sound: Sound) => void
}

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

export function most(heard: Record<Speaker, number>): Speaker {
  const [first, second] = (Object.entries(heard) as Array<[Speaker, number]>).sort((a, b) => b[1] - a[1])
  return first[1] > second[1] ? first[0] : 'unknown'
}

export function scriptedLive(lines: readonly string[], msPerWord = 300): LiveSpeech {
  const script = lines.map(line => line.split(/\s+/).filter(Boolean)).filter(words => words.length)
  return {
    start(life, heard) {
      const left = [...script]
      let id = 0
      let said = 0
      let waiting = 0
      let by: Record<Speaker, number> = { self: 0, other: 0, unknown: 0 }
      const turn = (final: boolean, cut: boolean) => heard({ id, words: left[0].slice(0, said).join(' '), final, cut, speaker: most(by) })
      const next = () => {
        left.shift()
        id++
        said = 0
        by = { self: 0, other: 0, unknown: 0 }
      }
      return sound => {
        if (life.ended) return
        if (sound.gap && said > 0) {
          turn(true, true)
          next()
        }
        waiting += sound.pcm.length
        while (!life.ended && left.length && waiting >= msPerWord * BYTES_PER_MS) {
          waiting -= msPerWord * BYTES_PER_MS
          said++
          by[sound.speaker]++
          const final = said === left[0].length
          turn(final, false)
          if (final) next()
        }
      }
    },
  }
}
