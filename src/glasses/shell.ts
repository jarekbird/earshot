import { action, type Action, type TargetInfo } from '../action.js'
import { LifetimeEnded, type Lifetime, type Timer } from '../lifetime.js'
import type { Router, Screen } from '../router.js'
import { list, type View } from '../view.js'
import type { Box } from './frame.js'
import type { Glasses } from './glasses.js'
import type { Input } from './input.js'
import { layoutList, layoutText } from './layout.js'
import { MAX_MENU_ITEMS } from './limits.js'

export interface ShellWords {
  gone: string
  failed: string
  confirm: string
  unavailable: string
  more: string
}

export interface ShellOptions {
  noticeMs?: number
  words?: Partial<ShellWords>
  onHold?: (input: Input) => void
}

const WORDS: ShellWords = {
  gone: 'That is gone',
  failed: 'That did not work',
  confirm: 'Tap to confirm',
  unavailable: 'Not available here',
  more: 'More…',
}
const NOTICE_MS = 3_000
const SCROLL_LINES = 2
const MORE = 'earshot.more'

interface Place {
  cursor: number
  top: number
}

interface Drawn {
  screen: Screen
  view: View
  targets: readonly TargetInfo[]
  folded: readonly Action[]
}

export class Shell {
  readonly #life: Lifetime
  readonly #glasses: Glasses
  readonly #router: Router
  readonly #words: ShellWords
  readonly #noticeMs: number
  readonly #onHold: (input: Input) => void
  readonly #places = new WeakMap<Screen, Place>()
  readonly #own = new WeakSet<Screen>()
  readonly #items = new Map<string, number>()
  #drawn: Drawn | null = null
  #asking: (() => void) | null = null
  #notice: Timer | undefined

  constructor(parent: Lifetime, glasses: Glasses, router: Router, options: ShellOptions = {}) {
    this.#life = parent.child()
    this.#glasses = glasses
    this.#router = router
    this.#words = { ...WORDS, ...options.words }
    this.#noticeMs = options.noticeMs ?? NOTICE_MS
    this.#onHold = options.onHold ?? (() => {})
    this.#life.own(glasses.onInput(input => this.#input(input)))
    this.#life.own(router.onChange(() => this.redraw()))
    this.redraw()
  }

  redraw(): void {
    if (this.#life.ended) return
    const screen = this.#router.current
    const actions = this.#router.actions()
    const view = screen.view?.() ?? list({ action: this.#chooser(actions) })
    const place = this.#places.get(screen) ?? { cursor: 0, top: 0 }
    this.#places.set(screen, place)
    let boxes: Box[]
    let targets: readonly TargetInfo[] = []
    if (view.kind === 'list') {
      targets = view.action.targets() ?? []
      const laid = layoutList(view, targets, place)
      Object.assign(place, laid.state)
      boxes = laid.boxes
    } else if (view.kind === 'text') {
      const laid = layoutText(view, place)
      place.top = laid.state.top
      boxes = laid.boxes
    } else boxes = view.boxes
    const offered = !screen.view || this.#own.has(screen) ? [] : actions.filter(a => view.kind !== 'list' || a.id !== view.action.id)
    const fold = offered.length > MAX_MENU_ITEMS
    const shown = fold ? offered.slice(0, MAX_MENU_ITEMS - 1) : offered
    const menu = shown.map(a => ({ id: this.#item(a.id), name: a.say }))
    if (fold) menu.push({ id: this.#item(MORE), name: this.#words.more })
    this.#drawn = { screen, view, targets, folded: fold ? offered.slice(MAX_MENU_ITEMS - 1) : [] }
    this.#glasses.draw({ boxes, menu })
  }

  notice(text: string): void {
    this.#notice?.cancel()
    this.#glasses.overlay(text)
    this.#notice = this.#life.timeout(() => this.#clear(), this.#noticeMs)
  }

  #clear(): void {
    this.#notice?.cancel()
    this.#notice = undefined
    this.#asking = null
    this.#glasses.overlay(null)
  }

  #item(id: string): number {
    const known = this.#items.get(id)
    if (known !== undefined) return known
    const next = this.#items.size + 1
    this.#items.set(id, next)
    return next
  }

  #chooser(actions: readonly Action[]): Action {
    return action({
      id: 'earshot.actions',
      say: this.#words.more,
      targets: () => actions.map(a => ({ id: a.id, say: a.say, value: a })),
      run: chosen => this.#start(chosen),
    })
  }

  #openOwn(screen: Screen): void {
    this.#own.add(screen)
    this.#router.open(screen)
  }

  #input(input: Input): void {
    if (input.kind === 'hold' || input.kind === 'release') return this.#onHold(input)
    if (input.kind === 'foreground' || input.kind === 'background' || input.kind === 'exit') return
    const confirmed = this.#asking
    if (this.#notice || confirmed) this.#clear()
    if (confirmed) return input.kind === 'tap' ? confirmed() : undefined
    if (input.kind === 'double') {
      if (!this.#router.back()) void this.#glasses.leave()
      return
    }
    if (input.kind === 'menu') return this.#picked(input.item)
    const drawn = this.#drawn
    const screen = this.#router.current
    const place = this.#places.get(screen)
    if (!drawn || drawn.screen !== screen || !place) return
    const { view } = drawn
    if (view.kind === 'boxes') return view.input?.(input)
    const step = input.kind === 'up' ? -1 : 1
    if (view.kind === 'text') {
      if (input.kind !== 'tap') place.top += step * SCROLL_LINES
    } else if (input.kind !== 'tap') place.cursor += step
    else {
      const target = drawn.targets[place.cursor]
      if (!target) return
      if (this.#own.has(screen)) this.#router.back()
      return void this.#start(view.action, target.id)
    }
    this.redraw()
  }

  #picked(item: number): void {
    const id = [...this.#items].find(([, number]) => number === item)?.[0]
    const folded = this.#drawn?.folded ?? []
    if (id === MORE && folded.length) {
      return this.#openOwn({ id: MORE, view: () => list({ title: this.#words.more, action: this.#chooser(folded) }) })
    }
    const found = this.#router.actions().find(a => a.id === id)
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found)
  }

  async #start(chosen: Action, targetId?: string): Promise<void> {
    const why = chosen.blocked()
    if (why !== null) return this.notice(why)
    const targets = chosen.targets()
    if (targets !== null && targetId === undefined) {
      return this.#openOwn({ id: 'earshot.pick', view: () => list({ title: chosen.say, action: chosen }) })
    }
    if (chosen.risk !== 'confirm') return this.#run(chosen, targetId)
    const target = targets?.find(candidate => candidate.id === targetId)
    this.#clear()
    this.#asking = () => void this.#run(chosen, targetId)
    this.#glasses.overlay(`${chosen.say}${target ? `: ${target.say}` : ''}?\n${this.#words.confirm}`)
  }

  async #run(chosen: Action, targetId?: string): Promise<void> {
    try {
      const outcome = await this.#life.guard(chosen.run(targetId))
      if (outcome.done) return this.redraw()
      if (outcome.why === 'blocked') return this.notice(outcome.say)
      this.notice(outcome.why === 'gone' ? this.#words.gone : this.#words.unavailable)
    } catch (error) {
      if (error instanceof LifetimeEnded) return
      console.error(error)
      this.notice(this.#words.failed)
    }
  }
}
