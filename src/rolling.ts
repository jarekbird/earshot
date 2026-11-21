import type { Action } from './action.js'
import { Context, type ContextOptions } from './context.js'
import type { Lifetime } from './lifetime.js'

export interface RollingItem {
  action: Action
  target: string
  say: string
  context: string
}

export interface RollingOptions extends ContextOptions {
  capacity?: number
}

// Jev takes 255 options in one question, so the queue never needs to hold more.
const CAPACITY = 255

interface Queued {
  action: Action
  target: string
}

const keyOf = (action: Action, target: string) => `${action.id}\n${target}`

export class Rolling {
  readonly #context: Context
  readonly #capacity: number
  readonly #queue = new Map<string, Queued>()

  constructor(life: Lifetime, options: RollingOptions = {}) {
    this.#context = new Context(life, options)
    this.#capacity = options.capacity ?? CAPACITY
  }

  add(action: Action, target: string, context?: string): void {
    const found = action.targets()?.find(candidate => candidate.id === target)
    if (!found || found.private) return
    const key = keyOf(action, target)
    this.#queue.delete(key)
    this.#queue.set(key, { action, target })
    if (context !== undefined) this.#context.set(key, context)
    for (const oldest of this.#queue.keys()) {
      if (this.#queue.size <= this.#capacity) break
      this.#drop(oldest)
    }
  }

  items(): RollingItem[] {
    const items: RollingItem[] = []
    for (const [key, { action, target }] of [...this.#queue].reverse()) {
      const found = action.targets()?.find(candidate => candidate.id === target)
      if (!found || found.private) this.#drop(key)
      else items.push({ action, target, say: `${action.say}: ${found.say}`, context: this.#context.get(key) })
    }
    return items
  }

  #drop(key: string): void {
    this.#queue.delete(key)
    this.#context.forget(key)
  }
}
