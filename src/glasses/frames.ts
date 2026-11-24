import type { Screen } from '../router.js'
import { text, type View } from '../view.js'
import type { TextState } from './layout.js'

export type Words = Extract<View, { kind: 'text' }>

export interface Read {
  view: Words
  state: TextState
}

export interface Progress {
  readonly shown: number
  readonly menu: number
  readonly text: number
  readonly sending: number
}

export interface Sent {
  readonly shown: number
  readonly menu: number
  readonly sending: number
  has(box: string): number
  onChange(told: () => void): () => void
}

export const PROGRESS = Symbol('how far the glasses are with the frames asked of them')

export const copied = (view: Words): Words =>
  text({ ...(view.title === undefined ? {} : { title: view.title }), body: view.body, end: view.end }) as Words

interface Asked {
  frame: number
  screen: Screen
  drew: Read | null
}

export class Frames {
  readonly #progress: Progress
  readonly #swiped = new Map<Screen, { frame: number; to: Read }>()
  #asked: Asked[] = []
  #ended = false

  constructor(progress: Progress) {
    this.#progress = progress
  }

  get kept(): number {
    return this.#asked.length + this.#swiped.size
  }

  get texts(): number {
    return this.#asked.filter(asked => asked.drew).length + this.#swiped.size
  }

  get screen(): Screen | undefined {
    this.forget()
    return this.#asked.findLast(asked => asked.frame <= this.#progress.menu)?.screen
  }

  swiping(screen: Screen, to: Read): void {
    if (!this.#ended) this.#swiped.set(screen, { frame: Infinity, to })
  }

  asked(frame: number, screen: Screen, drew: Read | null): void {
    if (this.#ended) return
    const later = this.#asked.findIndex(asked => asked.frame > frame)
    this.#asked.splice(later < 0 ? this.#asked.length : later, 0, { frame, screen, drew })
    const swiped = this.#swiped.get(screen)
    if (swiped?.frame === Infinity) swiped.frame = frame
    this.forget()
  }

  left(gone: (screen: Screen) => boolean): void {
    for (const screen of [...this.#swiped.keys()]) if (gone(screen)) this.#swiped.delete(screen)
  }

  read(screen: Screen): Read | null {
    this.forget()
    const swiped = this.#swiped.get(screen)
    if (swiped) return swiped.to
    const mine = this.#asked.filter(asked => asked.screen === screen && asked.drew)
    return (mine.findLast(asked => asked.frame <= this.#read()) ?? mine.at(-1))?.drew ?? null
  }

  forget(): void {
    const { menu: built, sending } = this.#progress
    const read = this.#read()
    const menu = this.#asked.findLastIndex(asked => asked.frame <= built)
    const words = this.#asked.findLastIndex(asked => asked.frame <= read)
    const newest = this.#asked.length - 1
    if (menu >= 0 && menu < words) this.#asked[menu].drew = null
    this.#asked = this.#asked.filter((asked, at) => at === menu || at === words || at === newest || (at > words && asked.frame === sending))
    for (const [screen, swiped] of this.#swiped) if (swiped.frame <= read) this.#swiped.delete(screen)
  }

  end(): void {
    this.#ended = true
    this.#asked = []
    this.#swiped.clear()
  }

  #read(): number {
    return Math.max(this.#progress.shown, this.#progress.menu, this.#progress.text)
  }
}
