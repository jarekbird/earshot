import { text, type View } from '../view.js'
import type { TextState } from './layout.js'

type Words = Extract<View, { kind: 'text' }>

export interface Read {
  view: Words
  state: TextState
}

interface Since {
  follow: number
  cap: number
  ends: boolean
}

const NONE: Since = { follow: Infinity, cap: Infinity, ends: false }

const and = (since: Since, drawn: { last: number; end: boolean }): Since =>
  drawn.end
    ? { follow: since.cap >= drawn.last ? Math.min(since.follow, drawn.last) : since.follow, cap: since.cap, ends: true }
    : { ...since, cap: Math.min(since.cap, drawn.last) }

export const after = (since: Since, { top, away }: TextState): TextState =>
  away
    ? top >= since.follow
      ? { top: 0, away: false }
      : { top: Math.min(top, since.cap), away: true }
    : since.ends
      ? { top: 0, away: false }
      : { top: Math.min(top, since.cap), away: false }

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
  card(): string | null
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
  since: Since
}

export class Frames {
  readonly #progress: Progress
  readonly #swiped = new Map<unknown, { frame: number; to: Read; since: Since }>()
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

  swiping(showing: unknown, to: Read, since: Since = NONE): void {
    if (!this.#ended) this.#swiped.set(showing, { frame: Infinity, to, since })
  }

  drawing(showing: unknown, view: Read['view'], last: number): void {
    const drawn = { last, end: view.end === true }
    for (const asked of this.#asked) if (asked.showing === showing) asked.since = and(asked.since, drawn)
    const swiped = this.#swiped.get(showing)
    if (swiped) swiped.since = and(swiped.since, drawn)
  }

  asked(frame: number, showing: unknown, drew: Read | null, kind: View['kind'] = 'text'): void {
    if (this.#ended) return
    const later = this.#asked.findIndex(asked => asked.frame > frame)
    this.#asked.splice(later < 0 ? this.#asked.length : later, 0, { frame, showing, kind, drew, since: NONE })
    const swiped = this.#swiped.get(showing)
    if (swiped?.frame === Infinity) swiped.frame = frame
    this.forget()
  }

  left(onPath: (showing: unknown) => boolean): void {
    for (const showing of [...this.#swiped.keys()]) if (!onPath(showing)) this.#swiped.delete(showing)
    for (const asked of this.#asked) if (!onPath(asked.showing)) asked.drew = null
  }

  read(showing: unknown): (Read & { since: Since }) | null {
    this.forget()
    const swiped = this.#swiped.get(showing)
    if (swiped) return { ...swiped.to, since: swiped.since }
    const mine = this.#asked.filter(asked => asked.showing === showing && asked.drew)
    const read = mine.find(asked => asked.frame === this.#progress.text) ?? mine.at(-1)
    return read?.drew ? { ...read.drew, since: read.since } : null
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
