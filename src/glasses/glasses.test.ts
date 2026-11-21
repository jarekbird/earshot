import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifetime } from '../lifetime.js'
import { fakeBridge } from './fake.js'
import type { Box, Frame, Picture } from './frame.js'
import { FRAME_TAG, Glasses, INPUT_TAG, OVERLAY_DIM, REBUILD_GAP_MS, type Drawing } from './glasses.js'
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
    expect(fake.lines()).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'])
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

  it('needs no box of its own: it writes in the box that takes the input, so an app keeps seven of the eight', async () => {
    const { fake, glasses } = await drawn()
    expect(fake.boxes().map(({ name }) => name)).toEqual(['input', 'title', 'body'])
    glasses.overlay('Listening')
    await settle()
    expect(fake.lines().at(-1)).toBe('Listening')
    expect(fake.boxes()[0].text.split('\n').length).toBe(10)
  })

  it('blanks a box that sits under its lines, so two texts never share a row', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('body', 'One', { y: 27, h: 216 }), box('status', 'hold to talk', { y: 261, h: 27 })))
    await settle(REBUILD_GAP_MS)
    glasses.overlay('Listening')
    await settle()
    expect(look(fake).slice(1)).toEqual([`body ${OVERLAY_DIM} "One"`, `status ${OVERLAY_DIM} " "`])
    glasses.overlay(null)
    await settle()
    expect(look(fake).slice(1)).toEqual(['body 4 "One"', 'status 4 "hold to talk"'])
  })

  it('dims the page in place and writes over it, bright, at the bottom', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    expect(fake.calls).toEqual(['update input', 'update title'])
    expect(look(fake)).toEqual([
      `input 4 ${JSON.stringify('\n'.repeat(9) + 'Listening')}`,
      `title ${OVERLAY_DIM} "Threads"`,
      'body 0 "One"',
    ])
  })

  it('gives the page its brightness back when it goes', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    glasses.overlay(null)
    await settle()
    expect(look(fake)).toEqual(['input 4 " "', 'title 3 "Threads"', 'body 0 "One"'])
    expect(fake.calls.includes('rebuild')).toBe(false)
  })

  it('stays over a frame drawn while it is up', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    glasses.draw(frame(box('title', 'Chats', { brightness: 3 }), box('body', 'Two', { y: 27, brightness: 0 })))
    await settle()
    expect(look(fake)).toEqual([`input 4 ${JSON.stringify('\n'.repeat(9) + 'Listening')}`, `title ${OVERLAY_DIM} "Chats"`, 'body 0 "Two"'])
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
    const lines = fake.boxes()[0].text.split('\n').slice(7)
    expect(lines.length).toBe(3)
    expect(fake.boxes()[0].text.startsWith('\n'.repeat(7))).toBe(true)
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

describe('the microphone', () => {
  it('opens on the glasses, hands on the sound, and closes', async () => {
    const { fake, glasses } = setup()
    const heard: number[] = []
    glasses.onAudio(pcm => heard.push(pcm.length))
    expect(await glasses.openMic()).toBe(true)
    expect(fake.mic).toBe('glasses')
    fake.sound(new Uint8Array(320))
    fake.sound(new Uint8Array(160))
    await glasses.closeMic()
    expect(fake.mic).toBeNull()
    expect(heard).toEqual([320, 160])
  })

  it('says so when it does not open', async () => {
    const { fake, glasses } = setup()
    fake.refuse('mic', 1)
    expect(await glasses.openMic()).toBe(false)
    fake.refuse('mic', 1, true)
    expect(await glasses.openMic()).toBe(false)
    expect(fake.mic).toBeNull()
  })

  it('stops handing sound to a listener that left, and sound is not input', () => {
    const { fake, glasses } = setup()
    const heard: number[] = []
    const inputs: Input[] = []
    glasses.onInput(input => inputs.push(input))
    glasses.onAudio(pcm => heard.push(pcm.length))()
    fake.sound(new Uint8Array(320))
    expect(heard).toEqual([])
    expect(inputs).toEqual([])
  })

  it('closes when the lifetime ends with it open', async () => {
    const { life, fake, glasses } = setup()
    await glasses.openMic()
    life.end()
    await settle()
    expect(fake.mic).toBeNull()
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

describe('pictures', () => {
  const picture = (id: string, key: string, more: Partial<Picture> = {}): Picture => ({
    id,
    x: 376,
    y: 54,
    w: 200,
    h: 100,
    key,
    data: new Uint8Array([1, 2, 3, key.length]),
    ...more,
  })
  const withPictures = (...pictures: Picture[]): Frame => ({ boxes: [box('title', 'Deploys')], pictures })

  it('puts a picture behind the text and in front of the input box, then sends what it shows', async () => {
    const { fake, glasses } = setup()
    glasses.draw(withPictures(picture('chart', 'v1')))
    await settle()
    expect(fake.calls).toEqual(['create', 'picture chart'])
    expect(fake.pictures()).toEqual([{ name: 'chart', x: 376, y: 54, w: 200, h: 100, data: [1, 2, 3, 2] }])
    expect(fake.stack()).toEqual(['input', 'chart', 'title'])
  })

  it('sends a picture again only when its key changes, and rebuilds nothing for it', async () => {
    const { fake, glasses } = setup()
    glasses.draw(withPictures(picture('chart', 'v1')))
    await settle(REBUILD_GAP_MS)
    fake.calls.length = 0
    glasses.draw(withPictures(picture('chart', 'v1')))
    await settle()
    expect(fake.calls).toEqual([])
    glasses.draw(withPictures(picture('chart', 'v22')))
    await settle()
    expect(fake.calls).toEqual(['picture chart'])
    expect(fake.pictures()[0].data).toEqual([1, 2, 3, 3])
  })

  it('rebuilds the page when a picture comes, moves or goes, and sends every picture again after a rebuild', async () => {
    const { fake, glasses } = setup()
    glasses.draw(withPictures())
    await settle(REBUILD_GAP_MS)
    for (const pictures of [
      [picture('chart', 'v1')],
      [picture('chart', 'v1', { x: 300 })],
      [picture('chart', 'v1', { x: 300 }), picture('logo', 'a', { y: 160 })],
    ]) {
      fake.calls.length = 0
      glasses.draw(withPictures(...pictures))
      await settle(REBUILD_GAP_MS)
      expect(fake.calls).toEqual(['rebuild', ...pictures.map(({ id }) => `picture ${id}`)])
    }
    fake.calls.length = 0
    glasses.draw(withPictures())
    await settle(REBUILD_GAP_MS)
    expect(fake.calls).toEqual(['rebuild'])
    expect(fake.pictures()).toEqual([])
  })

  it('tries a picture the glasses refused again, without drawing the page again', async () => {
    const { fake, glasses } = setup()
    fake.refuse('picture')
    glasses.draw(withPictures(picture('chart', 'v1')))
    await settle()
    expect(fake.calls).toEqual(['create', 'picture chart'])
    expect(fake.pictures()[0].data).toEqual([])
    await settle(500)
    expect(fake.calls).toEqual(['create', 'picture chart', 'picture chart'])
    expect(fake.pictures()[0].data).toEqual([1, 2, 3, 2])
  })

  it('leaves out, and reports, a fifth picture and one whose size the glasses do not take', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, glasses } = setup()
    glasses.draw(
      withPictures(
        picture('wide', 'a', { x: 0, w: 289 }),
        picture('tall', 'a', { h: 145 }),
        picture('small', 'a', { w: 19 }),
        ...Array.from({ length: 5 }, (_, n) => picture(`p${n}`, 'a', { x: n * 100, w: 90 })),
      ),
    )
    await settle()
    expect(fake.pictures().map(({ name }) => name)).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(error).toHaveBeenCalledTimes(4)
  })

  it('still draws the text when a frame has pictures and the overlay is up', async () => {
    const { fake, glasses } = setup()
    glasses.draw(withPictures(picture('chart', 'v1')))
    glasses.overlay('Listening')
    await settle()
    expect(fake.lines()).toEqual(['Deploys', 'Listening'])
    expect(fake.pictures().length).toBe(1)
  })
})

describe('watching the draws', () => {
  const watched = (options: { owned?: boolean } = {}) => {
    const seen: Drawing[] = []
    const life = new Lifetime()
    const fake = fakeBridge(options)
    const glasses = new Glasses(life, fake.bridge, { watch: event => event.at === 'ask' || seen.push(event) })
    const told = () =>
      seen.map(({ at, frame, ...rest }) => [at, frame, 'op' in rest ? rest.op : '', 'box' in rest ? (rest.box ?? '') : ''].join(' ').trim())
    return { fake, glasses, seen, told }
  }

  it('numbers each frame it is asked to draw', () => {
    const { glasses } = watched()
    expect(glasses.draw(frame(box('title', 'One')))).toBe(1)
    expect(glasses.draw(frame(box('title', 'Two')))).toBe(2)
  })

  it('tells of a frame the moment it is asked for, with what it holds', () => {
    const asked: Drawing[] = []
    const glasses = new Glasses(new Lifetime(), fakeBridge().bridge, { watch: event => event.at === 'ask' && asked.push(event) })
    const page = frame(box('title', 'One'))
    glasses.draw(page)
    expect(asked).toEqual([{ at: 'ask', frame: 1, page }])
  })

  it('knows the newest frame that is on the glasses', async () => {
    const { glasses } = watched()
    expect(glasses.shown).toBe(0)
    glasses.draw(frame(box('title', 'One')))
    expect(glasses.shown).toBe(0)
    await settle()
    expect(glasses.shown).toBe(1)
  })

  it('tells of a frame from its start to its end, with each call to the glasses and its answer', async () => {
    const { glasses, seen, told } = watched()
    glasses.draw(frame(box('title', 'Threads')))
    await settle(REBUILD_GAP_MS)
    expect(told()).toEqual(['begin 1', 'call 1 create', 'answer 1 create', 'end 1'])
    expect(seen[0]).toEqual({ at: 'begin', frame: 1, rebuild: true })
    expect(seen[2]).toMatchObject({ ok: true, got: 0, boxes: 1 })
    expect(seen[3]).toEqual({ at: 'end', frame: 1, drawn: true })
    seen.length = 0
    glasses.draw(frame(box('title', 'Chats')))
    await settle()
    expect(told()).toEqual(['begin 2', 'call 2 update title', 'answer 2 update title', 'end 2'])
    expect(seen[0]).toEqual({ at: 'begin', frame: 2, rebuild: false })
  })

  it('tells of the frame that was drawn when newer ones replaced it on the way', async () => {
    const { glasses, told } = watched()
    glasses.draw(frame(box('title', 'One')))
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    expect(told()).toEqual(['begin 2', 'call 2 create', 'answer 2 create', 'end 2'])
  })

  it('tells of a refused draw, what the glasses answered and when it tries again', async () => {
    const { fake, glasses, seen, told } = watched()
    fake.refuse('create')
    fake.refuse('rebuild', 1, true)
    glasses.draw(frame(box('title', 'Threads')))
    await settle()
    expect(told()).toEqual(['begin 1', 'call 1 create', 'answer 1 create', 'call 1 rebuild', 'answer 1 rebuild', 'retry 1', 'end 1'])
    expect(seen[2]).toMatchObject({ ok: false, got: 1 })
    expect(seen[4]).toMatchObject({ ok: false })
    expect((seen[4] as { got: unknown }).got).toBeInstanceOf(Error)
    expect(seen[5]).toEqual({ at: 'retry', frame: 1, failures: 1, inMs: 500 })
    expect(seen[6]).toEqual({ at: 'end', frame: 1, drawn: false })
  })

  it('tells of a picture as it is sent', async () => {
    const { glasses, told } = watched()
    glasses.draw({
      boxes: [box('title', 'Deploys')],
      pictures: [{ id: 'chart', x: 0, y: 54, w: 200, h: 100, key: 'a', data: new Uint8Array(2) }],
    })
    await settle()
    expect(told()).toEqual(['begin 1', 'call 1 create', 'answer 1 create', 'call 1 picture chart', 'answer 1 picture chart', 'end 1'])
  })
})

describe('a draw that has to wait', () => {
  const watched = () => {
    const seen: Drawing[] = []
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge, { watch: event => event.at === 'ask' || seen.push(event) })
    return { fake, glasses, seen }
  }

  it('is told of when it waits for the gap between two rebuilds', async () => {
    const { glasses, seen } = watched()
    glasses.draw(frame(box('title', 'One')))
    await settle()
    seen.length = 0
    glasses.draw(frame(box('title', 'One'), box('body', 'Two', { y: 27 })))
    await settle()
    expect(seen).toEqual([{ at: 'wait', frame: 2, inMs: REBUILD_GAP_MS }])
    await settle(REBUILD_GAP_MS)
    expect(seen.at(-1)).toEqual({ at: 'end', frame: 2, drawn: true })
  })

  it('is told of when it is asked for while a refused draw waits to be tried again', async () => {
    const { fake, glasses, seen } = watched()
    fake.refuse('create')
    fake.refuse('rebuild')
    glasses.draw(frame(box('title', 'One')))
    await settle(100)
    seen.length = 0
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    expect(seen).toEqual([{ at: 'wait', frame: 2, inMs: 400 }])
    await settle(400)
    expect(seen.at(-1)).toEqual({ at: 'end', frame: 2, drawn: true })
  })
})

describe('while the microphone opens', () => {
  const held = async () => {
    const seen: Drawing[] = []
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge, { watch: event => event.at === 'ask' || seen.push(event) })
    glasses.draw({ boxes: [box('title', 'Threads')], menu: [{ id: 1, name: 'Refresh' }] })
    await settle(REBUILD_GAP_MS)
    fake.calls.length = 0
    seen.length = 0
    let open = () => {}
    glasses.holdRebuilds(new Promise<void>(opened => (open = opened)))
    return { fake, glasses, seen, open }
  }

  it('starts no rebuild, since the Even app answers one call at a time and a rebuild would hold the microphone back', async () => {
    const { fake, glasses, seen, open } = await held()
    glasses.draw({ boxes: [box('title', 'Threads'), box('body', 'One', { y: 27 })], menu: [{ id: 1, name: 'Refresh' }] })
    await settle(5_000)
    expect(fake.calls).toEqual([])
    expect(seen).toEqual([{ at: 'wait', frame: 2 }])
    open()
    await settle()
    expect(fake.calls).toEqual(['rebuild'])
    expect(fake.lines()).toEqual(['Threads', 'One'])
  })

  it('still updates the text in place when only the menu waits for the rebuild', async () => {
    const { fake, glasses, seen, open } = await held()
    glasses.draw({ boxes: [box('title', 'Chats')], menu: [{ id: 2, name: 'Stop' }] })
    await settle()
    expect(fake.calls).toEqual(['update title'])
    expect(fake.lines()).toEqual(['Chats'])
    expect(fake.menuItems()).toEqual([{ id: 1, name: 'Refresh' }])
    expect(seen.at(-1)).toEqual({ at: 'end', frame: 2, drawn: false })
    open()
    await settle()
    expect(fake.menuItems()).toEqual([{ id: 2, name: 'Stop' }])
    expect(seen.at(-1)).toEqual({ at: 'end', frame: 2, drawn: true })
  })

  it('draws the newest frame when another is asked for while the text of the first is on its way', async () => {
    const { fake, glasses, open } = await held()
    glasses.draw({ boxes: [box('title', 'Chats')], menu: [{ id: 2, name: 'Stop' }] })
    glasses.draw({ boxes: [box('title', 'Usage')], menu: [{ id: 2, name: 'Stop' }] })
    await settle()
    glasses.draw({ boxes: [box('title', 'Tasks')], menu: [{ id: 2, name: 'Stop' }] })
    await settle()
    expect(fake.lines()).toEqual(['Tasks'])
    open()
    await settle()
    expect(fake.lines()).toEqual(['Tasks'])
    expect(fake.menuItems()).toEqual([{ id: 2, name: 'Stop' }])
  })

  it('holds rebuilds back by itself while it opens the microphone', async () => {
    const fake = fakeBridge()
    let opened = (_: boolean) => {}
    fake.bridge.audioControl = () => new Promise<boolean>(answer => (opened = answer))
    const glasses = new Glasses(new Lifetime(), fake.bridge)
    glasses.draw(frame(box('title', 'Threads')))
    await settle(REBUILD_GAP_MS)
    const opening = glasses.openMic()
    glasses.draw(frame(box('title', 'Threads'), box('body', 'One', { y: 27 })))
    await settle(1_000)
    expect(fake.calls).toEqual(['create'])
    opened(true)
    expect(await opening).toBe(true)
    await settle()
    expect(fake.calls).toEqual(['create', 'rebuild'])
  })
})
