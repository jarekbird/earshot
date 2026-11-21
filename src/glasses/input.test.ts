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

  it('is not input when it is sound, motion or nothing', () => {
    expect(decode({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBeNull()
    expect(decode({ sysEvent: { eventType: 8 } })).toBeNull()
    expect(decode({ jsonData: {} })).toBeNull()
    expect(decode({})).toBeNull()
  })
})
