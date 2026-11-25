import { EventSourceType, normalizeLooseKey, OsEventTypeList } from '@evenrealities/even_hub_sdk'

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

const DEEPEST = 4

function typesNamed(data: unknown, deeper = DEEPEST): unknown[] {
  if (!data || typeof data !== 'object' || ArrayBuffer.isView(data) || deeper < 0) return []
  return Object.entries(data).flatMap(([key, value]) => (normalizeLooseKey(key) === 'eventtype' ? [value] : typesNamed(value, deeper - 1)))
}

export function decode(event: GlassesEvent): Input | null {
  if (event.menuItemClickEvent) return { kind: 'menu', item: event.menuItemClickEvent.itemID ?? 0 }
  const envelopes = [event.sysEvent, event.textEvent, event.listEvent].filter((part): part is Envelope => part !== undefined)
  if (!envelopes.length) return null
  // Fact: a tap is event type 0, which the glasses leave out. The SDK leaves out a type it does not know too, and keeps the host's words in jsonData.
  const types = [
    ...envelopes.map(({ eventType }) => (eventType === undefined ? OsEventTypeList.CLICK_EVENT : OsEventTypeList.fromJson(eventType))),
    ...typesNamed(event.jsonData).map(named => OsEventTypeList.fromJson(named)),
  ]
  const [type] = types
  if (type === undefined || types.some(other => other !== type)) return null
  const kind = KINDS[type]
  if (!kind) return null
  if (kind !== 'hold' && kind !== 'release') return { kind }
  const source = EventSourceType.fromJson(envelopes[0].eventSource)
  return { kind, source: (source === undefined ? undefined : SOURCES[source]) ?? 'unknown' }
}
