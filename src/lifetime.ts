export interface Timer {
  cancel(): void
}

export class LifetimeEnded extends Error {
  constructor() {
    super('The lifetime ended.')
    this.name = 'LifetimeEnded'
  }
}

const NOTHING = () => {}

export class Lifetime {
  readonly #ends = new Set<() => void>()
  readonly #abort = new AbortController()
  #over = false

  get ended(): boolean {
    return this.#over
  }

  get owned(): number {
    return this.#ends.size
  }

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  own(end: () => void): () => void {
    if (this.#over) {
      end()
      return NOTHING
    }
    this.#ends.add(end)
    return () => {
      if (this.#ends.delete(end)) end()
    }
  }

  timeout(run: () => void, ms: number): Timer {
    if (this.#over) return { cancel: NOTHING }
    const stop = () => clearTimeout(id)
    const id = setTimeout(() => {
      this.#ends.delete(stop)
      run()
    }, ms)
    return { cancel: this.own(stop) }
  }

  interval(run: () => void, ms: number): Timer {
    if (this.#over) return { cancel: NOTHING }
    const id = setInterval(run, ms)
    return { cancel: this.own(() => clearInterval(id)) }
  }

  guard<T>(work: T | PromiseLike<T>): Promise<T> {
    const working = Promise.resolve(work)
    return new Promise((resolve, reject) => {
      if (this.#over) {
        working.catch(NOTHING)
        return reject(new LifetimeEnded())
      }
      const stop = () => reject(new LifetimeEnded())
      this.#ends.add(stop)
      const settle = (done: () => void) => {
        if (this.#ends.delete(stop)) done()
      }
      working.then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      )
    })
  }

  listen(target: EventTarget, type: string, listener: (event: Event) => void): () => void {
    if (this.#over) return NOTHING
    target.addEventListener(type, listener)
    return this.own(() => target.removeEventListener(type, listener))
  }

  child(): Lifetime {
    const child = new Lifetime()
    child.own(this.own(() => child.end()))
    return child
  }

  end(): void {
    if (this.#over) return
    this.#over = true
    const ends = [...this.#ends].reverse()
    this.#ends.clear()
    const errors: unknown[] = []
    for (const end of ends) {
      try {
        end()
      } catch (error) {
        errors.push(error)
      }
    }
    this.#abort.abort(new LifetimeEnded())
    if (errors.length) throw new AggregateError(errors, 'Cleanups failed when the lifetime ended.')
  }
}
