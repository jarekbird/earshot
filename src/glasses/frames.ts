import { text, type View } from '../view.js'
import type { TextState } from './layout.js'

type Words = Extract<View, { kind: 'text' }>

export interface Read {
  view: Words
  state: TextState
}

interface Progress {
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
  drop(frames: readonly number[]): void
}

export const copied = (view: Words): Words =>
  text({ ...(view.title === undefined ? {} : { title: view.title }), body: view.body, end: view.end }) as Words

interface Asked {
  frame: number
  showing: unknown
  kind: View['kind']
  drew: Read | null
}

export class Frames {
  readonly #progress: Progress
  readonly #swiped = new Map<unknown, { frame: number; to: Read }>()
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

  get menu(): unknown {
    this.forget()
    return this.#asked.find(asked => asked.frame === this.#progress.menu)?.showing
  }

  get words(): { showing: unknown; kind: View['kind'] } | undefined {
    this.forget()
    return this.#asked.find(asked => asked.frame === this.#progress.text)
  }

  swiping(showing: unknown, to: Read): void {
    if (!this.#ended) this.#swiped.set(showing, { frame: Infinity, to })
  }

  asked(frame: number, showing: unknown, drew: Read | null, kind: View['kind'] = 'text'): void {
    if (this.#ended) return
    const later = this.#asked.findIndex(asked => asked.frame > frame)
    this.#asked.splice(later < 0 ? this.#asked.length : later, 0, { frame, showing, kind, drew })
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
    return (mine.find(asked => asked.frame === this.#progress.text) ?? mine.at(-1))?.drew ?? null
  }

  forget(): void {
    const { menu, text, sending } = this.#progress
    const newest = this.#asked.at(-1)
    for (const asked of this.#asked) if (asked.frame === menu && asked.frame < text) asked.drew = null
    this.#asked = this.#asked.filter(asked => asked.frame === menu || asked.frame === text || asked.frame === sending || asked === newest)
    for (const [showing, swiped] of this.#swiped) {
      const drawn = (asked: Asked) => asked.showing === showing && asked.frame >= swiped.frame && asked.frame === text
      if (this.#asked.some(drawn)) this.#swiped.delete(showing)
    }
  }

  end(): void {
    this.#ended = true
    this.#asked = []
    this.#swiped.clear()
  }
}
