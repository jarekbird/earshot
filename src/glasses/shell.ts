import { action, unless, type Action, type TargetInfo } from '../action.js'
import { joinPcm, levelOf, problemWith, QUIET, secondsOf, type Audio, type Sound } from '../audio.js'
import { Lifetime, LifetimeEnded, type Timer } from '../lifetime.js'
import { ITEM_LIMIT } from '../context.js'
import { matchWords, navigator, type Agent, type NavigatorModel, type Pick, type Verdict } from '../navigator.js'
import type { Rolling } from '../rolling.js'
import { showingsOf, type Router, type Screen } from '../router.js'
import { SayError } from '../say.js'
import { serve } from '../serve.js'
import { list, type Bound, type View } from '../view.js'
import type { Box, Picture } from './frame.js'
import { after, copied, Frames, type Aims, type Gesture, type Read } from './frames.js'
import { OVERLAY, plainFrame, progressOf, WHOLE, type Glasses } from './glasses.js'
import type { HoldSource, Input } from './input.js'
import { BODY, layoutList, layoutText, type LaidText, type TextState } from './layout.js'
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
const TURN_END = 'end of a voice turn'
const TURN_SET = 'settings of a voice turn'

const boundTo = (bound: Bound): { action: Action; target?: string } => ('action' in bound ? bound : { action: bound })

interface Place {
  cursor: number
  top: number
  away?: boolean
}

interface Drawn {
  frame: number
  screen: Screen
  showing: object
  view: View
  targets: readonly TargetInfo[]
  folded: readonly Action[]
  scrolls: boolean
}

const GESTURES: readonly Gesture[] = ['tap', 'up', 'down']

const tied = (bound: Bound): { action: Action; target?: string } => {
  const { action, target } = boundTo(bound)
  return target === undefined ? { action } : { action, target }
}

const aimOf = (action: Action, target?: string): string => JSON.stringify([action.id, target ?? null])

const rowAim = (target: string): string => JSON.stringify([target])

function once(given: Verdict, mine: () => boolean, moved: () => boolean): Verdict {
  const { kind } = given
  if (!mine()) throw new LifetimeEnded()
  if (kind === 'handled') {
    const { say } = given as { say?: string }
    return say === undefined ? { kind } : { kind, say }
  }
  if (moved()) return { kind: 'none' }
  if (kind === 'sure') {
    const named = given as { action: string; target?: string }
    return {
      kind,
      get action() {
        return named.action
      },
      get target() {
        return named.target
      },
    }
  }
  if (kind === 'unsure') {
    const unsure = given as { candidates: Pick[] }
    return {
      kind,
      get candidates() {
        return unsure.candidates
      },
    }
  }
  return { kind }
}

const sameText = (one: Read['view'], other: Read['view']) => one.title === other.title && one.body === other.body && one.end === other.end

export class Shell {
  readonly #life: Lifetime
  readonly #glasses: Glasses
  readonly #router: Router
  readonly #words: ShellWords
  readonly #noticeMs: number
  readonly #voice: VoiceOptions | undefined
  readonly #places = new WeakMap<object, Place>()
  readonly #own = new WeakSet<Screen>()
  readonly #items = new Map<string, number>()
  #drawn: Drawn | null = null
  #asking: { yes: () => void; no?: () => void } | null = null
  #overlaid = false
  #noticed = false
  #over: string | null = null
  #spared: HoldSource | undefined
  #slow: Timer | undefined
  #fading: Timer | undefined
  #recording: {
    chunks: Uint8Array[]
    showing: object | undefined
    source: HoldSource
    hear: (sound: Sound) => void
    end: () => void
  } | null = null
  readonly #down = new Map<HoldSource, Timer>()
  readonly #spent = new Set<HoldSource>()
  #held: Held | null = null
  #turn = 0
  #said = false
  #deciding: Lifetime | null = null
  #decidingOn: object | null = null
  #handed = false
  readonly #frames: Frames
  #pending: number[] = []
  #moves = 0
  #draws = 0

  constructor(parent: Lifetime, glasses: Glasses, router: Router, options: ShellOptions = {}) {
    this.#life = parent.child()
    this.#glasses = glasses
    const sent = progressOf(glasses)
    this.#frames = new Frames({
      get shown() {
        return sent.shown
      },
      get menu() {
        return sent.menu
      },
      get sending() {
        return sent.sending
      },
      get text() {
        return sent.has(BODY)
      },
    })
    this.#life.own(sent.onChange(() => this.#frames.forget()))
    this.#life.own(() => this.#frames.end())
    this.#life.own(
      showingsOf(router).onLeave(lost => {
        this.#moves++
        const { onPath, current } = showingsOf(router)
        this.#frames.left(onPath)
        const spoken = this.#recording?.showing ?? (this.#handed ? undefined : this.#decidingOn)
        const closed = lost || (current !== undefined && !onPath(current))
        try {
          if (closed || (spoken !== undefined && spoken !== null && !onPath(spoken))) this.#callOff(true)
          else if (this.#deciding) this.#takeDown()
        } finally {
          if (closed) progressOf(this.#glasses).drop(this.#pending)
        }
      }),
    )
    this.#router = router
    this.#words = { ...WORDS, ...options.words }
    this.#noticeMs = options.noticeMs ?? NOTICE_MS
    this.#voice = options.voice
    this.#life.own(glasses.onInput(input => this.#input(input)))
    this.#life.own(() => {
      this.#recording?.end()
      this.#letGo()
      progressOf(this.#glasses).drop(this.#pending)
      if (this.#overlaid) this.#glasses.overlay(null)
    })
    this.#life.own(
      showingsOf(router).onMove(() => {
        this.#moves++
        const spoken = this.#recording?.showing ?? (this.#handed ? undefined : this.#decidingOn)
        try {
          if (spoken !== undefined && spoken !== null && spoken !== showingsOf(router).current) this.#callOff(true)
        } finally {
          if (this.#asking) this.#clear()
          else if (this.#deciding) this.#takeDown()
        }
      }),
    )
    this.#life.own(router.onChange(() => this.redraw()))
    this.redraw()
  }

  get busy(): boolean {
    return this.#recording !== null || this.#deciding !== null
  }

  redraw(): void {
    this.#draw()
  }

  #draw(read?: { view: Read['view']; laid: (state: TextState) => LaidText }): void {
    if (this.#life.ended) return
    const showings = showingsOf(this.#router)
    const showing = showings.current
    if (showing === undefined) return
    const asked = ++this.#draws
    const stale = () => this.#life.ended || asked !== this.#draws || showings.current !== showing || !showings.onPath(showing)
    const screen = this.#router.current
    const actions = this.#router.actions()
    const view = screen.view?.() ?? list({ action: this.#chooser(actions) })
    if (stale()) return
    const place = this.#places.get(showing) ?? { cursor: 0, top: 0 }
    let reached: Partial<Place> = {}
    let boxes: Box[]
    let pictures: Picture[] = []
    let scrolls = false
    let last = 0
    let kept: View = view
    let drew: Read | null = null
    let targets: readonly TargetInfo[] = []
    const listed = view.kind === 'list' ? view.action : undefined
    if (view.kind === 'list') {
      targets = listed?.targets() ?? []
      const laid = layoutList(view, targets, place)
      reached = laid.state
      boxes = laid.boxes
    } else if (view.kind === 'text') {
      const words = copied(view)
      const laid = (read && sameText(read.view, words) ? read.laid : layoutText(words))(place)
      reached = laid.state
      kept = words
      scrolls = laid.scrolls
      drew = { view: words, state: { ...(place.away === undefined ? {} : { away: place.away }), ...laid.state } }
      last = laid.last
      boxes = laid.boxes
    } else {
      const asked = plainFrame({ boxes: view.boxes, pictures: view.pictures ?? [] })
      boxes = asked.boxes
      pictures = asked.pictures ?? []
    }
    const on = view.kind === 'boxes' ? view.on : undefined
    const ties = GESTURES.flatMap(gesture => {
      const bound = on?.[gesture]
      return bound ? [{ gesture, ...tied(bound) }] : []
    })
    const byGesture = new Set(listed ? [listed.id] : ties.map(tie => tie.action.id))
    const offered = !screen.view || this.#own.has(screen) ? [] : actions.filter(a => !byGesture.has(a.id))
    const fold = offered.length > MAX_MENU_ITEMS
    const shown = fold ? offered.slice(0, MAX_MENU_ITEMS - 1) : offered
    const menu = shown.map(a => ({ id: this.#item(a.id), name: a.say }))
    if (fold) menu.push({ id: this.#item(MORE), name: this.#words.more })
    const under = targets[reached.cursor ?? place.cursor]
    const aims: Aims = listed
      ? under
        ? { tap: rowAim(under.id) }
        : {}
      : Object.fromEntries(ties.map(({ gesture, action, target }) => [gesture, aimOf(action, target)]))
    if (stale()) return
    this.#places.set(showing, Object.assign(place, reached))
    if (drew) this.#frames.drawing(showing, drew.view, last)
    const frame = this.#glasses.draw({ boxes, pictures, menu })
    this.#pending = [...this.#pending.filter(asked => asked === progressOf(this.#glasses).sending || asked > frame), frame]
    if (this.#life.ended || !showings.onPath(showing)) return progressOf(this.#glasses).drop([frame])
    if (!this.#drawn || frame > this.#drawn.frame)
      this.#drawn = {
        frame,
        screen,
        showing,
        view: kept,
        targets,
        folded: fold ? offered.slice(MAX_MENU_ITEMS - 1) : [],
        scrolls,
      }
    this.#frames.asked(frame, showing, drew, view.kind, aims)
  }

  #scroll(drawn: Drawn, place: TextState, by: 'swipe' | 'screenful', up: boolean): void {
    const showing = showingsOf(this.#router).current
    const read = showingsOf(this.#router).onPath(showing) ? this.#frames.read(showing) : null
    if (!read) return
    const { view, state, since } = read
    const text = layoutText(view)
    const from = text({ ...state })
    const stride = from.stride(by === 'swipe' ? SCROLL_LINES : SCREENFUL)
    const top = from.at + (up ? -stride.up : stride.down)
    const to = text(view.end && !up && from.atEnd ? { top: 0, away: false } : { top, away: true })
    const ends = drawn.view.kind === 'text' && drawn.view.end === true
    const swiped = { ...(ends ? { away: true } : state.away === undefined ? {} : { away: state.away }), ...to.state }
    Object.assign(place, after(since, swiped))
    this.#frames.swiping(showing, { view, state: swiped }, since)
    this.#draw({ view, laid: text })
  }

  #onShow(drawn: Drawn): Aims | undefined {
    const seen = this.#frames.whole
    return seen !== undefined && this.#glasses[WHOLE] && seen.showing === drawn.showing ? seen.aims : undefined
  }

  #aimed(drawn: Drawn, gesture: Gesture, aim: string): boolean {
    return this.#onShow(drawn)?.[gesture] === aim
  }

  #bound(view: View): Action[] {
    if (view.kind !== 'boxes' || !view.on) return []
    return [view.on.tap, view.on.up, view.on.down].flatMap(bound => (bound ? [boundTo(bound).action] : []))
  }

  #reachable(): Action[] {
    const drawn = this.#drawn
    const showing = showingsOf(this.#router).current
    const place = showing && this.#places.get(showing)
    const actions = [...this.#router.actions()]
    if (!drawn || drawn.showing !== showing || !place) return actions
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
                action({
                  id: CHOOSE,
                  say: this.#words.choose,
                  run: () => {
                    const said = this.#said
                    this.#choose(drawn, this.#row(drawn, place), said)
                  },
                }),
              ]
    const taken = new Set(actions.map(a => a.id))
    return [...actions, ...own.filter(a => !taken.has(a.id) && (taken.add(a.id), true))]
  }

  #row(drawn: Drawn, place: Place): { action: Action; target: string } | undefined {
    const under = drawn.targets[place.cursor]
    if (drawn.view.kind !== 'list' || !under) return undefined
    const action = drawn.view.action
    return { action, target: under.id }
  }

  #choose(drawn: Drawn, row: { action: Action; target: string } | undefined, said = false): void {
    if (!row) return
    if (this.#own.has(drawn.screen)) this.#router.back()
    void this.#start(row.action, row.target, said)
  }

  notice(text: string): void {
    this.#show(text, this.#noticeMs)
    this.#noticed = true
  }

  #show(text: string, ms?: number): void {
    this.#noticed = false
    this.#fading?.cancel()
    this.#fading = ms === undefined ? undefined : this.#life.timeout(() => this.#clear(), ms)
    this.#asking = null
    this.#overlaid = true
    this.#over = text
    this.#glasses.overlay(text)
  }

  #clear(mine = true): void {
    this.#noticed = false
    this.#fading?.cancel()
    this.#fading = undefined
    this.#asking = null
    this.#overlaid = false
    this.#over = null
    if (mine) this.#glasses.overlay(null)
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
    const showing = showingsOf(this.#router).current
    const place = showing && this.#places.get(showing)
    if (!drawn || drawn.showing !== showing || !place || !showingsOf(this.#router).onPath(showing)) return
    const { view } = drawn
    const moves = this.#moves
    if (view.kind === 'boxes') {
      const shown = this.#onShow(drawn)?.[input.kind]
      if (shown === undefined || this.#frames.newest?.aims[input.kind] !== shown) return
      const bound = view.on?.[input.kind]
      if (!bound || moves !== this.#moves) return
      const { action: chosen, target } = tied(bound)
      if (moves !== this.#moves) return
      return void this.#start(chosen, target)
    }
    const seen = this.#frames.words
    if (view.kind === 'text' && (seen?.kind !== 'text' || seen.showing !== showing)) return
    const step = input.kind === 'up' ? -1 : 1
    if (view.kind === 'text') {
      if (input.kind !== 'tap') return this.#scroll(drawn, place, 'swipe', step < 0)
    } else if (input.kind !== 'tap') place.cursor += step
    else {
      const row = this.#onShow(drawn) && this.#row(drawn, place)
      const aim = row && rowAim(row.target)
      return aim !== undefined && moves === this.#moves && this.#aimed(drawn, 'tap', aim) ? this.#choose(drawn, row) : undefined
    }
    this.redraw()
  }

  #takeDown(): void {
    if (this.#overlaid && !this.#noticed) this.#clear(progressOf(this.#glasses).card() === this.#over)
  }

  #callOff(moved = false): void {
    this.#turn++
    this.#slow?.cancel()
    const deciding = this.#deciding
    this.#deciding = null
    this.#decidingOn = null
    this.#handed = false
    serve(() => deciding?.end(), TURN_END)
    const pressed = this.#recording?.source
    try {
      this.#recording?.end()
    } finally {
      if (moved && this.#noticed) this.#spared = pressed
      else if (this.#overlaid) this.#clear(!moved || progressOf(this.#glasses).card() === this.#over)
    }
  }

  #letGo(): void {
    for (const lost of this.#down.values()) lost.cancel()
    this.#down.clear()
    this.#spent.clear()
    this.#spared = undefined
    this.#held?.letGo()
    this.#held = null
  }

  #lift(source: HoldSource): void {
    const touchpad = this.#down.has(source) ? source : this.#down.has('unknown') ? 'unknown' : undefined
    if (touchpad === undefined) return
    this.#down.get(touchpad)?.cancel()
    this.#down.delete(touchpad)
    this.#spent.delete(touchpad)
    if (this.#spared === touchpad) {
      this.#spared = undefined
      if (this.#overlaid) this.#clear()
    }
    const mine = this.#recording?.source === touchpad
    if (this.#down.size === 0) this.#letGo()
    if (mine) this.#finish()
  }

  #pressed(source: HoldSource, longest: number): void {
    this.#down.get(source)?.cancel()
    this.#down.set(
      source,
      this.#life.timeout(() => this.#lift(source), 2 * longest),
    )
  }

  #hold(source: HoldSource): void {
    const moves = this.#moves
    const showings = showingsOf(this.#router)
    const showing = showings.current
    const voice = this.#voice
    const longest = Math.min(voice?.maxHoldMs ?? MAX_HOLD_MS, LONGEST_HOLD_MS)
    if (this.#life.ended) return
    this.#pressed(source, longest)
    const refused = () => {
      if (!this.#recording) return
      this.#recording.end()
      this.notice(this.#words.noMic)
    }
    this.#held ??= this.#glasses[HOLD](sound => this.#recording?.hear(sound), refused)
    if (this.#spent.has(source)) return
    if (moves !== this.#moves) return void this.#spent.add(source)
    if (!showings.onPath(showing)) return
    if (!voice) {
      if (!this.#recording) this.#callOff()
      return this.notice(this.#words.noVoice)
    }
    if (this.#recording) return
    this.#callOff()
    if (moves !== this.#moves) return void this.#spent.add(source)
    const chunks: Uint8Array[] = []
    const bars = Array<string>(METER_BARS).fill(QUIET)
    const listening = () => this.#show(`${this.#words.listening} ${bars.join('')}`)
    let meter: Timer | undefined
    const limit = this.#life.timeout(() => this.#finish(), longest)
    const recording = {
      chunks,
      showing,
      source,
      hear: ({ pcm }: Sound) => {
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
        if (this.#recording !== recording) return
        this.#recording = null
        this.#held?.want(false)
      },
    }
    this.#recording = recording
    this.#spent.add(source)
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
    if (showingsOf(this.#router).current !== recording.showing || !showingsOf(this.#router).onPath(recording.showing)) return this.#clear()
    if (problemWith(pcm)) return this.notice(this.#words.missed)
    void this.#decide(voice, { pcm, seconds: secondsOf(pcm) })
  }

  async #decide(voice: VoiceOptions, audio: Audio, passed?: string): Promise<void> {
    const turn = ++this.#turn
    const moves = this.#moves
    const showing = showingsOf(this.#router).current
    const life = new Lifetime()
    life.own(this.#life.own(() => serve(() => life.end(), TURN_END)))
    const mine = () => turn === this.#turn && !this.#life.ended
    const moved = () => moves !== this.#moves
    const spare = () => this.#takeDown()
    const finish = (then: () => void, elsewhere: () => void = spare) => {
      if (!mine()) return
      slow.cancel()
      serve(() => life.end(), TURN_END)
      if (!mine()) return
      this.#deciding = null
      this.#decidingOn = null
      if (moved()) elsewhere()
      else then()
    }
    this.#deciding = life
    this.#decidingOn = showing ?? null
    let slow: Timer = { cancel: () => {} }
    let patience: number | undefined
    serve(() => void (patience = voice.timeoutMs ?? VOICE_TIMEOUT_MS), TURN_SET)
    if (patience === undefined) return finish(() => this.notice(this.#words.voiceFailed))
    slow = this.#slow = this.#life.timeout(() => {
      if (!mine()) return
      const over = (say: () => void) => () => {
        this.#turn++
        say()
      }
      finish(
        over(() => this.notice(this.#words.slow)),
        over(spare),
      )
    }, patience)
    if (!mine()) return slow.cancel()
    if (passed === undefined) this.#show(this.#words.thinking)
    try {
      const transcribe = passed === undefined ? voice.transcribe : undefined
      if (!mine() || moved()) return finish(() => {})
      const transcript = transcribe ? await Reflect.apply(transcribe, voice, [audio, life]) : (passed ?? null)
      const words = transcript?.trim() ?? ''
      if (!mine() || moved()) return finish(() => {})
      if (transcript !== null && !words) return finish(() => this.notice(this.#words.missed))
      const heard = words ? `"${words}"` : this.#words.thinking
      if (!moved()) this.#show(heard)
      const { verdict, more } = await this.#ask(voice, { words, audio, life }, passed === undefined && transcript !== null, moved, mine)
      const done = verdict.kind === 'handled' ? verdict.say : undefined
      finish(
        () => {
          if (transcript === null && (verdict.kind === 'none' || verdict.kind === 'notMine')) return this.notice(this.#words.missed)
          if (words) this.#show(heard, HEARD_MS)
          else this.#clear()
          this.#act(verdict, more ? () => void this.#decide(voice, audio, words) : undefined)
        },
        () => {
          if (done === undefined) spare()
          else this.notice(done)
          if (verdict.kind === 'handled' && showingsOf(this.#router).current === showing) this.redraw()
        },
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
    const showing = showingsOf(this.#router).current
    const under = drawn && drawn.showing === showing ? drawn.targets[(showing && this.#places.get(showing))?.cursor ?? 0] : undefined
    const selected = under && !under.private ? `${this.#words.selected}: ${under.say}` : ''
    return [current.context?.() ?? '', selected].filter(Boolean).join('\n').slice(-ITEM_LIMIT)
  }

  async #ask(
    voice: VoiceOptions,
    said: { words: string; audio: Audio; life: Lifetime },
    navigate: boolean,
    moved: () => boolean,
    mine: () => boolean,
  ): Promise<{ verdict: Verdict; more: boolean }> {
    const gone = () => said.life.ended || moved()
    const asking = (model: NavigatorModel): NavigatorModel => ({
      choose: (question, life) => {
        const choose = model.choose
        if (gone()) throw new LifetimeEnded()
        return Reflect.apply(choose, model, [question, life])
      },
    })
    const agents = [...(navigate ? [navigator(asking(voice.model ?? matchWords))] : []), ...(voice.agents ?? [])]
    for (const [index, agent] of agents.entries()) {
      if (gone()) throw new LifetimeEnded()
      const screen = this.#context()
      const heard = {
        ...said,
        actions: this.#reachable(),
        rolling: voice.rolling?.items() ?? [],
        hasNext: index < agents.length - 1,
        ...(voice.otherwise === undefined ? {} : { otherwise: voice.otherwise }),
        ...(screen ? { screen } : {}),
      }
      if (gone()) throw new LifetimeEnded()
      if (!(navigate && index === 0)) this.#handed = true
      const given = await agent(heard)
      if (!mine()) throw new LifetimeEnded()
      const verdict = once(given, mine, moved)
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
    const moves = this.#moves
    const showings = showingsOf(this.#router)
    const showing = showings.current
    const still = () => showings.current === showing && showings.onPath(showing)
    const instead = pass && this.#voice?.instead
    if (moves !== this.#moves || !still()) return
    const which = action<Pick | null>({
      id: 'earshot.which',
      say: this.#words.which,
      targets: () => [
        ...verdict.candidates.map((candidate, index) => ({ id: String(index), say: candidate.say, value: candidate })),
        ...(instead ? [{ id: INSTEAD, say: instead, value: null }] : []),
      ],
      run: candidate => (candidate ? this.#do(candidate.action, candidate.target, this.#said) : still() ? pass?.() : undefined),
    })
    this.#clear()
    this.#openOwn({ id: 'earshot.which', view: () => list({ title: this.#words.which, action: which }) })
  }

  #do(id: string, targetId: string | undefined, said: boolean, pass?: () => void): void {
    const moves = this.#moves
    const rolled = this.#voice?.rolling?.items().find(item => item.action.id === id && item.target === targetId)?.action
    const found = this.#reachable().find(a => a.id === id) ?? rolled
    if (moves !== this.#moves) return
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found, targetId, said, pass)
  }

  #jumps(chosen: Action, targetId?: string): boolean {
    if (this.#router.anywhere(chosen)) return true
    const rolled = this.#voice?.rolling?.items().some(item => item.action.id === chosen.id && item.target === targetId) ?? false
    return rolled && !this.#reachable().some(a => a.id === chosen.id)
  }

  #picked(item: number): void {
    const shown = this.#frames.menu
    const showing = showingsOf(this.#router).current
    if (!showingsOf(this.#router).onPath(showing) || (shown !== undefined && shown !== showing)) return
    const id = [...this.#items].find(([, number]) => number === item)?.[0]
    const folded = this.#drawn?.folded ?? []
    if (id === MORE && folded.length) {
      return this.#openOwn({ id: MORE, view: () => list({ title: this.#words.more, action: this.#chooser(folded) }) })
    }
    const moves = this.#moves
    const found = this.#router.actions().find(a => a.id === id)
    if (moves !== this.#moves) return
    if (!found) return this.notice(this.#words.unavailable)
    void this.#start(found)
  }

  async #start(chosen: Action, targetId?: string, said = false, pass?: () => void): Promise<void> {
    const moves = this.#moves
    const showings = showingsOf(this.#router)
    const showing = showings.current
    const why = chosen.blocked()
    if (why !== null) return this.notice(why)
    const targets = chosen.targets()
    if (moves !== this.#moves || !showings.onPath(showing)) return
    if (targets !== null && targetId === undefined) {
      if (chosen.choose) return chosen.choose()
      return this.#openOwn({ id: 'earshot.pick', view: () => list({ title: chosen.say, action: chosen }) })
    }
    const target = targets?.find(candidate => candidate.id === targetId)
    const risk = target?.risk ?? chosen.risk
    if (moves !== this.#moves) return
    if (risk === 'safe' || (risk === 'voice' && !said)) return this.#run(chosen, targetId, said)
    const still = () => showings.current === showing && showings.onPath(showing)
    const instead = pass && this.#voice?.instead
    if (moves !== this.#moves || !still()) return
    const asked = [
      `${chosen.say}${target ? `: ${target.say}` : ''}?`,
      this.#words.confirm,
      ...(instead ? [`${this.#words.swipe}: ${instead}`] : []),
    ]
    this.#show(asked.join('\n'))
    this.#asking = {
      yes: () => void (still() && this.#run(chosen, targetId)),
      ...(instead ? { no: () => void (still() && pass()) } : {}),
    }
  }

  // An action the shell made (choose, More, which one) starts another: it has to know the words chose it.
  async #run(chosen: Action, targetId?: string, said = false): Promise<void> {
    try {
      const moves = this.#moves
      const jumps = this.#jumps(chosen, targetId)
      if (moves !== this.#moves) return
      let left = false
      const still = () => (moves === this.#moves && !this.#life.ended) || ((left = true), false)
      const act = () => {
        const run = chosen.run
        const asking = unless(chosen, run)
        return asking ? asking(targetId, still) : Reflect.apply(run, chosen, [targetId])
      }
      this.#said = said
      const running = jumps ? this.#router.jumping(act) : act()
      this.#said = false
      const outcome = await this.#life.guard(running)
      if (left) return
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
