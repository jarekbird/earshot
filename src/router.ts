import { action, type Action, type Outcome } from './action.js'
import { Lifetime } from './lifetime.js'
import type { View } from './view.js'

export interface Screen {
  readonly id: string
  actions?(): readonly Action[]
  view?(): View
  context?(): string
  enter?(life: Lifetime): void
}

export interface RouterOptions {
  home: Screen
  actions?: () => readonly Action[]
}

interface Entry {
  screen: Screen
  life: Lifetime
}

interface Jump {
  at: number
  moved: boolean
}

const SHOWINGS = new WeakMap<Router, Showings>()

export const showingsOf = (router: Router): Showings => SHOWINGS.get(router) as Showings

interface Showings {
  readonly current: object | undefined
  onPath(showing: unknown): boolean
  onLeave(told: () => void): () => void
  onMove(told: () => void): () => void
}

export class Router {
  readonly #stack: Entry[]
  readonly #left = new Set<() => void>()
  readonly #moved = new Set<() => void>()
  readonly #gone = new WeakSet<object>()
  readonly #appActions: () => readonly Action[]
  readonly #listeners = new Set<(current: Screen) => void>()
  #jump: Jump | null = null
  readonly #standard: readonly Action[] = [
    action({
      id: 'back',
      say: 'Go back',
      blocked: () => (this.depth > 1 ? null : 'Nothing to go back to'),
      run: () => void this.back(),
    }),
    action({
      id: 'home',
      say: 'Go home',
      blocked: () => (this.depth > 1 ? null : 'Already at the start'),
      run: () => this.goHome(),
    }),
  ]

  constructor(options: RouterOptions) {
    this.#appActions = options.actions ?? (() => [])
    this.#stack = [this.#enter(options.home)]
    SHOWINGS.set(this, this.#showings())
  }

  get current(): Screen {
    return this.#stack[this.#stack.length - 1].screen
  }

  get depth(): number {
    return this.#stack.length
  }

  #showings(): Showings {
    const stack = this.#stack
    const left = this.#left
    const moved = this.#moved
    const gone = this.#gone
    return {
      get current() {
        return stack.at(-1)?.life
      },
      onPath: showing => showing !== undefined && stack.some(entry => entry.life === showing && !gone.has(entry.life)),
      onLeave: told => {
        left.add(told)
        return () => void left.delete(told)
      },
      onMove: told => {
        moved.add(told)
        return () => void moved.delete(told)
      },
    }
  }

  onChange(listener: (current: Screen) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  open(screen: Screen): void {
    const jump = this.#jump
    if (!jump) return this.#push(screen)
    const at = Math.min(jump.at, this.#stack.length)
    jump.at = at + 1
    jump.moved = true
    if (this.#stack[at]?.screen === screen) return
    this.#leave(this.#stack.splice(at), () => this.#push(screen))
  }

  jump(...path: Screen[]): void {
    if (path.length === 0) return this.goHome()
    this.jumping(() => path.forEach(screen => this.open(screen)))
  }

  jumping<T>(run: () => T): T {
    if (this.#jump) return run()
    const jump: Jump = { at: 1, moved: false }
    this.#jump = jump
    const end = () => {
      this.#jump = null
      if (jump.moved && this.#stack.length > jump.at) this.#leave(this.#stack.splice(jump.at), () => this.#onChange(this.current))
    }
    let result: T
    try {
      result = run()
    } catch (error) {
      end()
      throw error
    }
    if (result instanceof Promise) return result.finally(end) as T
    end()
    return result
  }

  anywhere(chosen: Action): boolean {
    const same = (a: Action) => a.id === chosen.id
    return !(this.current.actions?.() ?? []).some(same) && this.#appActions().some(same)
  }

  replace(screen: Screen): void {
    this.#leave(this.#stack.splice(-1), () => this.open(screen))
  }

  back(): boolean {
    if (this.#stack.length === 1) return false
    this.#leave(this.#stack.splice(-1), () => this.#onChange(this.current))
    return true
  }

  goHome(): void {
    if (this.#stack.length === 1) return
    this.#leave(this.#stack.splice(1), () => this.#onChange(this.current))
  }

  close(): void {
    this.#leave([...this.#stack], () => {})
  }

  actions(): readonly Action[] {
    const screen = this.current
    const own = screen.actions?.() ?? []
    const ids = new Set<string>()
    for (const a of own) {
      if (ids.has(a.id)) throw new Error(`${screen.id}: two actions with id "${a.id}"`)
      ids.add(a.id)
    }
    const offered = [...own, ...this.#appActions().filter(a => !ids.has(a.id))]
    const taken = new Set(offered.map(a => a.id))
    return [...offered, ...this.#standard.filter(a => !taken.has(a.id))]
  }

  async run(id: string, targetId?: string): Promise<Outcome> {
    const found = this.actions().find(a => a.id === id)
    return found ? found.run(targetId) : { done: false, why: 'unknown' }
  }

  #push(screen: Screen): void {
    this.#stack.push(this.#enter(screen))
    this.#onChange(screen)
  }

  #onChange(current: Screen): void {
    const errors: unknown[] = []
    for (const told of [...this.#moved, ...[...this.#listeners].map(listener => () => listener(current))]) {
      try {
        told()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Listeners failed when the screen changed.')
  }

  #enter(screen: Screen): Entry {
    const life = new Lifetime()
    screen.enter?.(life)
    return { screen, life }
  }

  #leave(entries: readonly Entry[], after: () => void): void {
    const errors: unknown[] = []
    for (const entry of [...entries].reverse()) {
      this.#gone.add(entry.life)
      try {
        entry.life.end()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const told of [...this.#left]) {
      try {
        told()
      } catch (error) {
        errors.push(error)
      }
    }
    after()
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Cleanups failed when screens left.')
  }
}
