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
  drop(frame: number): void
}

export const PROGRESS = Symbol('how far the glasses are with the frames asked of them')

export const copied = (view: Words): Words =>
  text({ ...(view.title === undefined ? {} : { title: view.title }), body: view.body, end: view.end }) as Words

export interface Seen<On> {
  showing: unknown
  kind: View['kind']
  on: On | undefined
}

interface Asked<On> extends Seen<On> {
  frame: number
  drew: Read | null
}

export class Frames<On = never> {
  readonly #progress: Progress
  readonly #swiped = new Map<unknown, { frame: number; to: Read }>()
  #asked: Asked<On>[] = []
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

  get menu(): unknown {
    this.forget()
    return this.#asked.findLast(asked => asked.frame <= this.#progress.menu)?.showing
  }

  get words(): Seen<On> | undefined {
    this.forget()
    return this.#asked.findLast(asked => asked.frame <= this.#read())
  }

  get page(): Seen<On> | undefined {
    this.forget()
    return this.#asked.findLast(asked => asked.frame <= this.#progress.menu)
  }

  swiping(showing: unknown, to: Read): void {
    if (!this.#ended) this.#swiped.set(showing, { frame: Infinity, to })
  }

  asked(frame: number, showing: unknown, drew: Read | null, kind: View['kind'] = 'text', on?: On): void {
    if (this.#ended) return
    const later = this.#asked.findIndex(asked => asked.frame > frame)
    this.#asked.splice(later < 0 ? this.#asked.length : later, 0, { frame, showing, kind, drew, on })
    const swiped = this.#swiped.get(showing)
    if (swiped?.frame === Infinity) swiped.frame = frame
    this.forget()
  }

  left(onPath: (showing: unknown) => boolean): void {
    for (const showing of [...this.#swiped.keys()]) if (!onPath(showing)) this.#swiped.delete(showing)
    for (const asked of this.#asked) if (!onPath(asked.showing)) asked.drew = null
  }

  read(showing: unknown): Read | null {
    this.forget()
    const swiped = this.#swiped.get(showing)
    if (swiped) return swiped.to
    const mine = this.#asked.filter(asked => asked.showing === showing && asked.drew)
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
    for (const [showing, swiped] of this.#swiped) {
      const drawn = (asked: Asked<On>) => asked.showing === showing && asked.frame >= swiped.frame && asked.frame <= read
      if (this.#asked.some(drawn)) this.#swiped.delete(showing)
    }
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
