import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifetime } from '../lifetime.js'
import { fakeBridge } from './fake.js'
import type { Box, Frame } from './frame.js'
import { FRAME_TAG, Glasses, INPUT_TAG, OVERLAY_DIM, REBUILD_GAP_MS } from './glasses.js'
import type { Input } from './input.js'
import { textWidth } from './text.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const box = (id: string, text: string, more: Partial<Box> = {}): Box => ({ id, x: 0, y: 0, w: 576, h: 27, text, ...more })
const frame = (...boxes: Box[]): Frame => ({ boxes })
const setup = (options: { owned?: boolean; trace?: (line: string) => void } = {}) => {
  const life = new Lifetime()
  const fake = fakeBridge({ owned: options.owned })
  const glasses = new Glasses(life, fake.bridge, { trace: options.trace })
  return { life, fake, glasses }
}
const settle = async (ms = 0) => void (await vi.advanceTimersByTimeAsync(ms))

describe('the first draw', () => {
  it('creates the page, with the boxes in front of an empty box that takes the input', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'Threads'), box('body', 'One\nTwo', { y: 27, h: 200, brightness: 2 })))
    await settle()
    expect(fake.calls).toEqual(['create'])
    expect(fake.boxes().map(({ name, text, capture, brightness }) => ({ name, text, capture, brightness }))).toEqual([
      { name: 'input', text: ' ', capture: true, brightness: 4 },
      { name: 'title', text: 'Threads', capture: false, brightness: 4 },
      { name: 'body', text: 'One\nTwo', capture: false, brightness: 2 },
      { name: 'front', text: ' ', capture: false, brightness: 4 },
    ])
    expect(fake.boxes()[0]).toMatchObject({ x: 0, y: 0, w: 576, h: 288 })
    expect(fake.lines()).toEqual(['Threads', 'One', 'Two'])
  })

  it('takes over a page left by an earlier load of the app', async () => {
    const { fake, glasses } = setup({ owned: true })
    glasses.draw(frame(box('title', 'Threads')))
    await settle()
    expect(fake.calls).toEqual(['create', 'rebuild'])
    expect(fake.lines()).toEqual(['Threads'])
  })
})

describe('a later draw', () => {
  const drawn = async () => {
    const made = setup()
    made.glasses.draw(frame(box('title', 'Threads'), box('body', 'One', { y: 27 })))
    await settle(REBUILD_GAP_MS)
    made.fake.calls.length = 0
    return made
  }

  it('updates in place the boxes whose text changed', async () => {
    const { fake, glasses } = await drawn()
    glasses.draw(frame(box('title', 'Threads'), box('body', 'Two', { y: 27 })))
    await settle()
    expect(fake.calls).toEqual(['update body'])
    expect(fake.lines()).toEqual(['Threads', 'Two'])
  })

  it('updates in place a box whose brightness changed', async () => {
    const { fake, glasses } = await drawn()
    glasses.draw(frame(box('title', 'Threads', { brightness: 1 }), box('body', 'One', { y: 27 })))
    await settle()
    expect(fake.calls).toEqual(['update title'])
    expect(fake.boxes()[1].brightness).toBe(1)
  })

  it('sends nothing when nothing changed', async () => {
    const { fake, glasses } = await drawn()
    glasses.draw(frame(box('title', 'Threads'), box('body', 'One', { y: 27 })))
    await settle()
    expect(fake.calls).toEqual([])
  })

  it('rebuilds the page when a box is added, removed, moved, resized or renamed', async () => {
    for (const next of [
      frame(box('title', 'Threads'), box('body', 'One', { y: 27 }), box('foot', 'x', { y: 261 })),
      frame(box('title', 'Threads')),
      frame(box('title', 'Threads'), box('body', 'One', { y: 54 })),
      frame(box('title', 'Threads'), box('body', 'One', { y: 27, h: 100 })),
      frame(box('title', 'Threads'), box('other', 'One', { y: 27 })),
    ]) {
      const { fake, glasses } = await drawn()
      glasses.draw(next)
      await settle()
      expect(fake.calls).toEqual(['rebuild'])
    }
  })

  it('waits between rebuilds, and not before an update', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'One')))
    await settle()
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    glasses.draw(frame(box('title', 'Two', { y: 27 })))
    await settle(REBUILD_GAP_MS - 1)
    expect(fake.calls).toEqual(['create', 'update title'])
    await settle(1)
    expect(fake.calls).toEqual(['create', 'update title', 'rebuild'])
  })

  it('sends only the latest frame when several are drawn while one is on its way', async () => {
    const { fake, glasses } = await drawn()
    for (const text of ['Two', 'Three', 'Four']) glasses.draw(frame(box('title', 'Threads'), box('body', text, { y: 27 })))
    await settle()
    expect(fake.calls).toEqual(['update body'])
    expect(fake.lines()).toEqual(['Threads', 'Four'])
  })

  it('finishes one draw before it starts the next', async () => {
    const { fake, glasses } = await drawn()
    glasses.draw(frame(box('title', 'A'), box('body', 'B', { y: 27 })))
    await Promise.resolve()
    glasses.draw(frame(box('title', 'C'), box('body', 'D', { y: 27 })))
    await settle()
    expect(fake.lines()).toEqual(['C', 'D'])
    expect(fake.calls.filter(call => call === 'update title').length).toBeLessThanOrEqual(2)
  })
})

describe('a refused draw', () => {
  it('is tried again after longer and longer waits, up to four seconds', async () => {
    const { fake, glasses } = setup()
    fake.refuse('create', 99)
    fake.refuse('rebuild', 99)
    glasses.draw(frame(box('title', 'Threads')))
    const tries = () => fake.calls.filter(call => call === 'create').length
    await settle()
    expect(tries()).toBe(1)
    for (const [wait, expected] of [
      [499, 1],
      [1, 2],
      [1_000, 3],
      [2_000, 4],
      [4_000, 5],
      [4_000, 6],
    ]) {
      await settle(wait)
      expect(tries()).toBe(expected)
    }
  })

  it('is drawn once the glasses accept it, with the newest frame', async () => {
    const { fake, glasses } = setup()
    fake.refuse('create', 1, true)
    fake.refuse('rebuild', 1, true)
    glasses.draw(frame(box('title', 'Old')))
    await settle()
    glasses.draw(frame(box('title', 'New')))
    await settle(500)
    expect(fake.lines()).toEqual(['New'])
  })

  it('tries a refused update again, and starts from short waits after a success', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'One')))
    await settle()
    fake.refuse('update', 1)
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    expect(fake.lines()).toEqual(['One'])
    await settle(500)
    expect(fake.lines()).toEqual(['Two'])
    fake.refuse('update', 1)
    glasses.draw(frame(box('title', 'Three')))
    await settle(500)
    expect(fake.lines()).toEqual(['Three'])
  })
})

describe('the limits of the glasses', () => {
  it('cuts text that is too long for a box', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'a'.repeat(2_000))))
    await settle()
    expect(fake.lines()[0]).toMatch(/^a{996}…$/)
  })

  it('draws the first boxes and reports the rest when there are too many', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, glasses } = setup()
    glasses.draw(frame(...Array.from({ length: 9 }, (_, n) => box(`box${n}`, `line ${n}`, { y: n * 27 }))))
    await settle()
    expect(fake.lines()).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
    expect(error).toHaveBeenCalledOnce()
  })

  it('keeps a long box name within what the glasses take', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('a-very-long-box-name-indeed', 'x')))
    await settle()
    expect(fake.boxes()[1].name).toBe('a-very-long-box-')
  })
})

describe('the overlay', () => {
  const drawn = async () => {
    const made = setup()
    made.glasses.draw(frame(box('title', 'Threads', { brightness: 3 }), box('body', 'One', { y: 27, brightness: 0 })))
    await settle(REBUILD_GAP_MS)
    made.fake.calls.length = 0
    return made
  }
  const look = (fake: ReturnType<typeof fakeBridge>) =>
    fake.boxes().map(({ name, text, brightness }) => `${name} ${brightness} ${JSON.stringify(text)}`)

  it('has a box in front of the others, along the bottom, on every page', async () => {
    const { fake } = await drawn()
    expect(fake.boxes().at(-1)).toMatchObject({ name: 'front', x: 0, y: 207, w: 576, h: 81, text: ' ' })
  })

  it('dims the page in place and writes over it, bright, at the bottom', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    expect(fake.calls).toEqual(['update title', 'update front'])
    expect(look(fake)).toEqual(['input 4 " "', `title ${OVERLAY_DIM} "Threads"`, 'body 0 "One"', 'front 4 "\\n\\nListening"'])
  })

  it('gives the page its brightness back when it goes', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    glasses.overlay(null)
    await settle()
    expect(look(fake)).toEqual(['input 4 " "', 'title 3 "Threads"', 'body 0 "One"', 'front 4 " "'])
    expect(fake.calls.includes('rebuild')).toBe(false)
  })

  it('stays over a frame drawn while it is up', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    glasses.draw(frame(box('title', 'Chats', { brightness: 3 }), box('body', 'Two', { y: 27, brightness: 0 })))
    await settle()
    expect(look(fake)).toEqual(['input 4 " "', `title ${OVERLAY_DIM} "Chats"`, 'body 0 "Two"', 'front 4 "\\n\\nListening"'])
  })

  it('can be shown before anything is drawn', async () => {
    const { fake, glasses } = setup()
    glasses.overlay('Set up voice on your phone')
    await settle()
    expect(fake.lines()).toEqual(['Set up voice on your phone'])
  })

  it('shows three lines at most, split to fit, the last one cut', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('one two three four five six seven eight nine ten '.repeat(8))
    await settle()
    const lines = fake.boxes().at(-1)!.text.split('\n')
    expect(lines.length).toBe(3)
    expect(lines[2].endsWith('…')).toBe(true)
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(576)
  })
})

describe('the menu', () => {
  const menu = [
    { id: 1, name: 'Refresh' },
    { id: 2, name: 'Settings' },
  ]

  it('goes on the page, and is gone from a page drawn without one', async () => {
    const { fake, glasses } = setup()
    glasses.draw({ boxes: [box('title', 'Threads')], menu })
    await settle(REBUILD_GAP_MS)
    expect(fake.menuItems()).toEqual(menu)
    glasses.draw({ boxes: [box('title', 'Threads')] })
    await settle()
    expect(fake.menuItems()).toEqual([])
  })

  it('rebuilds the page only when it changes', async () => {
    const { fake, glasses } = setup()
    glasses.draw({ boxes: [box('title', 'One')], menu })
    await settle(REBUILD_GAP_MS)
    glasses.draw({ boxes: [box('title', 'Two')], menu: [...menu] })
    await settle(REBUILD_GAP_MS)
    glasses.draw({ boxes: [box('title', 'Two')], menu: [menu[0], { id: 2, name: 'About' }] })
    await settle(REBUILD_GAP_MS)
    expect(fake.calls).toEqual(['create', 'update title', 'rebuild'])
  })

  it('cuts a name that is too long for the glasses', async () => {
    const { fake, glasses } = setup()
    glasses.draw({ boxes: [], menu: [{ id: 1, name: 'A very long name for a menu item indeed' }] })
    await settle()
    expect(fake.menuItems()).toEqual([{ id: 1, name: 'A very long name for a menu i…' }])
  })

  it('leaves out what is over ten items, and reports it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, glasses } = setup()
    glasses.draw({ boxes: [], menu: Array.from({ length: 11 }, (_, n) => ({ id: n + 1, name: `Item ${n + 1}` })) })
    await settle()
    expect(fake.menuItems().length).toBe(10)
    expect(error).toHaveBeenCalledOnce()
  })

  it('tells the listeners which item was picked', async () => {
    const { fake, glasses } = setup()
    const heard: Input[] = []
    glasses.onInput(input => heard.push(input))
    glasses.draw({ boxes: [], menu })
    await settle()
    fake.pick('Settings')
    expect(heard).toEqual([{ kind: 'menu', item: 2 }])
  })
})

describe('input', () => {
  it('tells every listener what the user did', () => {
    const { fake, glasses } = setup()
    const heard: Input[] = []
    glasses.onInput(input => heard.push(input))
    fake.tap()
    fake.double()
    fake.up()
    fake.down()
    fake.hold('left')
    fake.release('left')
    fake.menu(3)
    fake.foreground()
    fake.background()
    expect(heard).toEqual([
      { kind: 'tap' },
      { kind: 'double' },
      { kind: 'up' },
      { kind: 'down' },
      { kind: 'hold', source: 'left' },
      { kind: 'release', source: 'left' },
      { kind: 'menu', item: 3 },
      { kind: 'foreground' },
      { kind: 'background' },
    ])
  })

  it('stops telling a listener that left', () => {
    const { fake, glasses } = setup()
    const heard: Input[] = []
    glasses.onInput(input => heard.push(input))()
    fake.tap()
    expect(heard).toEqual([])
  })

  it('passes over what is not input', () => {
    const { fake, glasses } = setup()
    const heard: Input[] = []
    glasses.onInput(input => heard.push(input))
    fake.emit({ audioEvent: { audioPcm: new Uint8Array(4) } })
    expect(heard).toEqual([])
  })

  it('keeps drawing while the app is behind another, which Even also reports around its own menu', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'One')))
    await settle()
    fake.background()
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    expect(fake.lines()).toEqual(['Two'])
  })
})

describe('the end', () => {
  it('stops drawing and listening when its lifetime ends', async () => {
    const { life, fake, glasses } = setup()
    glasses.draw(frame(box('title', 'One')))
    await settle()
    life.end()
    glasses.draw(frame(box('title', 'Two')))
    await settle(10_000)
    expect(fake.lines()).toEqual(['One'])
    expect(fake.listening()).toBe(0)
  })

  it('stops when the glasses close the app, after telling the listeners', async () => {
    const { fake, glasses } = setup()
    const heard: Input[] = []
    glasses.onInput(input => heard.push(input))
    glasses.draw(frame(box('title', 'One')))
    await settle()
    fake.exit()
    glasses.draw(frame(box('title', 'Two')))
    await settle(10_000)
    expect(heard).toEqual([{ kind: 'exit' }])
    expect(fake.lines()).toEqual(['One'])
    expect(fake.listening()).toBe(0)
  })

  it('gives up a retry when its lifetime ends', async () => {
    const { life, fake, glasses } = setup()
    fake.refuse('create', 99)
    fake.refuse('rebuild', 99)
    glasses.draw(frame(box('title', 'One')))
    await settle()
    life.end()
    await settle(10_000)
    expect(fake.calls).toEqual(['create', 'rebuild'])
  })

  it('asks Even to close the app, leaving the choice to the user', async () => {
    const { fake, glasses } = setup()
    await glasses.leave()
    expect(fake.exits).toEqual([1])
  })
})

describe('the trace', () => {
  it('writes what the glasses show after each draw that changed it', async () => {
    const traced: string[] = []
    const { glasses } = setup({ trace: line => traced.push(line) })
    glasses.draw(frame(box('body', 'One\n\nTwo', { y: 27 }), box('title', 'Threads')))
    await settle()
    glasses.draw(frame(box('body', 'One\n\nTwo', { y: 27 }), box('title', 'Threads')))
    await settle()
    glasses.draw(frame(box('body', 'Three', { y: 27 }), box('title', 'Threads')))
    await settle()
    expect(traced).toEqual([
      `${FRAME_TAG} {"lines":["Threads","One","Two"],"menu":[]}`,
      `${FRAME_TAG} {"lines":["Threads","Three"],"menu":[]}`,
    ])
  })

  it('includes the menu and the overlay', async () => {
    const traced: string[] = []
    const { glasses } = setup({ trace: line => traced.push(line) })
    glasses.draw({ boxes: [box('title', 'Threads')], menu: [{ id: 1, name: 'Refresh' }] })
    glasses.overlay('Listening')
    await settle()
    expect(traced).toEqual([`${FRAME_TAG} {"lines":["Threads","Listening"],"menu":["Refresh"]}`])
  })

  it('writes each thing the user did', () => {
    const traced: string[] = []
    const { fake } = setup({ trace: line => traced.push(line) })
    fake.tap()
    fake.menu(3)
    fake.emit({ audioEvent: { audioPcm: new Uint8Array(2) } })
    expect(traced).toEqual([`${INPUT_TAG} {"kind":"tap"}`, `${INPUT_TAG} {"kind":"menu","item":3}`])
  })

  it('writes nothing for a draw the glasses refused', async () => {
    const traced: string[] = []
    const { fake, glasses } = setup({ trace: line => traced.push(line) })
    fake.refuse('create', 1)
    fake.refuse('rebuild', 1)
    glasses.draw(frame(box('title', 'Threads')))
    await settle()
    expect(traced).toEqual([])
  })
})
