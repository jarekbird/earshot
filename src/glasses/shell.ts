import { action, type Action, type TargetInfo } from '../action.js'
import { joinPcm, levelOf, problemWith, QUIET, secondsOf, type Audio, type Sound } from '../audio.js'
import { LifetimeEnded, type Lifetime, type Timer } from '../lifetime.js'
import { ITEM_LIMIT } from '../context.js'
import { matchWords, navigator, SAME, type Agent, type NavigatorModel, type Pick, type Verdict } from '../navigator.js'
import type { Rolling } from '../rolling.js'
import type { Router, Screen } from '../router.js'
import { SayError } from '../say.js'
import { list, type Bound, type View } from '../view.js'
import type { Box, Picture } from './frame.js'
import { OVERLAY, WHOLE, type Glasses } from './glasses.js'
import type { HoldSource, Input } from './input.js'
import { layoutList, layoutText, type Stride, type TextState } from './layout.js'
import { MAX_MENU_ITEMS } from './limits.js'
import { HOLD, type Held } from './mic.js'

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
  swipe: string
}

export interface VoiceOptions {
  transcribe: (audio: Audio, life: Lifetime) => Promise<string | null>
  model?: NavigatorModel
  agents?: Agent[]
  otherwise?: string
  instead?: string
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
  swipe: 'Swipe',
}
const NOTICE_MS = 3_000
const LISTENING_SEEN_MS = 3_000
const HEARD_MS = 1_500
const VOICE_TIMEOUT_MS = 45_000
const MAX_HOLD_MS = 60_000
const LONGEST_HOLD_MS = 86_400_000
const METER_BARS = 8
const METER_MS = 300
const SCROLL_LINES = 2
const SCREENFUL = 8
const MORE = 'earshot.more'
const UP = 'earshot.up'
const DOWN = 'earshot.down'
const CHOOSE = 'earshot.choose'
const INSTEAD = 'instead'
const BACK = 'back'

const boundTo = (bound: Bound): { action: Action; target?: string } => ('action' in bound ? bound : { action: bound })

interface Place {
  cursor: number
  top: number
}

type Gesture = 'tap' | 'up' | 'down'
type Rows = (action: string, target?: string) => boolean

interface Recording {
  chunks: Uint8Array[]
  screen: Screen
  source: HoldSource
  hear: (sound: Sound) => void
  noted: () => { text: string; ms: number } | undefined
  note: (text: string) => void
  end: () => void
}
type Aims = Partial<Record<Gesture, string>>

interface Drawn {
  frame: number
  screen: Screen
  view: View
  aims: Aims
  targets: readonly TargetInfo[]
  folded: readonly Action[]
  scrolls: boolean
  page: Page
}

interface Page {
  at: number
  atEnd: boolean
  swipe: Stride
  screenful: Stride
}

export class Shell {
  readonly #life: Lifetime
  readonly #glasses: Glasses
  readonly #router: Router
  readonly #words: ShellWords
  readonly #noticeMs: number
  readonly #voice: VoiceOptions | undefined
  readonly #places = new WeakMap<Screen, Place>()
  readonly #own = new WeakMap<Screen, Rows>()
  readonly #items = new Map<string, number>()
  #drawn: Drawn | null = null
  #asking: { yes: () => void; no?: () => void } | null = null
  #overlaid = false
  #ofTurn = false
  #spent = false
  #over: string | null = null
  #fading: Timer | undefined
  #recording: Recording | null = null
  readonly #down = new Map<HoldSource, Timer>()
  #held: Held | null = null
  #turn = 0
  #said = false
  #deciding: Lifetime | null = null
  #asked: Array<{ frame: number; screen: Screen; page: Page; aims: Aims }> = []

  constructor(parent: Lifetime, glasses: Glasses, router: Router, options: ShellOptions = {}) {
    this.#life = parent.child()
    this.#glasses = glasses
    this.#router = router
    this.#words = { ...WORDS, ...options.words }
    this.#noticeMs = options.noticeMs ?? NOTICE_MS
    this.#voice = options.voice
    this.#life.own(glasses.onInput(input => this.#input(input)))
    this.#life.own(() => {
      this.#recording?.end()
      this.#letGo()
      if (this.#overlaid) this.#glasses.overlay(null)
    })
    this.#life.own(
      router.onChange(current => {
        if (this.#asking) this.#clear()
        if (this.#recording && this.#recording.screen !== current) {
          const noted = this.#recording.noted()
          this.#recording.end()
          this.#spent = true
          if (noted && noted.ms > 0) this.#show(noted.text, noted.ms)
          else this.#clearOfTurn()
        }
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
    let page: Page = { at: 0, atEnd: false, swipe: { up: SCROLL_LINES, down: SCROLL_LINES }, screenful: { up: SCREENFUL, down: SCREENFUL } }
    let targets: readonly TargetInfo[] = []
    if (view.kind === 'list') {
      targets = view.action.targets() ?? []
      const laid = layoutList(view, targets, place)
      Object.assign(place, laid.state)
      boxes = laid.boxes
    } else if (view.kind === 'text') {
      const laid = layoutText(view, place)
      Object.assign(place, laid.state)
      scrolls = laid.scrolls
      page = { at: laid.at, atEnd: laid.atEnd, swipe: laid.stride(SCROLL_LINES), screenful: laid.stride(SCREENFUL) }
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
    const aim = (bound: Bound, target = boundTo(bound).target) => JSON.stringify([view.kind, boundTo(bound).action.id, target ?? null])
    const under = targets[place.cursor]
    const aims: Aims =
      view.kind === 'list'
        ? under
          ? { tap: aim(view.action, under.id) }
          : {}
        : view.kind === 'boxes'
          ? Object.fromEntries(Object.entries(view.on ?? {}).map(([gesture, bound]) => [gesture, aim(bound)]))
          : {}
    this.#shown()
    const frame = this.#glasses.draw({ boxes, pictures, menu })
    this.#drawn = { frame, screen, view, aims, targets, folded: fold ? offered.slice(MAX_MENU_ITEMS - 1) : [], scrolls, page }
    this.#asked.push({ frame, screen, page, aims })
  }

  #scroll(drawn: Drawn, place: TextState, by: 'swipe' | 'screenful', up: boolean): void {
    this.#shown()
    const seen = this.#asked[0]
    const onGlasses = seen && seen.frame <= this.#glasses.shown && seen.screen === drawn.screen ? seen.page : drawn.page
    const from = place.away ? drawn.page : onGlasses
    const lines = up ? -from[by].up : from[by].down
    if (drawn.view.kind !== 'text' || !drawn.view.end) place.top += lines
    else if (!up && from.atEnd) Object.assign(place, { top: 0, away: false })
    else Object.assign(place, { top: from.at + lines, away: true })
    this.redraw()
  }

  #aimed(drawn: Drawn, gesture: Gesture): boolean {
    this.#shown()
    const aim = drawn.aims[gesture]
    const [seen] = this.#asked
    if (aim === undefined || !seen || seen.frame > this.#glasses.shown || !this.#glasses[WHOLE]) return false
    return seen.screen === drawn.screen && seen.aims[gesture] === aim
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
            ? [
                action({ id: UP, say: this.#words.scrollUp, run: () => this.#scroll(drawn, place, 'screenful', true) }),
                action({ id: DOWN, say: this.#words.scrollDown, run: () => this.#scroll(drawn, place, 'screenful', false) }),
              ]
            : []
          : drawn.targets.length === 0
            ? []
            : [
                move(UP, this.#words.moveUp, -1, 'cursor'),
                move(DOWN, this.#words.moveDown, 1, 'cursor'),
                Object.assign(action({ id: CHOOSE, say: this.#words.choose, run: () => this.#choose(drawn, place, this.#said) }), {
                  [SAME]: () => {
                    const under = drawn.targets[place.cursor]
                    return under ? { action: view.action.id, target: under.id } : undefined
                  },
                }),
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
    if (this.#recording) return this.#recording.note(text)
    this.#show(text, this.#noticeMs)
  }

  #show(text: string, ms?: number, ofTurn = false): void {
    this.#fading?.cancel()
    this.#fading = ms === undefined ? undefined : this.#life.timeout(() => this.#clear(), ms)
    this.#asking = null
    this.#overlaid = true
    this.#ofTurn = ofTurn
    this.#over = text
    this.#glasses.overlay(text)
  }

  #clear(): void {
    this.#fading?.cancel()
    this.#fading = undefined
    this.#asking = null
    this.#overlaid = false
    this.#ofTurn = false
    this.#over = null
    this.#glasses.overlay(null)
  }

  #clearOfTurn(): void {
    if (this.#ofTurn) this.#clear()
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

  #openOwn(screen: Screen, rows: Rows): void {
    this.#own.set(screen, rows)
    this.#router.open(screen)
  }

  #input(input: Input): void {
    if (this.#life.ended) return
    if (input.kind === 'foreground') return
    if (input.kind === 'background' || input.kind === 'exit') {
      this.#letGo()
      return this.#recording || this.#deciding ? this.#callOff() : undefined
    }
    if (input.kind === 'hold') return this.#hold(input.source)
    if (input.kind === 'release') return this.#release(input.source)
    if (this.#recording || this.#deciding) {
      if (!this.#recording || input.kind === 'double') this.#callOff()
      return
    }
    const asking = this.#asking
    const onShow = this.#glasses[OVERLAY]
    const aimed = input.kind === 'tap' || input.kind === 'up' || input.kind === 'down'
    if (asking && aimed && onShow !== this.#over) return
    const covered = this.#overlaid || onShow !== null
    if (this.#overlaid) this.#clear()
    if (asking) return input.kind === 'tap' ? asking.yes() : input.kind === 'up' || input.kind === 'down' ? asking.no?.() : undefined
    if (input.kind === 'double') {
      if (!this.#router.back()) void this.#glasses.leave()
      return
    }
    if (input.kind === 'menu') return this.#picked(input.item)
    if (covered) return
    const drawn = this.#drawn
    const screen = this.#router.current
    const place = this.#places.get(screen)
    if (!drawn || drawn.screen !== screen || !place) return
    const { view } = drawn
    if (view.kind === 'boxes') {
      const bound = view.on?.[input.kind]
      if (!bound || !this.#aimed(drawn, input.kind)) return
      const { action: chosen, target } = boundTo(bound)
      return void this.#start(chosen, target)
    }
    const step = input.kind === 'up' ? -1 : 1
    if (view.kind === 'text') {
      if (input.kind !== 'tap') return this.#scroll(drawn, place, 'swipe', step < 0)
    } else if (input.kind !== 'tap') place.cursor += step
    else return this.#aimed(drawn, 'tap') ? this.#choose(drawn, place) : undefined
    this.redraw()
  }

  #callOff(): void {
    this.#turn++
    this.#deciding?.end()
    this.#deciding = null
    this.#recording?.end()
    this.#clear()
  }

  #letGo(): void {
    for (const lost of this.#down.values()) lost.cancel()
    this.#down.clear()
    this.#held?.letGo()
    this.#held = null
    this.#spent = false
  }

  #lift(source: HoldSource): void {
    const touchpad = this.#down.has(source) ? source : this.#down.has('unknown') ? 'unknown' : undefined
    if (touchpad === undefined) return
    this.#down.get(touchpad)?.cancel()
    this.#down.delete(touchpad)
    const mine = this.#recording?.source === touchpad
    if (this.#down.size === 0) this.#letGo()
    if (mine) this.#finish()
  }

  #hold(source: HoldSource): void {
    const voice = this.#voice
    const longest = Math.min(voice?.maxHoldMs ?? MAX_HOLD_MS, LONGEST_HOLD_MS)
    this.#down.get(source)?.cancel()
    this.#down.set(
      source,
      this.#life.timeout(() => this.#lift(source), 2 * longest),
    )
    const refused = () => {
      if (!this.#recording) return
      this.#recording.end()
      this.notice(this.#words.noMic)
    }
    this.#held ??= this.#glasses[HOLD](sound => this.#recording?.hear(sound), refused)
    if (!voice) {
      if (!this.#recording) this.#callOff()
      return this.notice(this.#words.noVoice)
    }
    if (this.#recording || this.#spent) return
    this.#callOff()
    const chunks: Uint8Array[] = []
    const bars = Array<string>(METER_BARS).fill(QUIET)
    let noted: string | undefined
    let gone = 0
    let fading: Timer | undefined
    const listening = () =>
      this.#show(`${this.#words.listening} ${bars.join('')}${noted === undefined ? '' : `\n${noted}`}`, undefined, true)
    let meter: Timer | undefined
    const limit = this.#life.timeout(() => this.#finish(), longest)
    let seen = false
    const look = () => {
      const onShow = this.#glasses[OVERLAY]
      seen ||= typeof onShow === 'string' && onShow.startsWith(this.#words.listening)
    }
    const unseen = this.#life.timeout(() => {
      look()
      if (seen || this.#recording !== recording) return
      recording.end()
      this.#spent = true
      this.#clearOfTurn()
    }, LISTENING_SEEN_MS)
    const recording: Recording = {
      chunks,
      screen: this.#router.current,
      source,
      noted: () => (noted === undefined ? undefined : { text: noted, ms: gone - Date.now() }),
      note: (text: string) => {
        fading?.cancel()
        noted = text
        gone = Date.now() + this.#noticeMs
        fading = this.#life.timeout(() => {
          noted = undefined
          listening()
        }, this.#noticeMs)
        listening()
      },
      hear: ({ pcm }: Sound) => {
        look()
        chunks.push(pcm)
        bars.push(levelOf(pcm))
        bars.shift()
        meter ??= this.#life.timeout(() => {
          meter = undefined
          listening()
        }, METER_MS)
      },
      end: () => {
        limit.cancel()
        meter?.cancel()
        fading?.cancel()
        unseen.cancel()
        if (this.#recording !== recording) return
        this.#recording = null
        this.#held?.want(false)
      },
    }
    this.#recording = recording
    this.#held.want(true)
    listening()
    voice.onListen?.()
  }

  #release(source: HoldSource): void {
    this.#lift(source)
  }

  #finish(): void {
    const recording = this.#recording
    const voice = this.#voice
    if (!recording || !voice) return
    recording.end()
    const pcm = joinPcm(recording.chunks)
    if (problemWith(pcm)) return this.notice(this.#words.missed)
    void this.#decide(voice, { pcm, seconds: secondsOf(pcm) })
  }

  async #decide(voice: VoiceOptions, audio: Audio, passed?: string): Promise<void> {
    const turn = ++this.#turn
    const screen = this.#router.current
    const life = this.#life.child()
    const mine = () => turn === this.#turn && !this.#life.ended
    const moved = () => this.#router.current !== screen
    const finish = (then: () => void, elsewhere = () => this.#clearOfTurn()) => {
      if (!mine()) return
      this.#deciding = null
      slow.cancel()
      life.end()
      if (moved()) elsewhere()
      else then()
    }
    const slow = this.#life.timeout(() => {
      if (!mine()) return
      finish(() => this.notice(this.#words.slow))
      this.#turn++
    }, voice.timeoutMs ?? VOICE_TIMEOUT_MS)
    this.#deciding = life
    if (passed === undefined) this.#show(this.#words.thinking, undefined, true)
    try {
      const transcript = passed ?? (await voice.transcribe(audio, life))
      const words = transcript?.trim() ?? ''
      if (!mine() || moved()) return finish(() => {})
      if (transcript !== null && !words) return finish(() => this.notice(this.#words.missed))
      const heard = words ? `"${words}"` : this.#words.thinking
      this.#show(heard, undefined, true)
      const still = () => mine() && !moved()
      const { verdict, more } = await this.#ask(voice, { words, audio, life }, passed === undefined && transcript !== null, still)
      const done = verdict.kind === 'handled' && verdict.say !== undefined ? verdict.say : undefined
      finish(
        () => {
          if (transcript === null && (verdict.kind === 'none' || verdict.kind === 'notMine')) return this.notice(this.#words.missed)
          if (words) this.#show(heard, HEARD_MS)
          else this.#clear()
          this.#act(verdict, more ? () => void this.#decide(voice, audio, words) : undefined)
        },
        () => (done === undefined ? this.#clearOfTurn() : this.notice(done)),
      )
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

  async #ask(
    voice: VoiceOptions,
    said: { words: string; audio: Audio; life: Lifetime },
    navigate: boolean,
    still: () => boolean,
  ): Promise<{ verdict: Verdict; more: boolean }> {
    const agents = [...(navigate ? [navigator(voice.model ?? matchWords)] : []), ...(voice.agents ?? [])]
    for (const [index, agent] of agents.entries()) {
      if (said.life.ended) throw new LifetimeEnded()
      if (!still()) break
      const screen = this.#context()
      const verdict = await agent({
        ...said,
        actions: this.#reachable(),
        rolling: voice.rolling?.items() ?? [],
        hasNext: index < agents.length - 1,
        ...(voice.otherwise === undefined ? {} : { otherwise: voice.otherwise }),
        ...(screen ? { screen } : {}),
      })
      if (verdict.kind !== 'notMine') return { verdict, more: navigate && index === 0 && agents.length > 1 }
    }
    return { verdict: { kind: 'none' }, more: false }
  }

  #act(verdict: Verdict, pass?: () => void): void {
    if (verdict.kind === 'none' || verdict.kind === 'notMine') return this.notice(this.#words.noMatch)
    if (verdict.kind === 'handled') {
      if (verdict.say !== undefined) this.notice(verdict.say)
      return this.redraw()
    }
    if (verdict.kind === 'sure') return this.#do(verdict.action, verdict.target, true, pass)
    const instead = pass && this.#voice?.instead
    const which = action<Pick | null>({
      id: 'earshot.which',
      say: this.#words.which,
      targets: () => [
        ...verdict.candidates.map((candidate, index) => ({ id: String(index), say: candidate.say, value: candidate })),
        ...(instead ? [{ id: INSTEAD, say: instead, value: null }] : []),
      ],
      run: candidate => (candidate ? this.#do(candidate.action, candidate.target, this.#said) : pass?.()),
    })
    this.#clear()
    this.#openOwn({ id: 'earshot.which', view: () => list({ title: this.#words.which, action: which }) }, (id, target) =>
      verdict.candidates.some(candidate => candidate.action === id && candidate.target === target),
    )
  }

  #do(id: string, targetId: string | undefined, said: boolean, pass?: () => void): void {
    const rolled = this.#voice?.rolling?.items().find(item => item.action.id === id && item.target === targetId)?.action
    const found = this.#reachable().find(a => a.id === id) ?? rolled
    if (!found) return this.notice(this.#words.unavailable)
    if (id !== BACK && this.#own.get(this.#router.current)?.(id, targetId)) this.#router.back()
    void this.#start(found, targetId, said, pass)
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
      return this.#openOwn(
        { id: MORE, view: () => list({ title: this.#words.more, action: this.#chooser(folded) }) },
        (id, target) => target === undefined && folded.some(a => a.id === id),
      )
    }
    const found = this.#router.actions().find(a => a.id === id)
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found)
  }

  async #start(chosen: Action, targetId?: string, said = false, pass?: () => void): Promise<void> {
    const why = chosen.blocked()
    if (why !== null) return this.notice(why)
    const targets = chosen.targets()
    if (targets !== null && targetId === undefined) {
      if (chosen.choose) return chosen.choose()
      return this.#openOwn(
        { id: 'earshot.pick', view: () => list({ title: chosen.say, action: chosen }) },
        (id, target) => id === chosen.id && target !== undefined,
      )
    }
    const target = targets?.find(candidate => candidate.id === targetId)
    const risk = target?.risk ?? chosen.risk
    if (risk === 'safe' || (risk === 'voice' && !said)) return this.#run(chosen, targetId, said)
    const instead = pass && this.#voice?.instead
    const asked = [
      `${chosen.say}${target ? `: ${target.say}` : ''}?`,
      this.#words.confirm,
      ...(instead ? [`${this.#words.swipe}: ${instead}`] : []),
    ]
    this.#show(asked.join('\n'))
    this.#asking = { yes: () => void this.#run(chosen, targetId), ...(instead ? { no: pass } : {}) }
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
