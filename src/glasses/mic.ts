import type { Sound } from '../audio.js'
import { Lifetime, type Timer } from '../lifetime.js'

export interface ListenOptions {
  reopenAfterMs?: number | false
}

export interface MicCalls {
  open(): Promise<unknown>
  close(): Promise<unknown>
}

export interface Held {
  want(sound: boolean): void
  letGo(): void
}

export const HOLD = Symbol('the microphone, for a hold alone')
export const MIC_SILENT_MS = 3_000
export const MIN_REOPEN_MS = 500
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 4_000
const CLOSES_AFTER_THE_END = 5

export const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))

interface Ear {
  hear: (sound: Sound) => unknown
  reopenAfterMs: number | false
  gap: boolean
}

interface Holder extends Ear {
  wants: boolean
  refused: () => void
}

interface Told {
  tell: (open: boolean) => unknown
}

// Fact: what a listener throws may carry what was heard, so only this sentence leaves.
function report(): void {
  const said = 'Earshot: a listener of the microphone threw.'
  if (typeof reportError === 'function') reportError(new Error(said))
  else console.error(said)
}

function serve(call: () => unknown): void {
  try {
    const answer = call()
    if (typeof (answer as { then?: unknown } | null | undefined)?.then === 'function') Promise.resolve(answer).catch(report)
  } catch {
    report()
  }
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
  readonly #waiting: Array<(settled: boolean) => void> = []
  #holder: Holder | null = null
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
  #heardSinceAsked = false
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

  listen(hear: (sound: Sound) => unknown, options: ListenOptions = {}): () => Promise<boolean> {
    const reopenAfterMs = options.reopenAfterMs ?? MIC_SILENT_MS
    if (reopenAfterMs !== false && !(Number.isFinite(reopenAfterMs) && reopenAfterMs >= MIN_REOPEN_MS))
      throw new RangeError(`reopenAfterMs is ${MIN_REOPEN_MS} milliseconds or more, or false.`)
    if (this.#ended) return () => Promise.resolve(!this.#gaveUp)
    const ear: Ear = { hear, reopenAfterMs, gap: true }
    this.#ears.add(ear)
    this.#changed()
    return () =>
      new Promise(settled => {
        this.#waiting.push(settled)
        if (this.#ears.delete(ear)) this.#changed()
        else this.#settle()
      })
  }

  hold(hear: (sound: Sound) => unknown, refused: () => void): Held {
    if (this.#ended) return { want: () => {}, letGo: () => {} }
    const holder: Holder = { hear, refused, reopenAfterMs: false, gap: true, wants: true }
    this.#holder = holder
    this.#changed()
    return {
      want: sound => {
        if (this.#holder !== holder || holder.wants === sound) return
        holder.wants = sound
        this.#changed()
      },
      letGo: () => {
        if (this.#holder !== holder) return
        this.#holder = null
        this.#changed()
      },
    }
  }

  onChange(tell: (open: boolean) => unknown): () => void {
    const told: Told = { tell }
    this.#told.add(told)
    return () => void this.#told.delete(told)
  }

  heard(sound: Omit<Sound, 'gap'>): void {
    this.#heardAt = this.#now()
    this.#heardSinceAsked = true
    if (this.#issued && this.#asking !== 'close') this.#capturing = true
    const ears = this.#hearing()
    if (this.#holder) for (const ear of this.#ears) ear.gap = true
    for (const ear of ears) {
      if (!this.#hearing().includes(ear)) continue
      const { gap } = ear
      ear.gap = false
      serve(() => ear.hear({ ...sound, pcm: new Uint8Array(sound.pcm), gap }))
    }
    if (this.#capturing && this.#asking !== 'close' && this.#wanted()) this.#set(true)
    this.#settle()
  }

  #wanted(): boolean {
    return this.#holder?.wants === true || this.#ears.size > 0
  }

  #hearing(): Ear[] {
    if (this.#holder) return this.#holder.wants ? [this.#holder] : []
    return [...this.#ears]
  }

  #reopenAfter(): number | false {
    const times = this.#hearing().flatMap(ear => (ear.reopenAfterMs === false ? [] : [ear.reopenAfterMs]))
    return times.length ? Math.min(...times) : false
  }

  #breakForAll(): void {
    for (const ear of this.#ears) ear.gap = true
    if (this.#holder) this.#holder.gap = true
  }

  #changed(): void {
    this.#retry?.cancel()
    this.#retry = undefined
    this.#settle()
  }

  #settle(): void {
    if (this.#asking) return
    if (this.#gaveUp) return this.#calm()
    this.#watch?.cancel()
    this.#watch = undefined
    if (!this.#wanted() && this.#issued) this.#capturing = true
    if (this.#isCalm()) {
      this.#retry?.cancel()
      this.#retry = undefined
      this.#failures = 0
      if (this.#wanted()) this.#watchForSilence()
      else if (this.#ended) this.#clock.end()
      return this.#calm()
    }
    if (!this.#retry) void this.#ask(this.#wanted())
  }

  #isCalm(): boolean {
    return this.#wanted() ? this.#capturing && this.#open : !this.#capturing
  }

  #calm(): void {
    if (this.#asking || !(this.#gaveUp || this.#isCalm())) return
    for (const settled of this.#waiting.splice(0)) settled(!this.#gaveUp)
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
    this.#breakForAll()
    this.#set(false)
    this.#settle()
  }

  async #ask(on: boolean): Promise<void> {
    this.#asking = on ? 'open' : 'close'
    if (on) this.#issued = true
    this.#heardSinceAsked = false
    const done = await answered(on ? this.#calls.open : this.#calls.close)
    this.#asking = null
    if (done) {
      this.#capturing = on
      this.#issued = on
      this.#heardAt = this.#now()
      if (!on || !this.#heardSinceAsked) this.#breakForAll()
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
      else if (!this.#open) {
        this.#tell(false)
        if (this.#holder?.wants) serve(this.#holder.refused)
      }
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
          const now = news
          serve(() => told.tell(now))
        }
      }
    } finally {
      this.#telling = false
    }
  }
}
