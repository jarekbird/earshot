import type { Sound } from '../audio.js'
import type { Lifetime, Timer } from '../lifetime.js'

export interface ListenOptions {
  alone?: boolean
  reopenAfterMs?: number | false
}

export interface MicCalls {
  open(): Promise<unknown>
  close(): Promise<unknown>
}

export const MIC_SILENT_MS = 3_000
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 4_000

export const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))

interface Ear {
  hear: (sound: Sound) => void
  alone: boolean
  reopenAfterMs: number | false
}

const report = (error: unknown) => (typeof reportError === 'function' ? reportError(error) : console.error(error))

const answered = async (call: () => Promise<unknown>): Promise<boolean> => {
  try {
    return (await call()) === true
  } catch {
    return false
  }
}

export class Mic {
  readonly #life: Lifetime
  readonly #calls: MicCalls
  readonly #now: () => number
  readonly #ears = new Set<Ear>()
  readonly #told = new Set<(open: boolean) => void>()
  #capturing = false
  #open = false
  #asking = false
  #failures = 0
  #heardAt = 0
  #retry: Timer | undefined
  #watch: Timer | undefined

  constructor(life: Lifetime, calls: MicCalls, now: () => number) {
    this.#life = life
    this.#calls = calls
    this.#now = now
    life.own(() => {
      this.#ears.clear()
      this.#settle()
    })
  }

  get open(): boolean {
    return this.#open
  }

  listen(hear: (sound: Sound) => void, options: ListenOptions = {}): () => void {
    if (this.#life.ended) return () => {}
    const alone = options.alone ?? false
    const ear: Ear = { hear, alone, reopenAfterMs: options.reopenAfterMs ?? (alone ? false : MIC_SILENT_MS) }
    this.#ears.add(ear)
    this.#changed()
    return () => {
      if (this.#ears.delete(ear)) this.#changed()
    }
  }

  #changed(): void {
    this.#retry?.cancel()
    this.#retry = undefined
    this.#settle()
  }

  onChange(listener: (open: boolean) => void): () => void {
    this.#told.add(listener)
    return () => void this.#told.delete(listener)
  }

  heard(sound: Sound): void {
    this.#heardAt = this.#now()
    if (!this.#open && this.#capturing && this.#ears.size > 0) {
      this.#set(true)
      this.#settle()
    }
    for (const ear of this.#hearing()) {
      if (!this.#ears.has(ear)) continue
      try {
        ear.hear(sound)
      } catch (error) {
        report(error)
      }
    }
  }

  #hearing(): Ear[] {
    const ears = [...this.#ears]
    const alone = ears.findLast(ear => ear.alone)
    return alone ? [alone] : ears
  }

  #reopenAfter(): number | false {
    const times = this.#hearing().flatMap(ear => (ear.reopenAfterMs === false ? [] : [ear.reopenAfterMs]))
    return times.length ? Math.min(...times) : false
  }

  #settle(): void {
    if (this.#asking) return
    this.#watch?.cancel()
    this.#watch = undefined
    const wanted = this.#ears.size > 0
    if (wanted ? this.#capturing && this.#open : !this.#capturing) {
      this.#retry?.cancel()
      this.#retry = undefined
      this.#failures = 0
      if (wanted) this.#watchForSilence()
      return
    }
    if (!this.#retry) void this.#ask(wanted)
  }

  // Capture stops without a word when the phone suspends the app, so sound that stops arriving is a closed microphone.
  #watchForSilence(): void {
    const after = this.#reopenAfter()
    if (after === false) return
    const left = this.#heardAt + after - this.#now()
    if (left > 0) {
      this.#watch = this.#life.timeout(() => this.#settle(), left)
      return
    }
    this.#set(false)
    this.#settle()
  }

  async #ask(on: boolean): Promise<void> {
    this.#asking = true
    if (!on) this.#set(false)
    const done = await answered(on ? this.#calls.open : this.#calls.close)
    this.#asking = false
    if (done) {
      this.#capturing = on
      this.#heardAt = this.#now()
    } else {
      this.#retry = this.#life.timeout(() => {
        this.#retry = undefined
        this.#settle()
      }, retryDelay(++this.#failures))
    }
    if (on && done) this.#set(true)
    else if (on && !this.#open && this.#ears.size > 0) this.#tell(false)
    this.#settle()
  }

  #set(open: boolean): void {
    if (this.#open === open) return
    this.#open = open
    this.#tell(open)
  }

  #tell(open: boolean): void {
    for (const listener of [...this.#told]) {
      if (!this.#told.has(listener)) continue
      try {
        listener(open)
      } catch (error) {
        report(error)
      }
    }
  }
}
