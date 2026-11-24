import { SAMPLE_RATE, type Sound, type Speaker } from './audio.js'
import type { Lifetime } from './lifetime.js'
import { serve } from './serve.js'

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

const WORD_BYTES = 300 * ((SAMPLE_RATE * 2) / 1000)

export function most(heard: Record<Speaker, number>): Speaker {
  const [first, second] = (Object.entries(heard) as Array<[Speaker, number]>).sort((a, b) => b[1] - a[1])
  return first[1] > second[1] ? first[0] : 'unknown'
}

export function scriptedLive(lines: readonly string[]): LiveSpeech {
  const script = lines.map(line => line.split(/\s+/).filter(Boolean)).filter(words => words.length)
  return {
    start(life, heard) {
      const left = [...script]
      const news: Turn[] = []
      let id = 0
      let said = 0
      let waiting: Array<[Speaker, number]> = []
      let by: Record<Speaker, number> = { self: 0, other: 0, unknown: 0 }
      let telling = false
      const takeWord = () => {
        if (waiting.reduce((bytes, [, part]) => bytes + part, 0) < WORD_BYTES) return false
        for (let needed = WORD_BYTES; needed > 0;) {
          const [speaker, part] = waiting[0]
          const taken = Math.min(part, needed)
          by[speaker] += taken
          needed -= taken
          if (taken === part) waiting.shift()
          else waiting[0] = [speaker, part - taken]
        }
        return true
      }
      const turn = (final: boolean, cut: boolean) => {
        news.push({ id, words: left[0].slice(0, said).join(' '), final, cut, speaker: most(by) })
        if (!final) return
        left.shift()
        id++
        said = 0
        by = { self: 0, other: 0, unknown: 0 }
      }
      return sound => {
        if (life.ended) return
        if (sound.gap) {
          waiting = []
          if (said > 0) turn(true, true)
        }
        if (left.length && sound.pcm.length) waiting.push([sound.speaker, sound.pcm.length])
        while (left.length && takeWord()) {
          said++
          turn(said === left[0].length, false)
        }
        if (telling) return
        telling = true
        try {
          for (let told = news.shift(); told && !life.ended; told = news.shift()) serve(() => heard(told), 'live speech')
          if (life.ended) news.length = 0
        } finally {
          telling = false
        }
      }
    },
  }
}
