import { ImageRawDataUpdateResult, validateEvenHubPageContainer, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { byteLength, linesOf, type Brightness, type MenuItem } from './frame.js'
import { overlayWords } from './glasses.js'
export { overlayWords }
import type { GlassesEvent, HoldSource } from './input.js'
import { MAX_BOXES, MAX_BRIGHTNESS, MAX_TEXT_BOXES, MAX_TEXT_BYTES } from './limits.js'

export type FakeOp = 'create' | 'rebuild' | 'update' | 'picture' | 'mic'

export interface FakeBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  text: string
  brightness: Brightness
  capture: boolean
  order: number
}

export interface FakePicture {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  data: number[]
  order: number
}

type Page = Parameters<EvenAppBridge['rebuildPageContainer']>[0]
type Bridge = Pick<
  EvenAppBridge,
  | 'createStartUpPageContainer'
  | 'rebuildPageContainer'
  | 'textContainerUpgrade'
  | 'updateImageRawData'
  | 'onEvenHubEvent'
  | 'shutDownPageContainer'
  | 'audioControl'
>

const SOURCES: Record<HoldSource, number | undefined> = { right: 1, ring: 2, left: 3, unknown: undefined }

export function fakeBridge(options: { owned?: boolean } = {}) {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  const refusals: Record<FakeOp, { times: number; throws: boolean }> = {
    create: { times: 0, throws: false },
    rebuild: { times: 0, throws: false },
    update: { times: 0, throws: false },
    picture: { times: 0, throws: false },
    mic: { times: 0, throws: false },
  }
  let page: FakeBox[] | null = null
  let pictures: FakePicture[] = []
  let menu: MenuItem[] = []
  let owned = options.owned ?? false

  const refused = (op: FakeOp): boolean => {
    const refusal = refusals[op]
    if (refusal.times <= 0) return false
    refusal.times--
    if (refusal.throws) throw new Error(`The fake bridge threw on ${op}.`)
    return true
  }

  const read = (container: Page): FakeBox[] | null => {
    const texts = container.textObject ?? []
    const count = texts.length + (container.listObject?.length ?? 0) + (container.imageObject?.length ?? 0)
    if (texts.length > MAX_TEXT_BOXES || count > MAX_BOXES || !validateEvenHubPageContainer(container).valid) return null
    if (texts.filter(text => text.isEventCapture === 1).length > 1) return null
    if (texts.some(text => byteLength(text.content ?? '') > MAX_TEXT_BYTES)) return null
    menu = (container.menuObject?.menuItems ?? []).map(item => ({ id: item.itemID ?? 0, name: item.itemName ?? '' }))
    pictures = (container.imageObject ?? []).map((image, index) => ({
      id: image.containerID ?? 0,
      name: image.containerName ?? '',
      x: image.xPosition ?? 0,
      y: image.yPosition ?? 0,
      w: image.width ?? 0,
      h: image.height ?? 0,
      data: [],
      order: image.zOrderIndex ?? index,
    }))
    return texts.map((text, index) => ({
      id: text.containerID ?? 0,
      name: text.containerName ?? '',
      x: text.xPosition ?? 0,
      y: text.yPosition ?? 0,
      w: text.width ?? 0,
      h: text.height ?? 0,
      text: text.content ?? '',
      brightness: (text.textColor ?? MAX_BRIGHTNESS) as Brightness,
      capture: text.isEventCapture === 1,
      order: text.zOrderIndex ?? index,
    }))
  }

  const bridge: Bridge = {
    createStartUpPageContainer: async container => {
      fake.calls.push('create')
      if (refused('create') || page || owned) return 1
      const next = read(container)
      if (!next) return 1
      page = next
      return 0
    },
    rebuildPageContainer: async container => {
      fake.calls.push('rebuild')
      if (refused('rebuild') || !(page || owned)) return false
      const next = read(container)
      if (!next) return false
      page = next
      owned = false
      return true
    },
    textContainerUpgrade: async upgrade => {
      fake.calls.push(`update ${upgrade.containerName}`)
      if (refused('update')) return false
      const box = page?.find(candidate => candidate.id === upgrade.containerID && candidate.name === upgrade.containerName)
      if (!box || byteLength(upgrade.content ?? '') > MAX_TEXT_BYTES) return false
      box.text = upgrade.content ?? ''
      if (upgrade.textColor !== undefined) box.brightness = upgrade.textColor as Brightness
      return true
    },
    updateImageRawData: async update => {
      fake.calls.push(`picture ${update.containerName}`)
      if (refused('picture')) return ImageRawDataUpdateResult.sendFailed
      const picture = pictures.find(candidate => candidate.id === update.containerID && candidate.name === update.containerName)
      if (!picture) return ImageRawDataUpdateResult.imageException
      picture.data = Array.from(update.imageData as Uint8Array)
      return ImageRawDataUpdateResult.success
    },
    shutDownPageContainer: async mode => {
      fake.exits.push(mode ?? 0)
      return true
    },
    audioControl: async (open, source) => {
      fake.calls.push(open ? 'mic open' : 'mic close')
      if (open && refused('mic')) return false
      fake.mic = open ? (source ?? 'glasses') : null
      return true
    },
    onEvenHubEvent: listener => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }

  const emit = (event: GlassesEvent) => {
    for (const listener of [...listeners]) listener(event as EvenHubEvent)
  }
  const system = (eventType?: number, eventSource?: number) =>
    emit({ sysEvent: { ...(eventType === undefined ? {} : { eventType }), ...(eventSource === undefined ? {} : { eventSource }) } })
  const swipe = (eventType: number) => {
    const capture = page?.find(box => box.capture)
    emit({ textEvent: { containerID: capture?.id, containerName: capture?.name, eventType } })
  }

  const fake = {
    bridge,
    calls: [] as string[],
    exits: [] as number[],
    mic: null as string | null,
    sound: (pcm: Uint8Array) => emit({ audioEvent: { audioPcm: pcm } }),
    listening: () => listeners.size,
    boxes: (): FakeBox[] => [...(page ?? [])].sort((a, b) => a.order - b.order),
    pictures: () => pictures.map(({ name, x, y, w, h, data }) => ({ name, x, y, w, h, data })),
    stack: (): string[] => [...(page ?? []), ...pictures].sort((a, b) => a.order - b.order).map(({ name }) => name),
    lines: (): string[] => linesOf(page ?? []),
    overlay: (): string => overlayWords(page?.find(box => box.capture)?.text ?? ''),
    menuItems: (): MenuItem[] => [...menu],
    pick: (name: string) => {
      const item = menu.find(candidate => candidate.name === name)
      if (!item) throw new Error(`No menu item "${name}". The menu is: ${menu.map(candidate => candidate.name).join(', ') || 'empty'}.`)
      emit({ menuItemClickEvent: { itemID: item.id } })
    },
    refuse: (op: FakeOp, times = 1, throws = false) => void (refusals[op] = { times, throws }),
    emit,
    tap: () => system(undefined, 1),
    double: () => system(3, 1),
    up: () => swipe(1),
    down: () => swipe(2),
    hold: (source: HoldSource = 'right') => system(9, SOURCES[source]),
    release: (source: HoldSource = 'right') => system(10, SOURCES[source]),
    menu: (item: number) => emit({ menuItemClickEvent: { itemID: item } }),
    foreground: () => system(4),
    background: () => system(5),
    exit: () => system(7),
  }
  return fake
}

export type FakeBridge = ReturnType<typeof fakeBridge>
