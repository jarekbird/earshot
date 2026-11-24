import type { Screen } from '../router.js'
import type { View } from '../view.js'
import type { TextState } from './layout.js'

export type Words = Extract<View, { kind: 'text' }>

export interface Read {
  view: Words
  state: TextState
}

export interface Sent {
  readonly shown: number
  readonly sending: number
}

interface Asked {
  frame: number
  screen: Screen
  drew: Read | null
}

export class Frames {
  readonly #sent: Sent
  readonly #swiped = new WeakMap<Screen, { frame: number; to: Read }>()
  #asked: Asked[] = []

  constructor(sent: Sent) {
    this.#sent = sent
  }

  get kept(): number {
    return this.#asked.length
  }

  get screen(): Screen | undefined {
    this.#forget()
    const first = this.#asked[0]
    return first && first.frame <= this.#sent.shown ? first.screen : undefined
  }

  asked(frame: number, screen: Screen, drew: Read | null, swipedTo: Read | null): void {
    this.#asked.push({ frame, screen, drew })
    if (swipedTo) this.#swiped.set(screen, { frame, to: swipedTo })
    this.#forget()
  }

  read(screen: Screen): Read | null {
    this.#forget()
    const { shown } = this.#sent
    const swiped = this.#swiped.get(screen)
    if (swiped && swiped.frame > shown) return swiped.to
    this.#swiped.delete(screen)
    const mine = this.#asked.filter(asked => asked.screen === screen && asked.drew)
    return (mine[0]?.frame <= shown ? mine[0] : mine.at(-1))?.drew ?? null
  }

  #forget(): void {
    const { shown, sending } = this.#sent
    const seen = this.#asked.findLastIndex(asked => asked.frame <= shown)
    this.#asked = this.#asked.filter((asked, at, all) => at === seen || (at > seen && (asked.frame === sending || at === all.length - 1)))
  }
}
