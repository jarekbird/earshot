import type { Lifetime, Timer } from './lifetime.js'

export type Compact = (text: string, limit: number) => Promise<string>

export interface ContextOptions {
  limit?: number
  settleMs?: number
  compact?: Compact
}

export const ITEM_LIMIT = 1_200
const SETTLE_MS = 5_000

interface Entry {
  text: string
  fitted: string | undefined
  busy: boolean
  still: Timer | undefined
  waiting: boolean
}

export class Context {
  readonly #life: Lifetime
  readonly #limit: number
  readonly #settleMs: number
  readonly #compact: Compact | undefined
  readonly #entries = new Map<string, Entry>()

  constructor(life: Lifetime, options: ContextOptions = {}) {
    this.#life = life
    this.#limit = options.limit ?? ITEM_LIMIT
    this.#settleMs = options.settleMs ?? SETTLE_MS
    this.#compact = options.compact
  }

  get(key: string): string {
    const entry = this.#entries.get(key)
    return entry ? (entry.fitted ?? entry.text.slice(-this.#limit)) : ''
  }

  set(key: string, text: string): void {
    const entry = this.#entries.get(key) ?? { text: '', fitted: undefined, busy: false, still: undefined, waiting: false }
    this.#entries.set(key, entry)
    if (entry.text === text) return
    entry.text = text
    entry.fitted = undefined
    entry.still?.cancel()
    entry.still = undefined
    entry.waiting = false
    if (text.length <= this.#limit || !this.#compact || this.#life.ended) return
    if (!entry.busy) return this.#start(key, entry, this.#compact)
    entry.still = this.#life.timeout(() => {
      entry.still = undefined
      if (entry.busy) entry.waiting = true
      else if (this.#compact) this.#start(key, entry, this.#compact)
    }, this.#settleMs)
  }

  forget(key: string): void {
    this.#entries.get(key)?.still?.cancel()
    this.#entries.delete(key)
  }

  #start(key: string, entry: Entry, compact: Compact): void {
    const text = entry.text
    entry.busy = true
    const done = (fitted: string | undefined) => {
      entry.busy = false
      if (this.#entries.get(key) !== entry) return
      if (entry.text === text) entry.fitted = fitted?.slice(0, this.#limit)
      else if (entry.waiting) {
        entry.waiting = false
        this.#start(key, entry, compact)
      }
    }
    this.#life.guard(compact(text, this.#limit)).then(done, () => done(undefined))
  }
}
