import { action, type Action, type TargetInfo } from '../action.js'
import { joinPcm, levelOf, problemWith, QUIET, secondsOf, type Audio, type Sound } from '../audio.js'
import { LifetimeEnded, type Lifetime, type Timer } from '../lifetime.js'
import { ITEM_LIMIT } from '../context.js'
import { matchWords, navigator, type Agent, type NavigatorModel, type Pick, type Verdict } from '../navigator.js'
import type { Rolling } from '../rolling.js'
import type { Router, Screen } from '../router.js'
import { SayError } from '../say.js'
import { list, type Bound, type View } from '../view.js'
import type { Box, Picture } from './frame.js'
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
  listening: string
  thinking: string
  noVoice: string
  noMic: string
  missed: string
  noMatch: string
  slow: string
  voiceFailed: string
  which: string
  scrollUp: string
  scrollDown: string
  moveUp: string
  moveDown: string
  choose: string
  selected: string
}

export interface VoiceOptions {
  transcribe: (audio: Audio, life: Lifetime) => Promise<string | null>
  model?: NavigatorModel
  agents?: Agent[]
  otherwise?: string
  rolling?: Rolling
  timeoutMs?: number
  maxHoldMs?: number
  onListen?: () => void
}

export interface ShellOptions {
  noticeMs?: number
  words?: Partial<ShellWords>
  voice?: VoiceOptions
}

const WORDS: ShellWords = {
  gone: 'That is gone',
  failed: 'That did not work',
  confirm: 'Tap to confirm',
  unavailable: 'Not available here',
  more: 'More…',
  listening: 'Listening',
  thinking: '…',
  noVoice: 'Voice is not set up',
  noMic: 'The microphone did not open',
  missed: "Didn't catch that",
  noMatch: 'No match',
  slow: 'No answer in time',
  voiceFailed: 'Voice did not work',
  which: 'Which one?',
  scrollUp: 'Scroll up',
  scrollDown: 'Scroll down',
  moveUp: 'Move up',
  moveDown: 'Move down',
  choose: 'Choose this one',
  selected: 'Selected',
}
const NOTICE_MS = 3_000
const HEARD_MS = 1_500
const VOICE_TIMEOUT_MS = 45_000
const MAX_HOLD_MS = 60_000
const METER_BARS = 8
const METER_MS = 300
const SCROLL_LINES = 2
const SCREENFUL = 8
const MORE = 'earshot.more'
const UP = 'earshot.up'
const DOWN = 'earshot.down'
const CHOOSE = 'earshot.choose'

const boundTo = (bound: Bound): { action: Action; target?: string } => ('action' in bound ? bound : { action: bound })

interface Place {
  cursor: number
  top: number
}

interface Drawn {
  frame: number
  screen: Screen
  view: View
  targets: readonly TargetInfo[]
  folded: readonly Action[]
  scrolls: boolean
}

export class Shell {
  readonly #life: Lifetime
  readonly #glasses: Glasses
  readonly #router: Router
  readonly #words: ShellWords
  readonly #noticeMs: number
  readonly #voice: VoiceOptions | undefined
  readonly #places = new WeakMap<Screen, Place>()
  readonly #own = new WeakSet<Screen>()
  readonly #items = new Map<string, number>()
  #drawn: Drawn | null = null
  #asking: (() => void) | null = null
  #overlaid = false
  #fading: Timer | undefined
  #recording: { chunks: Uint8Array[]; screen: Screen; failed: boolean; end: () => void } | null = null
  #turn = 0
  #said = false
  #deciding: Lifetime | null = null
  #asked: Array<{ frame: number; screen: Screen }> = []

  constructor(parent: Lifetime, glasses: Glasses, router: Router, options: ShellOptions = {}) {
    this.#life = parent.child()
    this.#glasses = glasses
    this.#router = router
    this.#words = { ...WORDS, ...options.words }
    this.#noticeMs = options.noticeMs ?? NOTICE_MS
    this.#voice = options.voice
    this.#life.own(glasses.onInput(input => this.#input(input)))
    this.#life.own(() => this.#recording?.end())
    this.#life.own(
      router.onChange(() => {
        if (this.#asking) this.#clear()
        this.redraw()
      }),
    )
    this.redraw()
  }

  get busy(): boolean {
    return this.#recording !== null || this.#deciding !== null
  }

  redraw(): void {
    if (this.#life.ended) return
    const screen = this.#router.current
    const actions = this.#router.actions()
    const view = screen.view?.() ?? list({ action: this.#chooser(actions) })
    const place = this.#places.get(screen) ?? { cursor: 0, top: 0 }
    this.#places.set(screen, place)
    let boxes: Box[]
    let pictures: Picture[] = []
    let scrolls = false
    let targets: readonly TargetInfo[] = []
    if (view.kind === 'list') {
      targets = view.action.targets() ?? []
      const laid = layoutList(view, targets, place)
      Object.assign(place, laid.state)
      boxes = laid.boxes
    } else if (view.kind === 'text') {
      const laid = layoutText(view, place)
      place.top = laid.state.top
      scrolls = laid.scrolls
      boxes = laid.boxes
    } else {
      boxes = view.boxes
      pictures = view.pictures ?? []
    }
    const byGesture = new Set(view.kind === 'list' ? [view.action.id] : view.kind === 'boxes' ? this.#bound(view).map(a => a.id) : [])
    const offered = !screen.view || this.#own.has(screen) ? [] : actions.filter(a => !byGesture.has(a.id))
    const fold = offered.length > MAX_MENU_ITEMS
    const shown = fold ? offered.slice(0, MAX_MENU_ITEMS - 1) : offered
    const menu = shown.map(a => ({ id: this.#item(a.id), name: a.say }))
    if (fold) menu.push({ id: this.#item(MORE), name: this.#words.more })
    this.#shown()
    const frame = this.#glasses.draw({ boxes, pictures, menu })
    this.#drawn = { frame, screen, view, targets, folded: fold ? offered.slice(MAX_MENU_ITEMS - 1) : [], scrolls }
    this.#asked.push({ frame, screen })
  }

  #shown(): Screen | undefined {
    const shown = this.#glasses.shown
    const at = this.#asked.findLastIndex(asked => asked.frame <= shown)
    if (at > 0) this.#asked.splice(0, at)
    return this.#asked[0] && this.#asked[0].frame <= shown ? this.#asked[0].screen : undefined
  }

  #bound(view: View): Action[] {
    if (view.kind !== 'boxes' || !view.on) return []
    return [view.on.tap, view.on.up, view.on.down].flatMap(bound => (bound ? [boundTo(bound).action] : []))
  }

  #reachable(): Action[] {
    const drawn = this.#drawn
    const screen = this.#router.current
    const place = this.#places.get(screen)
    const actions = [...this.#router.actions()]
    if (!drawn || drawn.screen !== screen || !place) return actions
    const { view } = drawn
    const move = (id: string, say: string, by: number, field: 'cursor' | 'top') =>
      action({
        id,
        say,
        run: () => {
          place[field] += by
          this.redraw()
        },
      })
    const own =
      view.kind === 'boxes'
        ? this.#bound(view)
        : view.kind === 'text'
          ? drawn.scrolls
            ? [move(UP, this.#words.scrollUp, -SCREENFUL, 'top'), move(DOWN, this.#words.scrollDown, SCREENFUL, 'top')]
            : []
          : drawn.targets.length === 0
            ? []
            : [
                move(UP, this.#words.moveUp, -1, 'cursor'),
                move(DOWN, this.#words.moveDown, 1, 'cursor'),
                action({ id: CHOOSE, say: this.#words.choose, run: () => this.#choose(drawn, place, this.#said) }),
              ]
    const taken = new Set(actions.map(a => a.id))
    return [...actions, ...own.filter(a => !taken.has(a.id) && (taken.add(a.id), true))]
  }

  #choose(drawn: Drawn, place: Place, said = false): void {
    const target = drawn.targets[place.cursor]
    if (!target || drawn.view.kind !== 'list') return
    if (this.#own.has(drawn.screen)) this.#router.back()
    void this.#start(drawn.view.action, target.id, said)
  }

  notice(text: string): void {
    this.#show(text, this.#noticeMs)
  }

  #show(text: string, ms?: number): void {
    this.#fading?.cancel()
    this.#fading = ms === undefined ? undefined : this.#life.timeout(() => this.#clear(), ms)
    this.#asking = null
    this.#overlaid = true
    this.#glasses.overlay(text)
  }

  #clear(): void {
    this.#fading?.cancel()
    this.#fading = undefined
    this.#asking = null
    this.#overlaid = false
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
      run: chosen => this.#start(chosen, undefined, this.#said),
    })
  }

  #openOwn(screen: Screen): void {
    this.#own.add(screen)
    this.#router.open(screen)
  }

  #input(input: Input): void {
    if (input.kind === 'foreground') return
    if (input.kind === 'background' || input.kind === 'exit') return this.#recording || this.#deciding ? this.#callOff() : undefined
    if (input.kind === 'hold') return this.#hold()
    if (input.kind === 'release') return this.#release()
    if (this.#recording || this.#deciding) {
      if (!this.#recording || input.kind === 'double') this.#callOff()
      return
    }
    const confirmed = this.#asking
    if (this.#overlaid) this.#clear()
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
    if (view.kind === 'boxes') {
      const bound = view.on?.[input.kind]
      if (!bound) return
      const { action: chosen, target } = boundTo(bound)
      return void this.#start(chosen, target)
    }
    const step = input.kind === 'up' ? -1 : 1
    if (view.kind === 'text') {
      if (input.kind !== 'tap') place.top += step * SCROLL_LINES
    } else if (input.kind !== 'tap') place.cursor += step
    else return this.#choose(drawn, place)
    this.redraw()
  }

  #callOff(): void {
    this.#turn++
    this.#deciding?.end()
    this.#deciding = null
    this.#recording?.end()
    this.#clear()
  }

  #hold(): void {
    if (this.#recording) return
    this.#callOff()
    if (!this.#voice) return this.notice(this.#words.noVoice)
    const chunks: Uint8Array[] = []
    const bars = Array<string>(METER_BARS).fill(QUIET)
    const listening = () => this.#show(`${this.#words.listening} ${bars.join('')}`)
    let meter: Timer | undefined
    const hear = ({ pcm }: Sound) => {
      if (recording.failed) return
      chunks.push(pcm)
      bars.push(levelOf(pcm))
      bars.shift()
      meter ??= this.#life.timeout(() => {
        meter = undefined
        listening()
      }, METER_MS)
    }
    const limit = this.#life.timeout(() => this.#release(), this.#voice.maxHoldMs ?? MAX_HOLD_MS)
    const recording = {
      chunks,
      screen: this.#router.current,
      failed: false,
      end: () => {
        deaf()
        unwatch()
        limit.cancel()
        meter?.cancel()
        this.#recording = null
      },
    }
    this.#recording = recording
    this.#voice.onListen?.()
    listening()
    const unwatch = this.#glasses.onMic(open => {
      if (open || recording.failed || this.#recording !== recording) return
      recording.failed = true
      meter?.cancel()
      this.notice(this.#words.noMic)
    })
    const deaf = this.#glasses.listen(hear, { alone: true })
  }

  #release(): void {
    const recording = this.#recording
    const voice = this.#voice
    if (!recording || !voice) return
    recording.end()
    if (recording.failed) return
    const pcm = joinPcm(recording.chunks)
    if (this.#router.current !== recording.screen) return this.#clear()
    if (problemWith(pcm)) return this.notice(this.#words.missed)
    void this.#decide(voice, { pcm, seconds: secondsOf(pcm) })
  }

  async #decide(voice: VoiceOptions, audio: Audio): Promise<void> {
    const turn = ++this.#turn
    const screen = this.#router.current
    const life = this.#life.child()
    const mine = () => turn === this.#turn && !this.#life.ended
    const moved = () => this.#router.current !== screen
    const finish = (then: () => void) => {
      if (!mine()) return
      this.#deciding = null
      slow.cancel()
      life.end()
      if (moved()) this.#clear()
      else then()
    }
    const slow = this.#life.timeout(() => finish(() => (this.#turn++, this.notice(this.#words.slow))), voice.timeoutMs ?? VOICE_TIMEOUT_MS)
    this.#deciding = life
    this.#show(this.#words.thinking)
    try {
      const transcript = await voice.transcribe(audio, life)
      const words = transcript?.trim() ?? ''
      if (!mine() || moved()) return finish(() => {})
      if (transcript !== null && !words) return finish(() => this.notice(this.#words.missed))
      const heard = words ? `"${words}"` : this.#words.thinking
      this.#show(heard)
      const verdict = await this.#ask(voice, { words, audio, life }, transcript !== null)
      finish(() => {
        if (transcript === null && (verdict.kind === 'none' || verdict.kind === 'notMine')) return this.notice(this.#words.missed)
        if (words) this.#show(heard, HEARD_MS)
        else this.#clear()
        this.#act(verdict)
      })
    } catch (error) {
      finish(() => {
        if (error instanceof LifetimeEnded) return this.#clear()
        if (!(error instanceof SayError)) console.error(error)
        this.notice(error instanceof SayError ? error.say : this.#words.voiceFailed)
      })
    }
  }

  #context(): string {
    const current = this.#router.current
    const drawn = this.#drawn
    const under = drawn && drawn.screen === current ? drawn.targets[this.#places.get(current)?.cursor ?? 0] : undefined
    const selected = under && !under.private ? `${this.#words.selected}: ${under.say}` : ''
    return [current.context?.() ?? '', selected].filter(Boolean).join('\n').slice(-ITEM_LIMIT)
  }

  async #ask(voice: VoiceOptions, said: { words: string; audio: Audio; life: Lifetime }, navigate: boolean): Promise<Verdict> {
    const agents = [...(navigate ? [navigator(voice.model ?? matchWords)] : []), ...(voice.agents ?? [])]
    for (const [index, agent] of agents.entries()) {
      if (said.life.ended) throw new LifetimeEnded()
      const screen = this.#context()
      const verdict = await agent({
        ...said,
        actions: this.#reachable(),
        rolling: voice.rolling?.items() ?? [],
        hasNext: index < agents.length - 1,
        ...(voice.otherwise === undefined ? {} : { otherwise: voice.otherwise }),
        ...(screen ? { screen } : {}),
      })
      if (verdict.kind !== 'notMine') return verdict
    }
    return { kind: 'none' }
  }

  #act(verdict: Verdict): void {
    if (verdict.kind === 'none' || verdict.kind === 'notMine') return this.notice(this.#words.noMatch)
    if (verdict.kind === 'handled') {
      if (verdict.say !== undefined) this.notice(verdict.say)
      return this.redraw()
    }
    if (verdict.kind === 'sure') return this.#do(verdict.action, verdict.target, true)
    const which = action<Pick>({
      id: 'earshot.which',
      say: this.#words.which,
      targets: () => verdict.candidates.map((candidate, index) => ({ id: String(index), say: candidate.say, value: candidate })),
      run: candidate => this.#do(candidate.action, candidate.target, this.#said),
    })
    this.#clear()
    this.#openOwn({ id: 'earshot.which', view: () => list({ title: this.#words.which, action: which }) })
  }

  #do(id: string, targetId: string | undefined, said: boolean): void {
    const rolled = this.#voice?.rolling?.items().find(item => item.action.id === id && item.target === targetId)?.action
    const found = this.#reachable().find(a => a.id === id) ?? rolled
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found, targetId, said)
  }

  #jumps(chosen: Action, targetId?: string): boolean {
    if (this.#router.anywhere(chosen)) return true
    const rolled = this.#voice?.rolling?.items().some(item => item.action.id === chosen.id && item.target === targetId) ?? false
    return rolled && !this.#reachable().some(a => a.id === chosen.id)
  }

  #picked(item: number): void {
    const shown = this.#shown()
    if (shown && shown !== this.#router.current) return
    const id = [...this.#items].find(([, number]) => number === item)?.[0]
    const folded = this.#drawn?.folded ?? []
    if (id === MORE && folded.length) {
      return this.#openOwn({ id: MORE, view: () => list({ title: this.#words.more, action: this.#chooser(folded) }) })
    }
    const found = this.#router.actions().find(a => a.id === id)
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found)
  }

  async #start(chosen: Action, targetId?: string, said = false): Promise<void> {
    const why = chosen.blocked()
    if (why !== null) return this.notice(why)
    const targets = chosen.targets()
    if (targets !== null && targetId === undefined) {
      if (chosen.choose) return chosen.choose()
      return this.#openOwn({ id: 'earshot.pick', view: () => list({ title: chosen.say, action: chosen }) })
    }
    const target = targets?.find(candidate => candidate.id === targetId)
    const risk = target?.risk ?? chosen.risk
    if (risk === 'safe' || (risk === 'voice' && !said)) return this.#run(chosen, targetId, said)
    this.#show(`${chosen.say}${target ? `: ${target.say}` : ''}?\n${this.#words.confirm}`)
    this.#asking = () => void this.#run(chosen, targetId)
  }

  // An action the shell made (choose, More, which one) starts another: it has to know the words chose it.
  async #run(chosen: Action, targetId?: string, said = false): Promise<void> {
    try {
      this.#said = said
      const running = this.#jumps(chosen, targetId) ? this.#router.jumping(() => chosen.run(targetId)) : chosen.run(targetId)
      this.#said = false
      const outcome = await this.#life.guard(running)
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
