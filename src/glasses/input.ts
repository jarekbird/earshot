import { EventSourceType, MenuItemClickEvent, normalizeLooseKey, OsEventTypeList } from '@evenrealities/even_hub_sdk'

export type HoldSource = 'right' | 'left' | 'ring' | 'unknown'

export type Input =
  | { kind: 'tap' | 'double' | 'up' | 'down' | 'foreground' | 'background' | 'exit' }
  | { kind: 'hold' | 'release'; source: HoldSource }
  | { kind: 'menu'; item: number }

interface Envelope {
  eventType?: unknown
  eventSource?: unknown
}

export interface GlassesEvent {
  listEvent?: object
  textEvent?: object
  sysEvent?: object
  audioEvent?: { audioPcm?: Uint8Array | ArrayLike<number>; speakerRole?: unknown }
  menuItemClickEvent?: { itemID?: number }
  jsonData?: unknown
}

const KINDS: Partial<
  Record<OsEventTypeList, 'tap' | 'double' | 'up' | 'down' | 'foreground' | 'background' | 'exit' | 'hold' | 'release'>
> = {
  [OsEventTypeList.CLICK_EVENT]: 'tap',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'up',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'down',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: 'foreground',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: 'background',
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: 'exit',
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: 'exit',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'hold',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'release',
}

const SOURCES: Partial<Record<EventSourceType, HoldSource>> = {
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: 'right',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: 'left',
  [EventSourceType.TOUCH_EVENT_FROM_RING]: 'ring',
}

const MOST_PARTS = 1_000

function said(data: unknown): { types: unknown[]; items: unknown[] } | undefined {
  const types: unknown[] = []
  const items: unknown[] = []
  const seen = new Set<unknown>()
  const open = [data]
  let read = 0
  while (open.length) {
    const part = open.pop()
    if (!part || typeof part !== 'object' || ArrayBuffer.isView(part) || seen.has(part)) continue
    seen.add(part)
    if (Array.isArray(part) && part.length > MOST_PARTS - read) return undefined
    for (const key in part) {
      if (!Object.hasOwn(part, key)) continue
      if (++read > MOST_PARTS) return undefined
      const value: unknown = (part as Record<string, unknown>)[key]
      const name = normalizeLooseKey(key)
      if (name === 'eventtype') types.push(value)
      else if (name === 'itemid') items.push(value)
      if (value && typeof value === 'object') open.push(value)
    }
  }
  return { types, items }
}

export function decode(event: GlassesEvent): Input | null {
  const menu = event.menuItemClickEvent
  const envelopes = [event.sysEvent, event.textEvent, event.listEvent].filter((part): part is Envelope => part !== undefined)
  if (!menu && !envelopes.length) return null
  // Fact: the SDK leaves out a type or an item it cannot read, and keeps the host's own words for the event in jsonData.
  const host = said(event.jsonData)
  if (!host) return null
  if (menu) {
    if (envelopes.length || host.types.some(named => OsEventTypeList.fromJson(named) === undefined)) return null
    const items = host.items.map(item => MenuItemClickEvent.fromJson({ itemID: item }).itemID)
    if (items.some(item => item === undefined || item !== menu.itemID)) return null
    return { kind: 'menu', item: menu.itemID ?? 0 }
  }
  // Fact: a tap is event type 0, which the glasses leave out.
  const types = [
    ...envelopes.map(({ eventType }) => (eventType === undefined ? OsEventTypeList.CLICK_EVENT : OsEventTypeList.fromJson(eventType))),
    ...host.types.map(named => OsEventTypeList.fromJson(named)),
  ]
  const [type] = types
  if (type === undefined || types.some(other => other !== type)) return null
  const kind = KINDS[type]
  if (!kind) return null
  if (kind !== 'hold' && kind !== 'release') return { kind }
  const source = EventSourceType.fromJson(envelopes[0].eventSource)
  return { kind, source: (source === undefined ? undefined : SOURCES[source]) ?? 'unknown' }
}
