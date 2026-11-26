import type { Sound } from '../audio.js'
import { Lifetime, type Timer } from '../lifetime.js'
import { serve } from '../serve.js'

export interface ListenOptions {
  reopenAfterMs?: number | false
}

interface MicCalls {
  open(): Promise<unknown>
  close(): Promise<unknown>
}

export interface Held {
  want(sound: boolean): void
  letGo(): void
}

export const HOLD = Symbol('the microphone, for a hold alone')
export const MIC_SILENT_MS = 3_000
const MIN_REOPEN_MS = 500
const MAX_REOPEN_MS = 86_400_000
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

type About = 'open' | 'leftOn'

interface Told {
  about: About
  tell: (now: boolean) => unknown
}

// Fact: Even's simulator answers true to an open, and false to a close that worked. So a close is done when answered.
const answered = async (call: () => Promise<unknown>, open: boolean): Promise<boolean> => {
  try {
    return ((await call()) === true) === open || !open
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
  readonly #news: Array<[About, boolean]> = []
  readonly #waiting: Array<(settled: boolean) => void> = []
  #holder: Holder | null = null
  #ended = false
  #gaveUp = false
  #issued = false
  #capturing = false
  #open = false
  #leftOn = false
  #asking: 'open' | 'close' | null = null
  #telling = false
  #failures = 0
  #closesRefused = 0
  #heardAt = 0
  #heardSinceAsked = false
  #askAnyway = false
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

  get leftOn(): boolean {
    return this.#leftOn
  }

  listen(hear: (sound: Sound) => unknown, options: ListenOptions = {}): () => Promise<boolean> {
    const reopenAfterMs = options.reopenAfterMs ?? MIC_SILENT_MS
    if (reopenAfterMs !== false && !(reopenAfterMs >= MIN_REOPEN_MS && reopenAfterMs <= MAX_REOPEN_MS))
      throw new RangeError(`reopenAfterMs is from ${MIN_REOPEN_MS} milliseconds to a day, or false.`)
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
    const holder: Holder = { hear, refused, reopenAfterMs: false, gap: true, wants: false }
    this.#holder = holder
    for (const ear of this.#ears) ear.gap = true
    this.#changed()
    return {
      want: sound => {
        if (this.#holder !== holder || holder.wants === sound) return
        holder.wants = sound
        this.#askAnyway = sound
        this.#changed()
      },
      letGo: () => {
        if (this.#holder !== holder) return
        this.#holder = null
        this.#askAnyway = false
        this.#changed()
      },
    }
  }

  onChange(tell: (open: boolean) => unknown): () => void {
    return this.#toTell('open', tell)
  }

  onLeftOn(tell: (leftOn: boolean) => unknown): () => void {
    return this.#toTell('leftOn', tell)
  }

  #toTell(about: About, tell: (now: boolean) => unknown): () => void {
    const told: Told = { about, tell }
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
    if (this.#wanted()) this.#leave(false)
    if (this.#asking) return
    if (this.#gaveUp) return this.#calm()
    this.#watch?.cancel()
    this.#watch = undefined
    if (!this.#wanted() && this.#issued) this.#capturing = true
    if (!this.#wanted()) this.#askAnyway = false
    if (this.#isCalm() && !this.#askAnyway) {
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
    if (this.#asking || this.#telling || !(this.#gaveUp || (this.#isCalm() && !this.#askAnyway))) return
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
    if (on) this.#askAnyway = false
    this.#heardSinceAsked = false
    const done = await answered(on ? this.#calls.open : this.#calls.close, on)
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
        this.#tell('open', false)
        if (this.#holder?.wants) serve(this.#holder.refused)
      }
    }
    if (!on) this.#leave(!done && !this.#wanted())
    this.#settle()
  }

  #set(open: boolean): void {
    if (this.#open === open) return
    this.#open = open
    this.#tell('open', open)
  }

  #leave(leftOn: boolean): void {
    if (this.#leftOn === leftOn) return
    this.#leftOn = leftOn
    this.#tell('leftOn', leftOn)
  }

  #tell(about: About, now: boolean): void {
    this.#news.push([about, now])
    if (this.#telling) return
    this.#telling = true
    try {
      for (let news = this.#news.shift(); news !== undefined; news = this.#news.shift()) {
        const [about, now] = news
        for (const told of [...this.#told]) {
          if (!this.#told.has(told) || told.about !== about) continue
          serve(() => told.tell(now))
        }
      }
    } finally {
      this.#telling = false
      this.#calm()
    }
  }
}
