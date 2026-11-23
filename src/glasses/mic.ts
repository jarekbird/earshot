import type { Sound } from '../audio.js'
import { Lifetime, type Timer } from '../lifetime.js'

export interface ListenOptions {
  reopenAfterMs?: number | false
}

export interface MicCalls {
  open(): Promise<unknown>
  close(): Promise<unknown>
}

export const HOLD = Symbol('the microphone, for a hold alone')
export const MIC_SILENT_MS = 3_000
export const MIN_REOPEN_MS = 500
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 4_000
const CLOSES_AFTER_THE_END = 5

export const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))

interface Ear {
  hear: (sound: Sound) => void
  reopenAfterMs: number | false
  gap: boolean
}

interface Told {
  tell: (open: boolean) => void
}

// Fact: what a listener throws may carry what was heard, so only this sentence leaves.
function report(): void {
  const said = 'Earshot: a listener of the microphone threw.'
  if (typeof reportError === 'function') reportError(new Error(said))
  else console.error(said)
}

const answered = async (call: () => Promise<unknown>): Promise<boolean> => {
  try {
    return (await call()) === true
  } catch {
    return false
  }
}

export class Mic {
  readonly #calls: MicCalls
  readonly #now: () => number
  readonly #clock = new Lifetime()
  readonly #ears = new Set<Ear>()
  readonly #told = new Set<Told>()
  readonly #news: boolean[] = []
  #holder: Ear | null = null
  #ended = false
  #gaveUp = false
  #issued = false
  #capturing = false
  #open = false
  #asking: 'open' | 'close' | null = null
  #telling = false
  #failures = 0
  #closesRefused = 0
  #heardAt = 0
  #retry: Timer | undefined
  #watch: Timer | undefined

  constructor(life: Lifetime, calls: MicCalls, now: () => number) {
    this.#calls = calls
    this.#now = now
    life.own(() => {
      this.#ended = true
      this.#ears.clear()
      this.#holder = null
      this.#changed()
    })
  }

  get open(): boolean {
    return this.#open
  }

  listen(hear: (sound: Sound) => void, options: ListenOptions = {}): () => void {
    const reopenAfterMs = options.reopenAfterMs ?? MIC_SILENT_MS
    if (reopenAfterMs !== false && !(Number.isFinite(reopenAfterMs) && reopenAfterMs >= MIN_REOPEN_MS))
      throw new RangeError(`reopenAfterMs is ${MIN_REOPEN_MS} milliseconds or more, or false.`)
    if (this.#ended) return () => {}
    const ear: Ear = { hear, reopenAfterMs, gap: true }
    this.#ears.add(ear)
    this.#changed()
    return () => {
      if (this.#ears.delete(ear)) this.#changed()
    }
  }

  hold(hear: (sound: Sound) => void): () => void {
    if (this.#ended) return () => {}
    const ear: Ear = { hear, reopenAfterMs: false, gap: true }
    this.#holder = ear
    this.#changed()
    return () => {
      if (this.#holder !== ear) return
      this.#holder = null
      this.#changed()
    }
  }

  onChange(tell: (open: boolean) => void): () => void {
    const told: Told = { tell }
    this.#told.add(told)
    return () => void this.#told.delete(told)
  }

  heard(sound: Omit<Sound, 'gap'>): void {
    this.#heardAt = this.#now()
    if (this.#issued && this.#asking !== 'close') this.#capturing = true
    const ears = this.#hearing()
    if (this.#holder) for (const ear of this.#ears) ear.gap = true
    for (const ear of ears) {
      if (!this.#hearing().includes(ear)) continue
      const { gap } = ear
      ear.gap = false
      try {
        ear.hear({ ...sound, pcm: new Uint8Array(sound.pcm), gap })
      } catch {
        report()
      }
    }
    if (this.#capturing && this.#asking !== 'close' && this.#wanted()) this.#set(true)
    this.#settle()
  }

  #wanted(): boolean {
    return this.#holder !== null || this.#ears.size > 0
  }

  #hearing(): Ear[] {
    return this.#holder ? [this.#holder] : [...this.#ears]
  }

  #reopenAfter(): number | false {
    const times = this.#hearing().flatMap(ear => (ear.reopenAfterMs === false ? [] : [ear.reopenAfterMs]))
    return times.length ? Math.min(...times) : false
  }

  #changed(): void {
    this.#retry?.cancel()
    this.#retry = undefined
    this.#settle()
  }

  #settle(): void {
    if (this.#asking || this.#gaveUp) return
    if (this.#ended && this.#issued) this.#capturing = true
    this.#watch?.cancel()
    this.#watch = undefined
    const wanted = this.#wanted()
    if (wanted ? this.#capturing && this.#open : !this.#capturing) {
      this.#retry?.cancel()
      this.#retry = undefined
      this.#failures = 0
      if (wanted) this.#watchForSilence()
      else if (this.#ended) this.#clock.end()
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
      this.#watch = this.#clock.timeout(() => this.#settle(), left)
      return
    }
    for (const ear of this.#ears) ear.gap = true
    this.#set(false)
    this.#settle()
  }

  async #ask(on: boolean): Promise<void> {
    this.#asking = on ? 'open' : 'close'
    if (on) this.#issued = true
    const done = await answered(on ? this.#calls.open : this.#calls.close)
    this.#asking = null
    if (done) {
      this.#capturing = on
      this.#issued = on
      this.#heardAt = this.#now()
      if (!on) this.#set(false)
    } else if (!on && this.#ended && ++this.#closesRefused >= CLOSES_AFTER_THE_END) {
      this.#gaveUp = true
      this.#clock.end()
    } else if (++this.#failures > 0 && on === this.#wanted()) {
      this.#retry = this.#clock.timeout(() => {
        this.#retry = undefined
        this.#settle()
      }, retryDelay(this.#failures))
    }
    if (on && this.#wanted()) {
      if (done) this.#set(true)
      else if (!this.#open) this.#tell(false)
    }
    this.#settle()
  }

  #set(open: boolean): void {
    if (this.#open === open) return
    this.#open = open
    this.#tell(open)
  }

  #tell(open: boolean): void {
    this.#news.push(open)
    if (this.#telling) return
    this.#telling = true
    try {
      for (let news = this.#news.shift(); news !== undefined; news = this.#news.shift()) {
        for (const told of [...this.#told]) {
          if (!this.#told.has(told)) continue
          try {
            told.tell(news)
          } catch {
            report()
          }
        }
      }
    } finally {
      this.#telling = false
    }
  }
}
