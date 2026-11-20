import type { Action, Outcome } from './action.js'

export interface Screen {
  readonly id: string
  actions?(): readonly Action[]
  enter?(left: AbortSignal): void
}

export interface RouterOptions {
  home: Screen
  actions?: () => readonly Action[]
  onChange?: (current: Screen) => void
}

interface Entry {
  screen: Screen
  life: AbortController
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
    this.#stack.pop()?.life.abort()
    this.open(screen)
  }

  back(): boolean {
    if (this.#stack.length === 1) return false
    this.#stack.pop()?.life.abort()
    this.#onChange(this.current)
    return true
  }

  goHome(): void {
    if (this.#stack.length === 1) return
    for (const entry of this.#stack.splice(1).reverse()) entry.life.abort()
    this.#onChange(this.current)
  }

  close(): void {
    for (const entry of [...this.#stack].reverse()) entry.life.abort()
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
    const life = new AbortController()
    screen.enter?.(life.signal)
    return { screen, life }
  }
}
