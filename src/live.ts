import { SAMPLE_RATE, type Sound, type Speaker } from './audio.js'
import type { Lifetime } from './lifetime.js'

export interface Turn {
  id: number
  words: string
  final: boolean
  speaker: Speaker
}

export interface LiveSpeech {
  start(life: Lifetime, heard: (turn: Turn) => void): (sound: Sound) => void
}

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

function most(heard: Record<Speaker, number>): Speaker {
  const [first, second] = (Object.entries(heard) as Array<[Speaker, number]>).sort((a, b) => b[1] - a[1])
  return first[1] > second[1] ? first[0] : 'unknown'
}

export function scriptedLive(lines: readonly string[], msPerWord = 300): LiveSpeech {
  const left = lines.map(line => line.split(/\s+/).filter(Boolean)).filter(words => words.length)
  return {
    start(life, heard) {
      let id = 0
      let said = 0
      let waiting = 0
      let by: Record<Speaker, number> = { self: 0, other: 0, unknown: 0 }
      const turn = (final: boolean) => heard({ id, words: left[0].slice(0, said).join(' '), final, speaker: most(by) })
      const next = () => {
        left.shift()
        id++
        said = 0
        by = { self: 0, other: 0, unknown: 0 }
      }
      life.own(() => void (said > 0 && left.shift()))
      return sound => {
        if (life.ended) return
        if (sound.gap && said > 0) {
          turn(true)
          next()
        }
        waiting += sound.pcm.length
        by[sound.speaker] += sound.pcm.length
        while (left.length && waiting >= msPerWord * BYTES_PER_MS) {
          waiting -= msPerWord * BYTES_PER_MS
          said++
          const final = said === left[0].length
          turn(final)
          if (final) next()
        }
      }
    },
  }
}
