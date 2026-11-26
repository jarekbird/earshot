import {
  AudioInputSource,
  AudioSpeakerRole,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Sound, Speaker } from '../audio.js'
import type { Lifetime, Timer } from '../lifetime.js'
import { clipBytes, linesOf, type Box, type Brightness, type Frame, type MenuItem, type Picture } from './frame.js'
import type { Sent } from './frames.js'
import { decode, type GlassesEvent, type Input } from './input.js'
import { serve } from '../serve.js'
import { HOLD, Mic, MIC_SILENT_MS, retryDelay, type Held, type ListenOptions } from './mic.js'

export { MIC_SILENT_MS }
export type { ListenOptions }
import {
  LINE_HEIGHT,
  MAX_BRIGHTNESS,
  MAX_IMAGE_BOXES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  MAX_MENU_ITEMS,
  MAX_MENU_NAME_BYTES,
  MAX_NAME_CHARS,
  MAX_TEXT_BOXES,
  MIN_IMAGE_SIDE,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from './limits.js'
import { cleanText, fitText, textWidth, wrapText } from './text.js'

export type GlassesBridge = Pick<
  EvenAppBridge,
  | 'createStartUpPageContainer'
  | 'rebuildPageContainer'
  | 'textContainerUpgrade'
  | 'updateImageRawData'
  | 'onEvenHubEvent'
  | 'shutDownPageContainer'
  | 'audioControl'
>

export type DrawOp = 'create' | 'rebuild' | 'update' | 'picture'

export type Drawing =
  | { at: 'ask'; frame: number; page: Frame }
  | { at: 'wait'; frame: number; inMs?: number }
  | { at: 'begin'; frame: number; rebuild: boolean }
  | { at: 'call'; frame: number; op: DrawOp; box?: string }
  | { at: 'answer'; frame: number; op: DrawOp; box?: string; boxes: number; ms: number; ok: boolean; got: unknown }
  | { at: 'retry'; frame: number; failures: number; inMs: number }
  | { at: 'end'; frame: number; drawn: boolean }

export interface GlassesOptions {
  now?: () => number
  trace?: boolean | ((line: string) => void)
  watch?: (drawing: Drawing) => void
}

export const FRAME_TAG = '[earshot frame]'
export const INPUT_TAG = '[earshot input]'
export const REBUILD_GAP_MS = 300
export const OVERLAY_DIM: Brightness = 1
const OVERLAY_LINES = 3
const SCREEN_LINES = Math.floor(SCREEN_HEIGHT / LINE_HEIGHT)
const APP_BOXES = MAX_TEXT_BOXES - 1
const ASK_THE_USER = 1
const INPUT = 1
const FIRST_PICTURE = MAX_TEXT_BOXES + 1
const INPUT_ORDER = 1
const PICTURE_ORDER = INPUT_ORDER + 1
const BOX_ORDER = PICTURE_ORDER + MAX_IMAGE_BOXES - 2
// The firmware animates a bounce on the box that takes the swipes, so that box holds no text of the page's.
const INPUT_BOX: Box = { id: 'input', x: 0, y: 0, w: SCREEN_WIDTH, h: SCREEN_HEIGHT, text: ' ' }

interface Placed {
  id: number
  name: string
  box: Box
  text: string
  brightness: Brightness
}

const SPEAKERS = new Map<unknown, Speaker>([
  [AudioSpeakerRole.Self, 'self'],
  [AudioSpeakerRole.Other, 'other'],
])

interface Hung {
  id: number
  name: string
  picture: Picture
}

interface Page {
  frame: number
  from: Frame
  left: boolean
  boxes: Placed[]
  pictures: Hung[]
  menu: MenuItem[]
  over: string | null
}

export const OVERLAY = Symbol('the overlay the glasses are known to show')
export const WHOLE = Symbol('whether the glasses show one whole frame, none partly sent since')

const layoutOf = ({ boxes, pictures }: Pick<Page, 'boxes' | 'pictures'>) =>
  JSON.stringify([
    boxes.map(({ box }) => [box.id, box.x, box.y, box.w, box.h]),
    pictures.map(({ picture }) => [picture.id, picture.x, picture.y, picture.w, picture.h]),
  ])

const shapeOf = (page: Page) => JSON.stringify([layoutOf(page), page.menu.map(item => [item.id, item.name])])

const fits = ({ w, h }: Picture) => w >= MIN_IMAGE_SIDE && w <= MAX_IMAGE_WIDTH && h >= MIN_IMAGE_SIDE && h <= MAX_IMAGE_HEIGHT

const CARD = { left: ' ', across: '─', side: '│', top: ['╭', '╮'], bottom: ['╰', '╯'], gap: '  ' }
const CARD_ACROSS = Math.floor((SCREEN_WIDTH - textWidth(CARD.left)) / textWidth(CARD.across)) - 2
const CARD_RIGHT = textWidth(CARD.left + CARD.top[0] + CARD.across.repeat(CARD_ACROSS))
const CARD_INSIDE = CARD_RIGHT - textWidth(CARD.left + CARD.side + CARD.gap + CARD.gap)

const edge = ([start, end]: string[]) => CARD.left + start + CARD.across.repeat(CARD_ACROSS) + end

function inCard(line: string): string {
  const start = CARD.left + CARD.side + CARD.gap + line
  const spaces = Math.max(1, Math.round((CARD_RIGHT - textWidth(start)) / textWidth(' ')))
  return start + ' '.repeat(spaces) + CARD.side
}

function overlayCard(text: string): string[] {
  const lines = wrapText(cleanText(text).trim(), CARD_INSIDE)
  const shown = lines.slice(0, OVERLAY_LINES)
  if (lines.length > OVERLAY_LINES) shown[OVERLAY_LINES - 1] = fitText(`${shown[OVERLAY_LINES - 1]} …`, CARD_INSIDE)
  return [edge(CARD.top), ...shown.map(inCard), edge(CARD.bottom)]
}

export const overlayWords = (text: string): string =>
  text
    .split('\n')
    .filter(row => row.startsWith(CARD.left + CARD.side))
    .map(row => row.slice((CARD.left + CARD.side).length, -CARD.side.length).trim())
    .join('\n')

function above(box: Box, top: number): string {
  if (box.y + box.h <= top) return clipBytes(box.text)
  const rows = Math.floor((top - box.y) / LINE_HEIGHT)
  const kept = rows > 0 ? wrapText(cleanText(box.text), box.w).slice(0, rows).join('\n') : ''
  return kept.trim() ? clipBytes(kept) : ' '
}

const stateOf = ({ text, brightness }: Placed) => `${brightness}\n${text}`

interface Kept {
  under: Box
  taken: Box
  frame: number
}

const kept = ({ box, text, brightness }: Placed, frame: number): Kept => ({
  under: box,
  taken: { id: box.id, x: box.x, y: box.y, w: box.w, h: box.h, text, brightness },
  frame,
})

export const plainFrame = (frame: Frame): Frame => ({
  boxes: frame.boxes.map(({ id, x, y, w, h, text, brightness }) => ({
    id,
    x,
    y,
    w,
    h,
    text,
    ...(brightness === undefined ? {} : { brightness }),
  })),
  ...(frame.pictures ? { pictures: frame.pictures.map(({ id, x, y, w, h, key, data }) => ({ id, x, y, w, h, key, data })) } : {}),
  ...(frame.menu ? { menu: frame.menu.map(({ id, name }) => ({ id, name })) } : {}),
})

const pictureBox = ({ id, name, picture }: Hung, index: number) =>
  new ImageContainerProperty({
    xPosition: picture.x,
    yPosition: picture.y,
    width: picture.w,
    height: picture.h,
    containerID: id,
    containerName: name,
    zOrderIndex: PICTURE_ORDER + index,
  })

const textBox = ({ id, name, box, text, brightness }: Placed) =>
  new TextContainerProperty({
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    containerID: id,
    containerName: name,
    content: text,
    textColor: brightness,
    isEventCapture: id === INPUT ? 1 : 0,
    paddingLength: 0,
    borderWidth: 0,
    zOrderIndex: id === INPUT ? INPUT_ORDER : BOX_ORDER + id,
  })

const PROGRESS = new WeakMap<Glasses, Sent>()

export const progressOf = (glasses: Glasses): Sent => PROGRESS.get(glasses) as Sent

export class Glasses {
  readonly #life: Lifetime
  readonly #bridge: GlassesBridge
  readonly #now: () => number
  readonly #trace: ((line: string) => void) | undefined
  readonly #watch: (drawing: Drawing) => void
  #frames = 0
  readonly #listeners = new Set<{ hear: (input: Input) => void }>()
  readonly #mic: Mic
  #frame: Frame = { boxes: [] }
  #number = 0
  #whole = 0
  readonly #have: { boxes: Kept[]; pictures: Picture[]; hung: Set<number>; menu: MenuItem[] } = {
    boxes: [],
    pictures: [],
    hung: new Set(),
    menu: [],
  }
  #left = false
  #going: { number: number; frame: Frame; left: boolean } | null = null
  readonly #dropped = new Set<number>()
  #overlay: string | null = null
  #wanted: Page | null = null
  #shape = ''
  #layout = ''
  #holds = 0
  #sent = new Map<number, string>()
  #hung = new Map<number, string>()
  #created = false
  #drawing = false
  #failures = 0
  #rebuildAt = 0
  #retry: Timer | undefined
  #retryAt = 0
  #traced = ''
  readonly #progress = { shown: 0, menu: 0, sending: 0 }
  readonly #from = new Map<string, number>()
  readonly #following = new Set<() => void>()
  #intact = true
  #over: string | null | undefined = null

  constructor(parent: Lifetime, bridge: GlassesBridge, options: GlassesOptions = {}) {
    this.#life = parent.child()
    PROGRESS.set(this, this.#telling())
    this.#bridge = bridge
    this.#now = options.now ?? Date.now
    this.#trace = options.trace === true ? line => console.info(line) : options.trace || undefined
    this.#watch = options.watch ?? (() => {})
    this.#life.own(bridge.onEvenHubEvent(event => this.#hear(event)))
    this.#life.own(() => {
      this.#progress.sending = 0
      this.#going = null
      this.#whole = 0
      Object.assign(this.#have, { boxes: [], pictures: [], hung: new Set(), menu: [] })
      this.#frame = { boxes: [] }
      this.#wanted = null
    })
    const open = () => {
      const opening = bridge.audioControl(true, AudioInputSource.Glasses)
      this.holdRebuilds(opening)
      return opening
    }
    this.#mic = new Mic(this.#life, { open, close: () => bridge.audioControl(false) }, this.#now)
  }

  get shown(): number {
    return this.#progress.shown
  }

  #telling(): Sent {
    const progress = this.#progress
    return {
      get shown() {
        return progress.shown
      },
      get menu() {
        return progress.menu
      },
      get sending() {
        return progress.sending
      },
      card: () => this.#overlay,
      has: box => this.#from.get(box) ?? 0,
      onChange: told => {
        this.#following.add(told)
        return () => void this.#following.delete(told)
      },
      drop: frames => {
        const sendable = (frame: number) => frame === this.#number || frame === this.#going?.number || frame === this.#wanted?.frame
        for (const dropped of this.#dropped) if (!sendable(dropped)) this.#dropped.delete(dropped)
        for (const frame of frames) if (frame > this.#whole && sendable(frame)) this.#dropped.add(frame)
        if (!this.#dropped.has(this.#number)) return
        const going = this.#going && !this.#dropped.has(this.#going.number) ? this.#going : null
        this.#left = going ? going.left : !this.#intact
        this.#frame = going ? going.frame : this.#kept()
        this.#number = going ? going.number : this.#whole
        if (this.#created || this.#overlay !== null) this.#place()
        else this.#wanted = null
      },
    }
  }

  get [OVERLAY](): string | null | undefined {
    return this.#over
  }

  get [WHOLE](): boolean {
    return this.#intact
  }

  get micOpen(): boolean {
    return this.#mic.open
  }

  listen(hear: (sound: Sound) => unknown, options?: ListenOptions): () => Promise<boolean> {
    return this.#mic.listen(hear, options)
  }

  [HOLD](hear: (sound: Sound) => unknown, refused: () => void): Held {
    return this.#mic.hold(hear, refused)
  }

  onMic(listener: (open: boolean) => unknown): () => void {
    return this.#mic.onChange(listener)
  }

  get micLeftOn(): boolean {
    return this.#mic.leftOn
  }

  onMicLeftOn(listener: (leftOn: boolean) => unknown): () => void {
    return this.#mic.onLeftOn(listener)
  }

  // The Even app answers one call at a time, so a rebuild on its way holds back whatever is asked after it.
  holdRebuilds(until: PromiseLike<unknown>): void {
    this.#holds++
    const over = () => {
      this.#holds--
      void this.#run()
    }
    Promise.resolve(until).then(over, over)
  }

  draw(frame: Frame): number {
    const boxes = frame.boxes.length - APP_BOXES
    if (boxes > 0) console.error(`Earshot: the glasses take ${APP_BOXES} boxes from an app. The last ${boxes} of this frame are left out.`)
    const items = (frame.menu?.length ?? 0) - MAX_MENU_ITEMS
    if (items > 0) console.error(`Earshot: Even's menu takes ${MAX_MENU_ITEMS} items. The last ${items} of this frame are left out.`)
    for (const picture of frame.pictures ?? []) {
      if (!fits(picture)) {
        console.error(
          `Earshot: the glasses take a picture from ${MIN_IMAGE_SIDE} to ${MAX_IMAGE_WIDTH} wide and ${MAX_IMAGE_HEIGHT} high. "${picture.id}" is left out.`,
        )
      }
    }
    const pictures = (frame.pictures ?? []).filter(fits).length - MAX_IMAGE_BOXES
    if (pictures > 0)
      console.error(`Earshot: the glasses take ${MAX_IMAGE_BOXES} pictures. The last ${pictures} of this frame are left out.`)
    const asked = plainFrame(frame)
    const number = ++this.#frames
    this.#frame = asked
    this.#number = number
    this.#left = false
    this.#watch({ at: 'ask', frame: number, page: frame })
    if (number === this.#number) this.#place()
    return number
  }

  overlay(text: string | null): void {
    if (text === this.#overlay) return
    this.#overlay = text
    this.#place()
  }

  #kept(): Frame {
    const { boxes, pictures, menu } = this.#have
    return { boxes: boxes.map(({ under, taken, frame }) => (frame <= this.#whole ? under : taken)), pictures, menu }
  }

  #landed(): void {
    if (!this.#left) return
    this.#frame = this.#kept()
    this.#place()
  }

  #place(): void {
    const over = this.#overlay === null ? null : overlayCard(this.#overlay)
    const top = (SCREEN_LINES - (over?.length ?? 0)) * LINE_HEIGHT
    const boxes: Placed[] = [
      {
        id: INPUT,
        name: INPUT_BOX.id,
        box: INPUT_BOX,
        text: over === null ? INPUT_BOX.text : '\n'.repeat(SCREEN_LINES - over.length) + over.join('\n'),
        brightness: MAX_BRIGHTNESS,
      },
      ...this.#frame.boxes.slice(0, APP_BOXES).map((box, index) => ({
        id: index + 2,
        name: box.id.slice(0, MAX_NAME_CHARS),
        box,
        text: over === null ? clipBytes(box.text) : above(box, top),
        brightness:
          over === null ? (box.brightness ?? MAX_BRIGHTNESS) : (Math.min(box.brightness ?? MAX_BRIGHTNESS, OVERLAY_DIM) as Brightness),
      })),
    ]
    const menu = (this.#frame.menu ?? [])
      .slice(0, MAX_MENU_ITEMS)
      .map(({ id, name }) => ({ id, name: clipBytes(name, MAX_MENU_NAME_BYTES) }))
    const pictures = (this.#frame.pictures ?? [])
      .filter(fits)
      .slice(0, MAX_IMAGE_BOXES)
      .map((picture, index) => ({ id: FIRST_PICTURE + index, name: picture.id.slice(0, MAX_NAME_CHARS), picture }))
    this.#wanted = { frame: this.#number, from: this.#frame, left: this.#left, boxes, pictures, menu, over: this.#overlay }
    void this.#run()
  }

  onInput(listener: (input: Input) => void): () => void {
    const placed = { hear: listener }
    this.#listeners.add(placed)
    return () => void this.#listeners.delete(placed)
  }

  async leave(): Promise<void> {
    await this.#bridge.shutDownPageContainer(ASK_THE_USER)
  }

  #hear(event: GlassesEvent): void {
    const audio = event.audioEvent
    if (audio?.audioPcm) {
      const pcm = audio.audioPcm instanceof Uint8Array ? audio.audioPcm : new Uint8Array(audio.audioPcm)
      this.#mic.heard({ pcm, speaker: SPEAKERS.get(audio.speakerRole) ?? 'unknown' })
    }
    const input = decode(event)
    if (!input) return
    const inPlace = [...this.#listeners]
    serve(() => this.#trace?.(`${INPUT_TAG} ${JSON.stringify(input)}`), 'touchpad')
    for (const placed of inPlace) if (this.#listeners.has(placed)) serve(() => placed.hear(input), 'touchpad')
    if (input.kind === 'exit') this.#life.end()
  }

  async #run(): Promise<void> {
    if (this.#drawing) return
    if (this.#retry) {
      await Promise.resolve()
      if (this.#retry && this.#wanted) this.#watch({ at: 'wait', frame: this.#wanted.frame, inMs: this.#retryAt - this.#now() })
      return
    }
    this.#drawing = true
    try {
      await Promise.resolve()
      while (this.#wanted && !this.#life.ended) {
        const page = this.#wanted
        const shape = shapeOf(page)
        const rebuild = shape !== this.#shape
        const wait = rebuild ? this.#rebuildAt - this.#now() : 0
        if (wait > 0) {
          this.#watch({ at: 'wait', frame: page.frame, inMs: wait })
          return this.#later(wait)
        }
        const { frame } = page
        if (rebuild && this.#holds > 0) {
          const inPlace = this.#created && layoutOf(page) === this.#layout
          if (inPlace) {
            this.#going = { number: frame, frame: page.from, left: page.left }
            this.#progressed({ sending: frame })
          }
          this.#watch({ at: 'wait', frame })
          if (inPlace) {
            this.#watch({ at: 'begin', frame, rebuild: false })
            await this.#update(page)
            this.#going = null
            if (this.#life.ended) return this.#cut(frame)
            this.#progressed({ sending: 0 })
            this.#watch({ at: 'end', frame, drawn: false })
          }
          if (this.#holds > 0 && this.#wanted === page) return
          continue
        }
        this.#going = { number: frame, frame: page.from, left: page.left }
        this.#progressed({ sending: frame })
        this.#watch({ at: 'begin', frame, rebuild })
        const written = rebuild ? await this.#build(page, shape) : await this.#update(page, true)
        if (written && !rebuild && !page.left && !this.#life.ended && this.#progress.menu !== frame) this.#progressed({ menu: frame })
        const drawn = written && !this.#takenBack(frame) && (await this.#hang(page)) && !this.#takenBack(frame)
        if (this.#life.ended) return this.#cut(frame)
        this.#going = null
        if (drawn) {
          this.#whole = frame
          for (const dropped of this.#dropped) if (dropped <= frame) this.#dropped.delete(dropped)
        }
        if (!drawn && this.#takenBack(frame)) {
          if (this.#wanted === page) this.#wanted = null
          this.#progressed({ sending: 0 })
          this.#watch({ at: 'end', frame, drawn })
          continue
        }
        if (drawn) this.#over = page.over
        if (drawn && !page.left) this.#intact = true
        this.#progressed(drawn && !page.left ? { shown: frame, menu: frame, sending: 0 } : { sending: 0 })
        if (!drawn) {
          const inMs = retryDelay(++this.#failures)
          this.#watch({ at: 'retry', frame, failures: this.#failures, inMs })
          this.#watch({ at: 'end', frame, drawn })
          return this.#later(inMs)
        }
        this.#watch({ at: 'end', frame, drawn })
        this.#failures = 0
        if (this.#wanted === page) this.#wanted = null
        this.#report(page)
      }
    } finally {
      this.#drawing = false
    }
  }

  #cut(frame: number): void {
    this.#progress.sending = 0
    this.#watch({ at: 'end', frame, drawn: false })
  }

  #progressed(now: Partial<{ shown: number; menu: number; sending: number }>): void {
    Object.assign(this.#progress, now)
    for (const told of [...this.#following]) if (this.#following.has(told)) serve(told)
  }

  #takenBack(frame: number): boolean {
    return this.#dropped.has(frame)
  }

  #later(ms: number): void {
    if (!this.#retry) this.#retryAt = this.#now() + ms
    this.#retry ??= this.#life.timeout(() => {
      this.#retry = undefined
      void this.#run()
    }, ms)
  }

  async #ask<T>(
    frame: number,
    op: DrawOp,
    boxes: number,
    call: () => Promise<T>,
    accepted: T,
    box?: string,
    taken?: () => void,
  ): Promise<boolean> {
    if (this.#life.ended || this.#takenBack(frame)) return false
    const named = box === undefined ? {} : { box }
    const started = this.#now()
    this.#watch({ at: 'call', frame, op, ...named })
    if (this.#life.ended || this.#takenBack(frame)) {
      this.#watch({ at: 'answer', frame, op, ...named, boxes, ms: 0, ok: false, got: undefined })
      return false
    }
    this.#intact = false
    let got: unknown
    try {
      got = await call()
    } catch (error) {
      got = error
    }
    const ok = got === accepted
    if (ok && !this.#life.ended) taken?.()
    this.#watch({ at: 'answer', frame, op, ...named, boxes, ms: this.#now() - started, ok, got })
    return ok
  }

  async #build({ frame, left, boxes, pictures, menu, over }: Page, shape: string): Promise<boolean> {
    const menuItems = menu.map(({ id, name }) => new MenuItemProperty({ itemID: id, itemName: name }))
    const page = {
      containerTotalNum: boxes.length + pictures.length,
      textObject: boxes.map(textBox),
      ...(pictures.length ? { imageObject: pictures.map(pictureBox) } : {}),
      ...(menuItems.length ? { menuObject: new MenuContainerProperty({ menuItems }) } : {}),
    }
    const create = () => this.#bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
    const rebuild = () => this.#bridge.rebuildPageContainer(new RebuildPageContainer(page))
    const shown = boxes.length - 1
    let made = false
    const built = () => {
      this.#created = true
      this.#shape = shape
      this.#layout = layoutOf({ boxes, pictures })
      this.#sent = new Map(boxes.map(box => [box.id, stateOf(box)]))
      this.#hung = new Map()
      this.#rebuildAt = this.#now() + REBUILD_GAP_MS
      if (left) return
      Object.assign(this.#have, {
        boxes: boxes.slice(1).map(box => kept(box, frame)),
        pictures: pictures.map(({ picture }) => picture),
        hung: new Set(),
        menu,
      })
      this.#from.clear()
      for (const box of boxes) this.#from.set(box.name, frame)
      this.#progressed({ menu: frame })
      this.#landed()
    }
    const asked =
      <T>(call: () => Promise<T>) =>
      () => {
        made = true
        if (over !== this.#over) this.#over = undefined
        return call()
      }
    let drawn =
      !this.#created && (await this.#ask(frame, 'create', shown, asked(create), StartUpPageCreateResult.success, undefined, built))
    // A reloaded web view already owns a page, so a create is refused and a rebuild takes it over.
    if (!drawn && !this.#life.ended) drawn = await this.#ask(frame, 'rebuild', shown, asked(rebuild), true, undefined, built)
    if (!drawn && made) {
      this.#sent.clear()
      this.#shape = ''
      this.#layout = ''
    }
    return drawn && !this.#life.ended
  }

  async #update({ frame, left, boxes, over }: Page, whole = false): Promise<boolean> {
    let drawn = true
    for (const [index, box] of boxes.entries()) {
      const noted = () => {
        this.#from.set(box.name, frame)
        if (index > 0) this.#have.boxes[index - 1] = kept(box, frame)
      }
      if (this.#sent.get(box.id) === stateOf(box)) {
        if (!left && !this.#takenBack(frame)) noted()
        continue
      }
      const upgrade = new TextContainerUpgrade({
        containerID: box.id,
        containerName: box.name,
        content: box.text,
        textColor: box.brightness,
      })
      const taken = () => {
        this.#sent.set(box.id, stateOf(box))
        if (left) return
        noted()
        this.#progressed(whole && boxes.every(other => this.#sent.get(other.id) === stateOf(other)) ? { menu: frame } : {})
        this.#landed()
      }
      let made = false
      const write = () => {
        made = true
        if (over !== this.#over) this.#over = undefined
        return this.#bridge.textContainerUpgrade(upgrade)
      }
      const accepted = await this.#ask(frame, 'update', 1, write, true, box.name, taken)
      if (this.#life.ended) return false
      if (!accepted) {
        if (made) this.#sent.delete(box.id)
        drawn = false
      }
    }
    return drawn
  }

  async #hang({ frame, left, pictures }: Page): Promise<boolean> {
    let drawn = true
    for (const [index, { id, name, picture }] of pictures.entries()) {
      if (this.#hung.get(id) === picture.key || (left && !this.#have.hung.has(id))) continue
      const update = new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: picture.data })
      let made = false
      const send = () => {
        made = true
        return this.#bridge.updateImageRawData(update)
      }
      const accepted = await this.#ask(frame, 'picture', 1, send, ImageRawDataUpdateResult.success, name)
      if (this.#life.ended) return false
      if (!accepted) {
        if (made) this.#hung.delete(id)
        drawn = false
      } else {
        this.#hung.set(id, picture.key)
        if (!left) {
          this.#have.pictures[index] = picture
          this.#have.hung.add(id)
          this.#landed()
        }
      }
    }
    return drawn
  }

  #report({ boxes, menu }: Page): void {
    if (!this.#trace) return
    const lines = linesOf(boxes.map(({ box, text }) => ({ x: box.x, y: box.y, text })))
    const line = `${FRAME_TAG} ${JSON.stringify({ lines, menu: menu.map(item => item.name) })}`
    if (line === this.#traced) return
    this.#traced = line
    this.#trace(line)
  }
}
