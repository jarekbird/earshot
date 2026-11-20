import type { Action, Outcome } from './action.js'
import { Lifetime } from './lifetime.js'

export interface Screen {
  readonly id: string
  actions?(): readonly Action[]
  enter?(life: Lifetime): void
}

export interface RouterOptions {
  home: Screen
  actions?: () => readonly Action[]
  onChange?: (current: Screen) => void
}

interface Entry {
  screen: Screen
  life: Lifetime
}

export class Router {
  readonly #stack: Entry[]
  readonly #appActions: () => readonly Action[]
  readonly #onChange: (current: Screen) => void

  constructor(options: RouterOptions) {
    this.#appActions = options.actions ?? (() => [])
    this.#onChange = options.onChange ?? (() => {})
    this.#stack = [this.#enter(options.home)]
  }

  get current(): Screen {
    return this.#stack[this.#stack.length - 1].screen
  }

  get depth(): number {
    return this.#stack.length
  }

  open(screen: Screen): void {
    this.#stack.push(this.#enter(screen))
    this.#onChange(screen)
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
    return [...own, ...this.#appActions().filter(a => !ids.has(a.id))]
  }

  async run(id: string, targetId?: string): Promise<Outcome> {
    const found = this.actions().find(a => a.id === id)
    return found ? found.run(targetId) : { done: false, why: 'unknown' }
  }

  #enter(screen: Screen): Entry {
    const life = new Lifetime()
    screen.enter?.(life)
    return { screen, life }
  }

  #leave(entries: readonly Entry[], after: () => void): void {
    const errors: unknown[] = []
    for (const entry of [...entries].reverse()) {
      try {
        entry.life.end()
      } catch (error) {
        errors.push(error)
      }
    }
    after()
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Cleanups failed when screens left.')
  }
}
