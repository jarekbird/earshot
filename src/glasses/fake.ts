import { validateEvenHubPageContainer, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { byteLength, linesOf, type Brightness } from './frame.js'
import type { GlassesEvent, HoldSource } from './input.js'
import { MAX_BOXES, MAX_BRIGHTNESS, MAX_TEXT_BOXES, MAX_TEXT_BYTES } from './limits.js'

export type FakeOp = 'create' | 'rebuild' | 'update'

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

type Page = Parameters<EvenAppBridge['rebuildPageContainer']>[0]
type Bridge = Pick<
  EvenAppBridge,
  'createStartUpPageContainer' | 'rebuildPageContainer' | 'textContainerUpgrade' | 'onEvenHubEvent' | 'shutDownPageContainer'
>

const SOURCES: Record<HoldSource, number | undefined> = { right: 1, ring: 2, left: 3, unknown: undefined }

export function fakeBridge(options: { owned?: boolean } = {}) {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  const refusals: Record<FakeOp, { times: number; throws: boolean }> = {
    create: { times: 0, throws: false },
    rebuild: { times: 0, throws: false },
    update: { times: 0, throws: false },
  }
  let page: FakeBox[] | null = null
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
    shutDownPageContainer: async mode => {
      fake.exits.push(mode ?? 0)
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
    listening: () => listeners.size,
    boxes: (): FakeBox[] => [...(page ?? [])].sort((a, b) => a.order - b.order),
    lines: (): string[] => linesOf(page ?? []),
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
