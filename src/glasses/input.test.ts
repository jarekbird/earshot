import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import { decode } from './input.js'

// Each event is what the Even Hub simulator 0.9.5 sends for that touchpad action.
describe('decode', () => {
  it('reads a tap, which arrives with no event type', () => {
    expect(decode({ jsonData: { eventSource: 1 }, sysEvent: { eventSource: 1 } })).toEqual({ kind: 'tap' })
    expect(decode({ textEvent: { containerID: 1, containerName: 'capture' } })).toEqual({ kind: 'tap' })
    expect(decode({ listEvent: { containerID: 1, currentSelectItemIndex: 2 } })).toEqual({ kind: 'tap' })
  })

  it('reads a double tap', () => {
    expect(decode({ sysEvent: { eventType: 3, eventSource: 1 } })).toEqual({ kind: 'double' })
  })

  it('reads a swipe up and a swipe down', () => {
    expect(decode({ textEvent: { containerID: 1, containerName: 'capture', eventType: 1 } })).toEqual({ kind: 'up' })
    expect(decode({ textEvent: { containerID: 1, containerName: 'capture', eventType: 2 } })).toEqual({ kind: 'down' })
  })

  it('reads a hold and its release, with where it was pressed', () => {
    expect(decode({ sysEvent: { eventType: 9 } })).toEqual({ kind: 'hold', source: 'unknown' })
    expect(decode({ sysEvent: { eventType: 9, eventSource: 1 } })).toEqual({ kind: 'hold', source: 'right' })
    expect(decode({ sysEvent: { eventType: 9, eventSource: 2 } })).toEqual({ kind: 'hold', source: 'ring' })
    expect(decode({ sysEvent: { eventType: 9, eventSource: 3 } })).toEqual({ kind: 'hold', source: 'left' })
    expect(decode({ sysEvent: { eventType: 10 } })).toEqual({ kind: 'release', source: 'unknown' })
  })

  it('reads a pick from the menu', () => {
    expect(decode({ jsonData: { itemID: 8 }, menuItemClickEvent: { itemID: 8 } })).toEqual({ kind: 'menu', item: 8 })
  })

  it('reads the app coming to the front, leaving it, and being closed', () => {
    expect(decode({ sysEvent: { eventType: 4 } })).toEqual({ kind: 'foreground' })
    expect(decode({ sysEvent: { eventType: 5 } })).toEqual({ kind: 'background' })
    expect(decode({ sysEvent: { eventType: 6 } })).toEqual({ kind: 'exit' })
    expect(decode({ sysEvent: { eventType: 7 } })).toEqual({ kind: 'exit' })
  })

  it('reads event types given by name', () => {
    expect(decode({ sysEvent: { eventType: 'DOUBLE_CLICK_EVENT' } })).toEqual({ kind: 'double' })
  })

  it('reads no tap into a gesture the SDK did not know: a tap runs what the cursor is on, and that may be a write', () => {
    const fromHost = (jsonData: object) => evenHubEventFromJson({ type: 'sysEvent', jsonData })
    expect(decode(fromHost({ eventType: 42, eventSource: 1 }))).toBeNull()
    expect(decode(fromHost({ eventType: 'TRIPLE_CLICK_EVENT' }))).toBeNull()
    expect(decode(fromHost({ eventType: '3' }))).toBeNull()
    expect(decode(fromHost({ Event_Type: 42 }))).toBeNull()
    expect(decode(fromHost({ sysEvent: { eventType: 3 } }))).toBeNull()
    expect(decode(evenHubEventFromJson({ type: 'text_event', data: { Container_ID: 1, Event_Type: 11 } }))).toBeNull()
    expect(decode(evenHubEventFromJson(['list_event', { containerID: 1, eventType: 99 }]))).toBeNull()
  })

  it('still reads what the SDK knew, however the host spelled it', () => {
    const fromHost = (jsonData: object) => evenHubEventFromJson({ type: 'sysEvent', jsonData })
    expect(decode(fromHost({ eventSource: 1 }))).toEqual({ kind: 'tap' })
    expect(decode(fromHost({ eventType: 0 }))).toEqual({ kind: 'tap' })
    expect(decode(fromHost({ Event_Type: 'DOUBLE_CLICK' }))).toEqual({ kind: 'double' })
    expect(decode(fromHost({ eventType: 9, eventSource: 3 }))).toEqual({ kind: 'hold', source: 'left' })
    expect(decode(evenHubEventFromJson({ type: 'text_event', data: { Container_ID: 1, Event_Type: 2 } }))).toEqual({ kind: 'down' })
  })

  it('reads nothing into an event whose parts name different gestures, and one gesture into parts that agree', () => {
    expect(decode({ sysEvent: { eventType: 3 }, textEvent: { eventType: 1 } })).toBeNull()
    expect(decode({ sysEvent: { eventType: 3 }, listEvent: { containerID: 1 } })).toBeNull()
    expect(decode({ jsonData: { eventType: 2 }, textEvent: { eventType: 1 } })).toBeNull()
    expect(decode({ sysEvent: { eventType: 3 }, textEvent: { eventType: 3 } })).toEqual({ kind: 'double' })
  })

  it('reads a gesture that arrives with sound', () => {
    expect(decode({ audioEvent: { audioPcm: new Uint8Array(2) }, sysEvent: { eventType: 3 } })).toEqual({ kind: 'double' })
  })

  it('is not input when it is sound, motion or nothing', () => {
    expect(decode({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBeNull()
    expect(decode({ sysEvent: { eventType: 8 } })).toBeNull()
    expect(decode({ jsonData: {} })).toBeNull()
    expect(decode({})).toBeNull()
  })
})
