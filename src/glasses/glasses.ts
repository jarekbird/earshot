import {
  AudioInputSource,
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
import type { Lifetime, Timer } from '../lifetime.js'
import { clipBytes, linesOf, type Box, type Brightness, type Frame, type MenuItem, type Picture } from './frame.js'
import { decode, type GlassesEvent, type Input } from './input.js'
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
import { cleanText, fitText, wrapText } from './text.js'

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

export interface GlassesOptions {
  now?: () => number
  trace?: boolean | ((line: string) => void)
}

export const FRAME_TAG = '[earshot frame]'
export const INPUT_TAG = '[earshot input]'
export const REBUILD_GAP_MS = 300
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 4_000
export const OVERLAY_DIM: Brightness = 1
const OVERLAY_LINES = 3
const APP_BOXES = MAX_TEXT_BOXES - 2
const ASK_THE_USER = 1
const FRONT = MAX_TEXT_BOXES
const FIRST_PICTURE = FRONT + 1
const INPUT_ORDER = 1
const PICTURE_ORDER = INPUT_ORDER + 1
const BOX_ORDER = PICTURE_ORDER + MAX_IMAGE_BOXES - 2
const FRONT_BOX: Box = {
  id: 'front',
  x: 0,
  y: SCREEN_HEIGHT - OVERLAY_LINES * LINE_HEIGHT,
  w: SCREEN_WIDTH,
  h: OVERLAY_LINES * LINE_HEIGHT,
  text: ' ',
}

interface Placed {
  id: number
  name: string
  box: Box
  text: string
  brightness: Brightness
}

const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))

interface Hung {
  id: number
  name: string
  picture: Picture
}

interface Page {
  boxes: Placed[]
  pictures: Hung[]
  menu: MenuItem[]
}

const shapeOf = ({ boxes, pictures, menu }: Page) =>
  JSON.stringify([
    boxes.map(({ box }) => [box.id, box.x, box.y, box.w, box.h]),
    menu.map(item => [item.id, item.name]),
    pictures.map(({ picture }) => [picture.id, picture.x, picture.y, picture.w, picture.h]),
  ])

const fits = ({ w, h }: Picture) => w >= MIN_IMAGE_SIDE && w <= MAX_IMAGE_WIDTH && h >= MIN_IMAGE_SIDE && h <= MAX_IMAGE_HEIGHT

function overlayText(text: string): string {
  const lines = wrapText(cleanText(text).trim(), SCREEN_WIDTH)
  const shown = lines.slice(0, OVERLAY_LINES)
  if (lines.length > OVERLAY_LINES) shown[OVERLAY_LINES - 1] = fitText(`${shown[OVERLAY_LINES - 1]} …`, SCREEN_WIDTH)
  return '\n'.repeat(OVERLAY_LINES - shown.length) + shown.join('\n')
}

const stateOf = ({ text, brightness }: Placed) => `${brightness}\n${text}`

const attempt = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await call()
  } catch {
    return undefined
  }
}

// The firmware animates a bounce on the box that takes the swipes, so that box stays empty.
const inputBox = () =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    containerID: 1,
    containerName: 'input',
    content: ' ',
    isEventCapture: 1,
    paddingLength: 0,
    borderWidth: 0,
    zOrderIndex: INPUT_ORDER,
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
    isEventCapture: 0,
    paddingLength: 0,
    borderWidth: 0,
    zOrderIndex: BOX_ORDER + id,
  })

export class Glasses {
  readonly #life: Lifetime
  readonly #bridge: GlassesBridge
  readonly #now: () => number
  readonly #trace: ((line: string) => void) | undefined
  readonly #listeners = new Set<(input: Input) => void>()
  readonly #ears = new Set<(pcm: Uint8Array) => void>()
  #micOpen = false
  #frame: Frame = { boxes: [] }
  #overlay: string | null = null
  #wanted: Page | null = null
  #shape = ''
  #sent = new Map<number, string>()
  #hung = new Map<number, string>()
  #created = false
  #drawing = false
  #failures = 0
  #rebuildAt = 0
  #retry: Timer | undefined
  #traced = ''

  constructor(parent: Lifetime, bridge: GlassesBridge, options: GlassesOptions = {}) {
    this.#life = parent.child()
    this.#bridge = bridge
    this.#now = options.now ?? Date.now
    this.#trace = options.trace === true ? line => console.info(line) : options.trace || undefined
    this.#life.own(bridge.onEvenHubEvent(event => this.#hear(event)))
    this.#life.own(() => void this.closeMic())
  }

  async openMic(): Promise<boolean> {
    if (this.#life.ended) return false
    this.#micOpen = (await attempt(() => this.#bridge.audioControl(true, AudioInputSource.Glasses))) === true
    return this.#micOpen
  }

  async closeMic(): Promise<void> {
    if (!this.#micOpen) return
    this.#micOpen = false
    await attempt(() => this.#bridge.audioControl(false))
  }

  onAudio(listener: (pcm: Uint8Array) => void): () => void {
    this.#ears.add(listener)
    return () => void this.#ears.delete(listener)
  }

  draw(frame: Frame): void {
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
    this.#frame = frame
    this.#place()
  }

  overlay(text: string | null): void {
    this.#overlay = text
    this.#place()
  }

  #place(): void {
    const over = this.#overlay
    const boxes: Placed[] = this.#frame.boxes.slice(0, APP_BOXES).map((box, index) => ({
      id: index + 2,
      name: box.id.slice(0, MAX_NAME_CHARS),
      box,
      text: clipBytes(box.text),
      brightness:
        over === null ? (box.brightness ?? MAX_BRIGHTNESS) : (Math.min(box.brightness ?? MAX_BRIGHTNESS, OVERLAY_DIM) as Brightness),
    }))
    boxes.push({
      id: FRONT,
      name: FRONT_BOX.id,
      box: FRONT_BOX,
      text: over === null ? FRONT_BOX.text : overlayText(over),
      brightness: MAX_BRIGHTNESS,
    })
    const menu = (this.#frame.menu ?? [])
      .slice(0, MAX_MENU_ITEMS)
      .map(({ id, name }) => ({ id, name: clipBytes(name, MAX_MENU_NAME_BYTES) }))
    const pictures = (this.#frame.pictures ?? [])
      .filter(fits)
      .slice(0, MAX_IMAGE_BOXES)
      .map((picture, index) => ({ id: FIRST_PICTURE + index, name: picture.id.slice(0, MAX_NAME_CHARS), picture }))
    this.#wanted = { boxes, pictures, menu }
    void this.#run()
  }

  onInput(listener: (input: Input) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async leave(): Promise<void> {
    await this.#bridge.shutDownPageContainer(ASK_THE_USER)
  }

  #hear(event: GlassesEvent): void {
    const sound = event.audioEvent?.audioPcm
    if (sound) for (const ear of [...this.#ears]) ear(sound instanceof Uint8Array ? sound : new Uint8Array(sound))
    const input = decode(event)
    if (!input) return
    this.#trace?.(`${INPUT_TAG} ${JSON.stringify(input)}`)
    for (const listener of [...this.#listeners]) listener(input)
    if (input.kind === 'exit') this.#life.end()
  }

  async #run(): Promise<void> {
    if (this.#drawing || this.#retry) return
    this.#drawing = true
    try {
      await Promise.resolve()
      while (this.#wanted && !this.#life.ended) {
        const page = this.#wanted
        const shape = shapeOf(page)
        const rebuild = shape !== this.#shape
        const wait = rebuild ? this.#rebuildAt - this.#now() : 0
        if (wait > 0) return this.#later(wait)
        const drawn = (rebuild ? await this.#build(page, shape) : await this.#update(page.boxes)) && (await this.#hang(page.pictures))
        if (this.#life.ended) return
        if (!drawn) return this.#later(retryDelay(++this.#failures))
        this.#failures = 0
        if (this.#wanted === page) this.#wanted = null
        this.#report(page)
      }
    } finally {
      this.#drawing = false
    }
  }

  #later(ms: number): void {
    this.#retry ??= this.#life.timeout(() => {
      this.#retry = undefined
      void this.#run()
    }, ms)
  }

  async #build({ boxes, pictures, menu }: Page, shape: string): Promise<boolean> {
    const menuItems = menu.map(({ id, name }) => new MenuItemProperty({ itemID: id, itemName: name }))
    const page = {
      containerTotalNum: boxes.length + pictures.length + 1,
      textObject: [inputBox(), ...boxes.map(textBox)],
      ...(pictures.length ? { imageObject: pictures.map(pictureBox) } : {}),
      ...(menuItems.length ? { menuObject: new MenuContainerProperty({ menuItems }) } : {}),
    }
    const create = () => this.#bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
    const rebuild = () => this.#bridge.rebuildPageContainer(new RebuildPageContainer(page))
    let drawn = !this.#created && (await attempt(create)) === StartUpPageCreateResult.success
    // A reloaded web view already owns a page, so a create is refused and a rebuild takes it over.
    if (!drawn && !this.#life.ended) drawn = (await attempt(rebuild)) === true
    if (!drawn) return false
    this.#created = true
    this.#shape = shape
    this.#sent = new Map(boxes.map(box => [box.id, stateOf(box)]))
    this.#hung = new Map()
    this.#rebuildAt = this.#now() + REBUILD_GAP_MS
    return true
  }

  async #update(placed: Placed[]): Promise<boolean> {
    let drawn = true
    for (const box of placed) {
      if (this.#sent.get(box.id) === stateOf(box)) continue
      const upgrade = new TextContainerUpgrade({
        containerID: box.id,
        containerName: box.name,
        content: box.text,
        textColor: box.brightness,
      })
      const accepted = (await attempt(() => this.#bridge.textContainerUpgrade(upgrade))) === true
      if (this.#life.ended) return false
      if (accepted) this.#sent.set(box.id, stateOf(box))
      else drawn = false
    }
    return drawn
  }

  async #hang(pictures: Hung[]): Promise<boolean> {
    let drawn = true
    for (const { id, name, picture } of pictures) {
      if (this.#hung.get(id) === picture.key) continue
      const update = new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: picture.data })
      const accepted = (await attempt(() => this.#bridge.updateImageRawData(update))) === ImageRawDataUpdateResult.success
      if (this.#life.ended) return false
      if (accepted) this.#hung.set(id, picture.key)
      else drawn = false
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
