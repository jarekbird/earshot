import { EventSourceType, OsEventTypeList } from '@evenrealities/even_hub_sdk'

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

export function decode(event: GlassesEvent): Input | null {
  if (event.audioEvent) return null
  if (event.menuItemClickEvent) return { kind: 'menu', item: event.menuItemClickEvent.itemID ?? 0 }
  const envelope: Envelope | undefined = event.sysEvent ?? event.textEvent ?? event.listEvent
  if (!envelope) return null
  // A tap is event type 0, which the glasses leave out.
  const type = envelope.eventType === undefined ? OsEventTypeList.CLICK_EVENT : OsEventTypeList.fromJson(envelope.eventType)
  const kind = type === undefined ? undefined : KINDS[type]
  if (!kind) return null
  if (kind !== 'hold' && kind !== 'release') return { kind }
  const source = EventSourceType.fromJson(envelope.eventSource)
  return { kind, source: (source === undefined ? undefined : SOURCES[source]) ?? 'unknown' }
}
