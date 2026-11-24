import type { Screen } from '../router.js'
import type { View } from '../view.js'
import type { TextState } from './layout.js'

export type Words = Extract<View, { kind: 'text' }>

export interface Read {
  view: Words
  state: TextState
}

export interface Progress {
  readonly shown: number
  readonly text: number
  readonly sending: number
}

export const PROGRESS = Symbol('how far the glasses are with the frames asked of them')

interface Asked {
  frame: number
  screen: Screen
  drew: Read | null
}

export class Frames {
  readonly #progress: Progress
  readonly #swiped = new Map<Screen, { frame: number; to: Read }>()
  #asked: Asked[] = []

  constructor(progress: Progress) {
    this.#progress = progress
  }

  get kept(): number {
    return this.#asked.length + this.#swiped.size
  }

  get screen(): Screen | undefined {
    this.#forget()
    return this.#asked.findLast(asked => asked.frame <= this.#progress.shown)?.screen
  }

  asked(frame: number, screen: Screen, drew: Read | null, swipedTo: Read | null): void {
    const later = this.#asked.findIndex(asked => asked.frame > frame)
    this.#asked.splice(later < 0 ? this.#asked.length : later, 0, { frame, screen, drew })
    if (swipedTo) this.#swiped.set(screen, { frame, to: swipedTo })
    this.#forget()
  }

  read(screen: Screen): Read | null {
    this.#forget()
    const swiped = this.#swiped.get(screen)
    if (swiped) return swiped.to
    const mine = this.#asked.filter(asked => asked.screen === screen && asked.drew)
    return (mine.findLast(asked => asked.frame <= this.#read()) ?? mine.at(-1))?.drew ?? null
  }

  #read(): number {
    return Math.max(this.#progress.shown, this.#progress.text)
  }

  #forget(): void {
    const { shown, sending } = this.#progress
    const read = this.#read()
    const menu = this.#asked.findLastIndex(asked => asked.frame <= shown)
    const text = this.#asked.findLastIndex(asked => asked.frame <= read)
    const newest = this.#asked.length - 1
    this.#asked = this.#asked.filter((asked, at) => at === menu || at === text || at === newest || (at > text && asked.frame === sending))
    for (const [screen, swiped] of this.#swiped) if (swiped.frame <= read) this.#swiped.delete(screen)
  }
}
