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

export class Router {
  readonly #stack: Entry[]
  readonly #appActions: () => readonly Action[]
  readonly #listeners = new Set<(current: Screen) => void>()
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
  }

  get current(): Screen {
    return this.#stack[this.#stack.length - 1].screen
  }

  get depth(): number {
    return this.#stack.length
  }

  onChange(listener: (current: Screen) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
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
    const offered = [...own, ...this.#appActions().filter(a => !ids.has(a.id))]
    const taken = new Set(offered.map(a => a.id))
    return [...offered, ...this.#standard.filter(a => !taken.has(a.id))]
  }

  async run(id: string, targetId?: string): Promise<Outcome> {
    const found = this.actions().find(a => a.id === id)
    return found ? found.run(targetId) : { done: false, why: 'unknown' }
  }

  #onChange(current: Screen): void {
    for (const listener of [...this.#listeners]) listener(current)
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
