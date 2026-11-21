import { action, type Action, type TargetInfo } from '../action.js'
import { joinPcm, problemWith, secondsOf, type Audio } from '../audio.js'
import { LifetimeEnded, type Lifetime, type Timer } from '../lifetime.js'
import { ITEM_LIMIT } from '../context.js'
import { matchWords, navigator, type Agent, type NavigatorModel, type Pick, type Verdict } from '../navigator.js'
import type { Rolling } from '../rolling.js'
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
  listening: string
  thinking: string
  noVoice: string
  noMic: string
  missed: string
  noMatch: string
  slow: string
  voiceFailed: string
  which: string
}

export class SayError extends Error {
  constructor(readonly say: string) {
    super(say)
    this.name = 'SayError'
  }
}

export interface VoiceOptions {
  transcribe: (audio: Audio) => Promise<string>
  model?: NavigatorModel
  agents?: Agent[]
  otherwise?: string
  rolling?: Rolling
  timeoutMs?: number
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
}
const NOTICE_MS = 3_000
const HEARD_MS = 1_500
const VOICE_TIMEOUT_MS = 15_000
const MAX_HOLD_MS = 60_000
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
  readonly #voice: VoiceOptions | undefined
  readonly #places = new WeakMap<Screen, Place>()
  readonly #own = new WeakSet<Screen>()
  readonly #items = new Map<string, number>()
  #drawn: Drawn | null = null
  #asking: (() => void) | null = null
  #overlaid = false
  #fading: Timer | undefined
  #recording: { chunks: Uint8Array[]; end: () => void } | null = null
  #turn = 0
  #deciding = false

  constructor(parent: Lifetime, glasses: Glasses, router: Router, options: ShellOptions = {}) {
    this.#life = parent.child()
    this.#glasses = glasses
    this.#router = router
    this.#words = { ...WORDS, ...options.words }
    this.#noticeMs = options.noticeMs ?? NOTICE_MS
    this.#voice = options.voice
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
      run: chosen => this.#start(chosen),
    })
  }

  #openOwn(screen: Screen): void {
    this.#own.add(screen)
    this.#router.open(screen)
  }

  #input(input: Input): void {
    if (input.kind === 'foreground' || input.kind === 'background' || input.kind === 'exit') return
    if (input.kind === 'hold') return this.#hold()
    if (input.kind === 'release') return this.#release()
    if (this.#recording || this.#deciding) {
      if (this.#recording && input.kind !== 'double') return
      this.#callOff()
      if (input.kind === 'double') return
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

  #callOff(): void {
    this.#turn++
    this.#deciding = false
    this.#recording?.end()
    this.#clear()
  }

  #hold(): void {
    if (this.#recording) return
    this.#callOff()
    if (!this.#voice) return this.notice(this.#words.noVoice)
    const chunks: Uint8Array[] = []
    const deaf = this.#glasses.onAudio(pcm => chunks.push(pcm))
    const limit = this.#life.timeout(() => this.#release(), MAX_HOLD_MS)
    const recording = {
      chunks,
      end: () => {
        deaf()
        limit.cancel()
        this.#recording = null
        void this.#glasses.closeMic()
      },
    }
    this.#recording = recording
    this.#show(this.#words.listening)
    void this.#glasses.openMic().then(open => {
      if (open || this.#recording !== recording) return
      recording.end()
      this.notice(this.#words.noMic)
    })
  }

  #release(): void {
    const recording = this.#recording
    const voice = this.#voice
    if (!recording || !voice) return
    recording.end()
    const pcm = joinPcm(recording.chunks)
    if (problemWith(pcm)) return this.notice(this.#words.missed)
    void this.#decide(voice, { pcm, seconds: secondsOf(pcm) })
  }

  async #decide(voice: VoiceOptions, audio: Audio): Promise<void> {
    const turn = ++this.#turn
    const screen = this.#router.current
    const mine = () => turn === this.#turn && !this.#life.ended
    const moved = () => this.#router.current !== screen
    const finish = (then: () => void) => {
      if (!mine()) return
      this.#deciding = false
      slow.cancel()
      if (moved()) this.#clear()
      else then()
    }
    const slow = this.#life.timeout(() => finish(() => (this.#turn++, this.notice(this.#words.slow))), voice.timeoutMs ?? VOICE_TIMEOUT_MS)
    this.#deciding = true
    this.#show(this.#words.thinking)
    try {
      const words = (await voice.transcribe(audio)).trim()
      if (!mine() || moved()) return finish(() => {})
      if (!words) return finish(() => this.notice(this.#words.missed))
      const heard = `"${words}"`
      this.#show(heard)
      const verdict = await this.#ask(voice, words)
      finish(() => {
        this.#show(heard, HEARD_MS)
        this.#act(verdict)
      })
    } catch (error) {
      finish(() => {
        if (!(error instanceof SayError)) console.error(error)
        this.notice(error instanceof SayError ? error.say : this.#words.voiceFailed)
      })
    }
  }

  async #ask(voice: VoiceOptions, words: string): Promise<Verdict> {
    const agents = [navigator(voice.model ?? matchWords), ...(voice.agents ?? [])]
    for (const [index, agent] of agents.entries()) {
      const screen = this.#router.current.context?.().slice(-ITEM_LIMIT)
      const verdict = await agent({
        words,
        actions: this.#router.actions(),
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
    if (verdict.kind === 'sure') return this.#do(verdict.action, verdict.target)
    const which = action<Pick>({
      id: 'earshot.which',
      say: this.#words.which,
      targets: () => verdict.candidates.map((candidate, index) => ({ id: String(index), say: candidate.say, value: candidate })),
      run: candidate => this.#do(candidate.action, candidate.target),
    })
    this.#clear()
    this.#openOwn({ id: 'earshot.which', view: () => list({ title: this.#words.which, action: which }) })
  }

  #do(id: string, targetId?: string): void {
    const rolled = this.#voice?.rolling?.items().find(item => item.action.id === id && item.target === targetId)?.action
    const found = this.#router.actions().find(a => a.id === id) ?? rolled
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found, targetId)
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
    this.#show(`${chosen.say}${target ? `: ${target.say}` : ''}?\n${this.#words.confirm}`)
    this.#asking = () => void this.#run(chosen, targetId)
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
