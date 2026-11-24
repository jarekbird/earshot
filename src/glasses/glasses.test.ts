import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifetime } from '../lifetime.js'
import { fakeBridge } from './fake.js'
import type { Box, Frame, Picture } from './frame.js'
import type { Sound } from '../audio.js'
import { HOLD } from './mic.js'
import { FRAME_TAG, Glasses, INPUT_TAG, MIC_SILENT_MS, OVERLAY_DIM, REBUILD_GAP_MS, type Drawing, type ListenOptions } from './glasses.js'
import { PROGRESS } from './frames.js'
import type { Input } from './input.js'
import { textWidth } from './text.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
  const rows = (fake: ReturnType<typeof fakeBridge>) => fake.boxes()[0].text.split('\n')
  const words = (fake: ReturnType<typeof fakeBridge>) => fake.overlay().split('\n').filter(Boolean)

  it('needs no box of its own: it writes in the box that takes the input, so an app keeps seven of the eight', async () => {
    const { fake, glasses } = await drawn()
    expect(fake.boxes().map(({ name }) => name)).toEqual(['input', 'title', 'body'])
    glasses.overlay('Listening')
    await settle()
    expect(words(fake)).toEqual(['Listening'])
    expect(rows(fake).length).toBe(10)
  })

  it('draws a rounded card along the bottom, its words inside the border', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    const card = rows(fake).slice(7)
    expect(card[0]).toMatch(/^ ╭─+╮$/)
    expect(card[1]).toMatch(/^ │ +Listening +│$/)
    expect(card[2]).toMatch(/^ ╰─+╯$/)
    expect(Math.abs(textWidth(card[1]) - textWidth(card[0]))).toBeLessThanOrEqual(textWidth(' '))
    for (const row of card) expect(textWidth(row)).toBeLessThanOrEqual(576)
  })

  it('cuts the page off above the card, so no text of the page runs into it', async () => {
    const { fake, glasses } = setup()
    const reply = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join('\n')
    glasses.draw(frame(box('body', reply, { y: 0, h: 261 }), box('status', 'hold to talk', { y: 261, h: 27 })))
    await settle(REBUILD_GAP_MS)
    glasses.overlay('Listening')
    await settle()
    expect(look(fake).slice(1)).toEqual([
      `body ${OVERLAY_DIM} ${JSON.stringify(['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 7'].join('\n'))}`,
      `status ${OVERLAY_DIM} " "`,
    ])
    glasses.overlay(null)
    await settle()
    expect(look(fake).slice(1)).toEqual([`body 4 ${JSON.stringify(reply)}`, 'status 4 "hold to talk"'])
  })

  it('cuts a long line of the page where the glasses would wrap it', async () => {
    const { fake, glasses } = setup()
    const long = 'word '.repeat(200).trim()
    glasses.draw(frame(box('body', long, { y: 0, h: 288 })))
    await settle(REBUILD_GAP_MS)
    glasses.overlay('Listening')
    await settle()
    const kept = fake.boxes()[1].text.split('\n')
    expect(kept.length).toBe(7)
    for (const line of kept) expect(textWidth(line)).toBeLessThanOrEqual(576)
  })

  it('dims the page in place and writes over it, bright', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('Listening')
    await settle()
    expect(fake.calls).toEqual(['update input', 'update title'])
    expect(look(fake).slice(1)).toEqual([`title ${OVERLAY_DIM} "Threads"`, 'body 0 "One"'])
    expect(fake.boxes()[0].brightness).toBe(4)
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
    expect(words(fake)).toEqual(['Listening'])
    expect(look(fake).slice(1)).toEqual([`title ${OVERLAY_DIM} "Chats"`, 'body 0 "Two"'])
  })

  it('can be shown before anything is drawn', async () => {
    const { fake, glasses } = setup()
    glasses.overlay('Set up voice on your phone')
    await settle()
    expect(words(fake)).toEqual(['Set up voice on your phone'])
  })

  it('grows with its words, three lines at most, split to fit inside the border, the last one cut', async () => {
    const { fake, glasses } = await drawn()
    glasses.overlay('one two three four five six seven eight nine ten '.repeat(8))
    await settle()
    const card = rows(fake).slice(5)
    expect(
      rows(fake)
        .slice(0, 5)
        .every(row => row === ''),
    ).toBe(true)
    expect(card.length).toBe(5)
    expect(card[0]).toMatch(/^ ╭/)
    expect(card[4]).toMatch(/^ ╰/)
    expect(words(fake).length).toBe(3)
    expect(words(fake)[2].endsWith('…')).toBe(true)
    for (const row of card) expect(textWidth(row)).toBeLessThanOrEqual(576)
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

describe('input', () => {
  it('is not handed to a listener put in place while that same input was being handed out, also when it is the same function', async () => {
    const { fake, glasses } = setup()
    const taps: string[] = []
    const confirm = () => void taps.push('confirmed')
    let stop = () => {}
    let replaced = false
    glasses.onInput(() => {
      if (replaced) return
      replaced = true
      stop()
      stop = glasses.onInput(confirm)
    })
    stop = glasses.onInput(confirm)
    glasses.draw(frame(box('title', 'One')))
    await settle()
    fake.tap()
    expect(taps).toEqual([])
    fake.tap()
    expect(taps).toEqual(['confirmed'])
  })

  it('is not handed to a listener that the trace of that same input put in place', () => {
    const fake = fakeBridge()
    const taps: string[] = []
    let placed = false
    const glasses: Glasses = new Glasses(new Lifetime(), fake.bridge, {
      trace: () => {
        if (placed) return
        placed = true
        glasses.onInput(() => void taps.push('heard'))
      },
    })
    fake.tap()
    expect(taps).toEqual([])
    fake.tap()
    expect(taps).toEqual(['heard'])
  })
})

describe('the microphone', () => {
  const listening = (glasses: Glasses, options?: ListenOptions) => {
    const heard: Sound[] = []
    return { heard, stop: glasses.listen(sound => heard.push(sound), options) }
  }
  const holding = (glasses: Glasses) => {
    const heard: Sound[] = []
    const held = glasses[HOLD](
      sound => heard.push(sound),
      () => {},
    )
    held.want(true)
    return { heard, stop: held.letGo }
  }
  const mics = (fake: ReturnType<typeof fakeBridge>) => fake.calls.filter(call => call.startsWith('mic'))

  it('opens on the glasses with the first listener, hands on the sound with who spoke, and closes with the last', async () => {
    const { fake, glasses } = setup()
    const first = listening(glasses)
    const second = listening(glasses)
    await settle()
    expect(fake.mic).toBe('glasses')
    fake.sound(new Uint8Array(320), 'other')
    fake.sound(new Uint8Array(160), 'self')
    fake.sound(new Uint8Array(80))
    first.stop()
    await settle()
    expect(fake.mic).toBe('glasses')
    second.stop()
    await settle()
    expect(fake.mic).toBeNull()
    expect(mics(fake)).toEqual(['mic open', 'mic close'])
    expect(second.heard.map(({ pcm, speaker }) => [pcm.length, speaker])).toEqual([
      [320, 'other'],
      [160, 'self'],
      [80, 'unknown'],
    ])
    expect(first.heard).toEqual(second.heard)
  })

  it('takes a speaker it does not know for unknown', async () => {
    const { fake, glasses } = setup()
    const { heard } = listening(glasses)
    await settle()
    fake.emit({ audioEvent: { audioPcm: new Uint8Array(320), speakerRole: 'narrator' } })
    fake.emit({ audioEvent: { audioPcm: [1, 2] } })
    expect(heard.map(({ pcm, speaker }) => [pcm.length, speaker])).toEqual([
      [320, 'unknown'],
      [2, 'unknown'],
    ])
  })

  it('closes when the last listener left before it had opened', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let open = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (on) await new Promise<void>(opened => (open = opened))
      return answer(on, source)
    }
    const { stop } = listening(glasses)
    await settle()
    stop()
    open()
    await settle()
    expect(fake.mic).toBeNull()
  })

  it('says whether it opened, and keeps trying for as long as something listens', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    fake.refuse('mic', 2)
    const { stop } = listening(glasses)
    await settle()
    expect(told).toEqual([false])
    await settle(500)
    expect(told).toEqual([false, false])
    await settle(1_000)
    expect(told).toEqual([false, false, true])
    expect(fake.mic).toBe('glasses')
    stop()
    await settle()
    expect(told).toEqual([false, false, true, false])
  })

  it('asks at once when another listener joins while it waits to ask again', async () => {
    const { fake, glasses } = setup()
    fake.refuse('mic', 3)
    listening(glasses)
    await settle(500)
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
    listening(glasses)
    await settle()
    expect(mics(fake)).toEqual(['mic open', 'mic open', 'mic open'])
  })

  it('stops trying once nothing listens, and asks for a close in case a refused open began capture', async () => {
    const { fake, glasses } = setup()
    fake.refuse('mic', 5, true)
    const { stop } = listening(glasses)
    await settle()
    void stop()
    await settle(10_000)
    expect(mics(fake)).toEqual(['mic open', 'mic close'])
  })

  it('gives all the sound to a hold, and none of it to the listeners until the hold is over', async () => {
    const { fake, glasses } = setup()
    const session = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(2))
    const command = holding(glasses)
    fake.sound(new Uint8Array(6))
    command.stop()
    fake.sound(new Uint8Array(8))
    await settle()
    expect(session.heard.map(({ pcm }) => pcm.length)).toEqual([2, 8])
    expect(command.heard.map(({ pcm }) => pcm.length)).toEqual([6])
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
  })

  it('asks for the microphone again when the sound stops arriving, as it does when the phone suspends the app', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(2))
    await settle(MIC_SILENT_MS - 1)
    expect(mics(fake)).toEqual(['mic open'])
    await settle(1)
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
    fake.sound(new Uint8Array(4))
    expect(told).toEqual([true, false, true])
    expect(heard.map(({ pcm }) => pcm.length)).toEqual([2, 4])
  })

  it('says so when it does not come back, and keeps asking', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    listening(glasses)
    await settle()
    fake.refuse('mic', 1)
    await settle(MIC_SILENT_MS)
    expect(told).toEqual([true, false, false])
    await settle(500)
    expect(told).toEqual([true, false, false, true])
  })

  it('does not ask again for a hold: that is a recording someone ends', async () => {
    const { fake, glasses } = setup()
    holding(glasses)
    await settle(60_000)
    expect(mics(fake)).toEqual(['mic open'])
  })

  it('starts to watch for lost sound when a lasting listener joins a microphone that is already open', async () => {
    const { fake, glasses } = setup()
    const command = holding(glasses)
    await settle(10_000)
    listening(glasses)
    command.stop()
    await settle(MIC_SILENT_MS - 1)
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
  })

  it('asks for nothing while the sound keeps arriving', async () => {
    const { fake, glasses } = setup()
    listening(glasses)
    await settle()
    for (let second = 0; second < 10; second++) {
      fake.sound(new Uint8Array(2))
      await settle(1_000)
    }
    expect(mics(fake)).toEqual(['mic open'])
  })

  it('closes a microphone it could not get back, when the last listener leaves before the next try', async () => {
    const { fake, glasses } = setup()
    const { stop } = listening(glasses)
    await settle()
    fake.refuse('mic', 1)
    await settle(MIC_SILENT_MS)
    expect(fake.mic).toBe('glasses')
    stop()
    await settle()
    expect(fake.mic).toBeNull()
    expect(mics(fake)).toEqual(['mic open', 'mic open', 'mic close'])
  })

  it('gives a hold the sound also when a listener joins after the hold began', async () => {
    const { fake, glasses } = setup()
    const command = holding(glasses)
    await settle()
    const late = listening(glasses)
    fake.sound(new Uint8Array(2))
    command.stop()
    fake.sound(new Uint8Array(4))
    expect(command.heard.map(({ pcm }) => pcm.length)).toEqual([2])
    expect(late.heard.map(({ pcm }) => pcm.length)).toEqual([4])
  })

  it('gives each listener its own copy of a sound, so one that changes it changes nothing for the others', async () => {
    const { fake, glasses } = setup()
    glasses.listen(sound => {
      sound.pcm.fill(0)
      sound.speaker = 'unknown'
    })
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array([7, 8]), 'other')
    expect(heard.map(({ pcm, speaker }) => [[...pcm], speaker])).toEqual([[[7, 8], 'other']])
  })

  it('lets a listener say after how long without sound to ask again, or never', async () => {
    const recorder = setup()
    recorder.glasses.listen(() => {}, { reopenAfterMs: 1_000 })
    await settle(1_000)
    expect(mics(recorder.fake)).toEqual(['mic open', 'mic open'])
    const patient = setup()
    patient.glasses.listen(() => {}, { reopenAfterMs: false })
    await settle(60_000)
    expect(mics(patient.fake)).toEqual(['mic open'])
  })

  it('asks once as a hold starts to record, and for nothing more while the hold has the microphone', async () => {
    const { fake, glasses } = setup()
    listening(glasses)
    await settle()
    const command = holding(glasses)
    await settle(MIC_SILENT_MS * 3)
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
    command.stop()
    await settle(MIC_SILENT_MS - 1)
    expect(mics(fake)).toEqual(['mic open', 'mic open', 'mic open'])
  })

  it('says whether the microphone is open to whoever asks later', async () => {
    const { fake, glasses } = setup()
    expect(glasses.micOpen).toBe(false)
    const { stop } = listening(glasses)
    await settle()
    expect(glasses.micOpen).toBe(true)
    stop()
    await settle()
    expect(glasses.micOpen).toBe(false)
    fake.refuse('mic', 1)
    listening(glasses)
    await settle()
    expect(glasses.micOpen).toBe(false)
  })

  it('keeps asking, and tells the others, when one who is told throws', async () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const logged = vi.spyOn(console, 'error')
    const { fake, glasses } = setup()
    const told: boolean[] = []
    const failure = new Error('an app failed')
    glasses.onMic(() => {
      throw failure
    })
    glasses.onMic(open => told.push(open))
    fake.refuse('mic', 1)
    listening(glasses)
    await settle(500)
    expect(told).toEqual([false, true])
    expect(fake.mic).toBe('glasses')
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual(
      Array(2).fill('Error: Earshot: a listener of the microphone threw.'),
    )
    expect(logged).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('hands the sound to the others when one who hears it throws', async () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const { fake, glasses } = setup()
    const failure = new Error('an app failed')
    glasses.listen(() => {
      throw failure
    })
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(2))
    expect(heard.map(({ pcm }) => pcm.length)).toEqual([2])
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual(['Error: Earshot: a listener of the microphone threw.'])
    expect(JSON.stringify(reported.mock.calls)).not.toContain(failure.message)
    vi.unstubAllGlobals()
  })

  it('does not tell one who stopped being told while the same news was being told', async () => {
    const { glasses } = setup()
    const told: boolean[] = []
    let stopSecond = () => {}
    glasses.onMic(() => stopSecond())
    stopSecond = glasses.onMic(open => told.push(open))
    listening(glasses)
    await settle()
    expect(told).toEqual([])
  })

  it('says nothing of a refused try to get it back when sound is arriving after all', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    listening(glasses)
    await settle()
    glasses.onMic(open => told.push(open))
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refuse = () => {}
    fake.bridge.audioControl = (on, source) => (on ? new Promise<boolean>(done => (refuse = () => done(false))) : answer(on, source))
    await settle(MIC_SILENT_MS)
    expect(told).toEqual([false])
    fake.sound(new Uint8Array(2))
    expect(glasses.micOpen).toBe(true)
    refuse()
    await settle()
    expect(told).toEqual([false, true])
  })

  it('goes by a new listener at once when it wants the microphone back sooner than the others', async () => {
    const { fake, glasses } = setup()
    glasses.listen(() => {}, { reopenAfterMs: 10_000 })
    await settle(100)
    glasses.listen(() => {}, { reopenAfterMs: 500 })
    await settle(500)
    expect(mics(fake)).toEqual(['mic open', 'mic open'])
  })

  it('opens for a new listener only after a close that was on its way has been answered', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let closed = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (!on) await new Promise<void>(done => (closed = done))
      return answer(on, source)
    }
    const first = listening(glasses)
    await settle()
    first.stop()
    listening(glasses, { reopenAfterMs: false })
    await settle()
    closed()
    await settle()
    expect(fake.mic).toBe('glasses')
    expect(glasses.micOpen).toBe(true)
    expect(mics(fake)).toEqual(['mic open', 'mic close', 'mic open'])
  })

  it('asks again to close a microphone that would not close', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refusals = 1
    fake.bridge.audioControl = async (on, source) => {
      if (!on && refusals-- > 0) throw new Error('The close did not go through.')
      return answer(on, source)
    }
    const { stop } = listening(glasses)
    await settle()
    stop()
    await settle()
    expect(fake.mic).toBe('glasses')
    expect(glasses.micOpen).toBe(true)
    await settle(500)
    expect(fake.mic).toBeNull()
    expect(glasses.micOpen).toBe(false)
  })

  it('still closes the microphone when its lifetime ends and the first close is refused', async () => {
    const { life, fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refusals = 1
    fake.bridge.audioControl = async (on, source) => {
      if (!on && refusals-- > 0) throw new Error('The close did not go through.')
      return answer(on, source)
    }
    listening(glasses)
    await settle()
    life.end()
    await settle()
    expect(fake.mic).toBe('glasses')
    await settle(500)
    expect(fake.mic).toBeNull()
  })

  it('hands a sound to nobody else once a hold began while it was being handed out', async () => {
    const { fake, glasses } = setup()
    glasses.listen(
      () =>
        void glasses[HOLD](
          () => {},
          () => {},
        ),
    )
    const second = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(2))
    expect(second.heard).toEqual([])
  })

  it('logs that a listener threw, and not what, where the page has no error reporting', async () => {
    vi.stubGlobal('reportError', undefined)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, glasses } = setup()
    const carried = new Uint8Array([1, 2, 3])
    glasses.listen(sound => {
      throw Object.assign(new Error('what was said'), { pcm: sound.pcm, name: 'what was said' })
    })
    await settle()
    fake.sound(carried)
    expect(logged.mock.calls).toEqual([['Earshot: a listener of the microphone threw.']])
    vi.unstubAllGlobals()
  })

  it('tells each one the news in the order it happened, also when one of them changes it', async () => {
    const { glasses } = setup()
    const told: boolean[] = []
    let stop = () => {}
    glasses.onMic(open => void (open && stop()))
    glasses.onMic(open => told.push(open))
    stop = listening(glasses).stop
    await settle()
    expect(told).toEqual([true, false])
    expect(glasses.micOpen).toBe(false)
  })

  it('says nothing of a microphone that opened only after the last listener had left', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let open = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (on) await new Promise<void>(opened => (open = opened))
      return answer(on, source)
    }
    const { stop } = listening(glasses)
    await settle()
    stop()
    open()
    await settle()
    expect(told).toEqual([])
    expect(fake.mic).toBeNull()
  })

  it('takes the microphone for open when sound arrives, also when the first try to open it is then refused', async () => {
    const { fake, glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    let refuse = () => {}
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    fake.bridge.audioControl = (on, source) => (on ? new Promise<boolean>(done => (refuse = () => done(false))) : answer(on, source))
    const { heard, stop } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(2))
    refuse()
    await settle()
    expect(heard.length).toBe(1)
    expect(told).toEqual([true])
    expect(glasses.micOpen).toBe(true)
    stop()
    await settle()
    expect(mics(fake)).toEqual(['mic close'])
  })

  it('refuses a time to ask again that is not half a second or more', async () => {
    const { fake, glasses } = setup()
    for (const reopenAfterMs of [0, -1, 499, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => glasses.listen(() => {}, { reopenAfterMs })).toThrow(RangeError)
    await settle()
    expect(mics(fake)).toEqual([])
  })

  it('gives up closing a microphone that will not close once its lifetime has ended, after five tries', async () => {
    const { life, fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    fake.bridge.audioControl = async (on, source) => {
      if (on) return answer(on, source)
      fake.calls.push('mic close')
      throw new Error('The close did not go through.')
    }
    listening(glasses)
    await settle()
    life.end()
    await settle(60_000)
    expect(mics(fake)).toEqual(['mic open', ...Array<string>(5).fill('mic close')])
  })

  it('says the microphone is closed once a close is answered, whatever arrived while it was on its way', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let closed = () => {}
    let refuseOpens = false
    fake.bridge.audioControl = async (on, source) => {
      if (!on) await new Promise<void>(done => (closed = done))
      return on && refuseOpens ? false : answer(on, source)
    }
    const first = listening(glasses)
    await settle()
    first.stop()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    listening(glasses)
    fake.sound(new Uint8Array(2))
    refuseOpens = true
    closed()
    await settle()
    expect(fake.mic).toBeNull()
    expect(glasses.micOpen).toBe(false)
    expect(told).toEqual([false, false])
  })

  it('hands a sound that came during a hold to no listener, also when the news of it ends the hold', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let open = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (on) await new Promise<void>(opened => (open = opened))
      return answer(on, source)
    }
    const session = listening(glasses)
    const command = holding(glasses)
    glasses.onMic(isOpen => void (isOpen && command.stop()))
    await settle()
    fake.sound(new Uint8Array(2))
    open()
    await settle()
    expect(session.heard).toEqual([])
    expect(command.heard.map(({ pcm }) => pcm.length)).toEqual([2])
  })

  it('closes a microphone that proved to be on after the last listener left and the open was refused', async () => {
    const { fake, glasses } = setup()
    let refuse = () => {}
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    fake.bridge.audioControl = (on, source) => (on ? new Promise<boolean>(done => (refuse = () => done(false))) : answer(on, source))
    const { heard, stop } = listening(glasses)
    await settle()
    stop()
    fake.sound(new Uint8Array(2))
    refuse()
    await settle()
    expect(heard).toEqual([])
    expect(mics(fake)).toEqual(['mic close'])
  })

  it('leaves alone a microphone it never asked for: an app that opened one itself keeps it', async () => {
    const { fake, glasses } = setup()
    glasses.onMic(() => {})
    fake.sound(new Uint8Array(2))
    await settle(10_000)
    expect(mics(fake)).toEqual([])
    expect(glasses.micOpen).toBe(false)
  })

  it('gives each listener bytes of its own, also when the sound came as a view on shared memory', async () => {
    const { fake, glasses } = setup()
    glasses.listen(sound => void sound.pcm.fill(0))
    const { heard } = listening(glasses)
    await settle()
    fake.sound(Buffer.from([42]))
    expect([...heard[0].pcm]).toEqual([42])
  })

  it('keeps telling one who asked twice with the same function, when one of the two stops', async () => {
    const { glasses } = setup()
    const told: boolean[] = []
    const badge = (open: boolean) => void told.push(open)
    const first = glasses.onMic(badge)
    glasses.onMic(badge)
    first()
    listening(glasses)
    await settle()
    expect(told).toEqual([true])
  })

  it('still asks for a close at the end, when tries to get the microphone back had been refused before it', async () => {
    const { life, fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refuse = false
    let pending = () => {}
    let hang = false
    fake.bridge.audioControl = (on, source) => {
      if (on && hang) return new Promise<boolean>(done => (pending = () => done(false)))
      return on && refuse ? (fake.calls.push('mic open'), Promise.resolve(false)) : answer(on, source)
    }
    listening(glasses)
    await settle()
    refuse = true
    await settle(MIC_SILENT_MS + 500 + 1_000 + 2_000)
    hang = true
    await settle(4_000)
    life.end()
    pending()
    await settle(60_000)
    expect(fake.mic).toBeNull()
  })

  it('asks for a close at the end when an open was still unanswered, since capture may have begun', async () => {
    const { life, fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refuse = () => {}
    fake.bridge.audioControl = (on, source) => {
      if (!on) return answer(on, source)
      fake.mic = 'glasses'
      return new Promise<boolean>(done => (refuse = () => done(false)))
    }
    listening(glasses)
    await settle()
    life.end()
    refuse()
    await settle()
    expect(fake.mic).toBeNull()
  })

  it('marks the first sound a listener hears, and the first after a break: a hold, or the microphone asked for again', async () => {
    const { fake, glasses } = setup()
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(1))
    fake.sound(new Uint8Array(2))
    const command = holding(glasses)
    fake.sound(new Uint8Array(3))
    command.stop()
    fake.sound(new Uint8Array(4))
    fake.sound(new Uint8Array(5))
    await settle(MIC_SILENT_MS)
    fake.sound(new Uint8Array(6))
    expect(heard.map(({ pcm, gap }) => [pcm.length, gap])).toEqual([
      [1, true],
      [2, false],
      [4, true],
      [5, false],
      [6, true],
    ])
    expect(command.heard.map(({ gap }) => gap)).toEqual([true])
  })

  it('marks the first sound after the microphone was closed and opened again, also for one who heard its last sounds', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let closed = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (!on) await new Promise<void>(done => (closed = done))
      return answer(on, source)
    }
    const first = listening(glasses)
    await settle()
    void first.stop()
    const { heard } = listening(glasses)
    fake.sound(new Uint8Array(1))
    closed()
    await settle()
    fake.sound(new Uint8Array(2))
    expect(heard.map(({ pcm, gap }) => [pcm.length, gap])).toEqual([
      [1, true],
      [2, true],
    ])
  })

  it('reports the fixed sentence, and not the error, when a listener written to wait fails after its wait', async () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const { fake, glasses } = setup()
    glasses.listen(async sound => {
      await Promise.resolve()
      throw Object.assign(new Error('what was said'), { pcm: sound.pcm })
    })
    glasses.onMic(async () => {
      await Promise.resolve()
      throw new Error('what was said')
    })
    await settle()
    fake.sound(new Uint8Array(2))
    await settle()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual(
      Array(2).fill('Error: Earshot: a listener of the microphone threw.'),
    )
  })

  it('asks for a close when an open is refused after the last listener left, without waiting for sound to prove it on', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refuse = () => {}
    fake.bridge.audioControl = (on, source) => {
      if (!on) return answer(on, source)
      fake.mic = 'glasses'
      return new Promise<boolean>(done => (refuse = () => done(false)))
    }
    const { stop } = listening(glasses)
    await settle()
    void stop()
    refuse()
    await settle()
    expect(fake.mic).toBeNull()
  })

  it('lets one who stopped listening wait until the microphone is closed, to open one of its own', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refusals = 1
    fake.bridge.audioControl = async (on, source) => {
      if (!on && refusals-- > 0) throw new Error('The close did not go through.')
      return answer(on, source)
    }
    const { stop } = listening(glasses)
    await settle()
    let closed = false
    void stop().then(() => (closed = fake.mic === null))
    await settle()
    expect(closed).toBe(false)
    await settle(500)
    expect(closed).toBe(true)
  })

  it('leaves alone a microphone the app opens itself after it stopped listening and waited, though an open had been refused', async () => {
    const { fake, glasses } = setup()
    fake.refuse('mic', 1)
    const { stop } = listening(glasses)
    await settle()
    expect(await stop()).toBe(true)
    const before = mics(fake).length
    fake.mic = 'phone'
    fake.sound(new Uint8Array(2))
    await settle(10_000)
    expect(mics(fake).slice(before)).toEqual([])
    expect(fake.mic).toBe('phone')
  })

  it('asks for a close when the last listener leaves while a refused open waits to be asked again, since capture may have begun', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let refuse = true
    fake.bridge.audioControl = async (on, source) => {
      if (!on || !refuse) return answer(on, source)
      fake.mic = 'glasses'
      return false
    }
    const { stop } = listening(glasses)
    await settle()
    refuse = false
    expect(await stop()).toBe(true)
    expect(fake.mic).toBeNull()
  })

  it('keeps its word to one who stopped listening from inside the news: the promise waits for the close', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let closed = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (!on) await new Promise<void>(done => (closed = done))
      return answer(on, source)
    }
    let settled = false
    const { stop } = listening(glasses)
    glasses.onMic(open => {
      if (!open) void stop().then(() => (settled = true))
    })
    await settle(MIC_SILENT_MS)
    expect(settled).toBe(false)
    closed()
    await settle()
    expect(settled).toBe(true)
    expect(fake.mic).toBeNull()
  })

  it('says it could not close the microphone, to one who waits, when it gave up at the end', async () => {
    const { life, fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    fake.bridge.audioControl = async (on, source) => {
      if (on) return answer(on, source)
      throw new Error('The close did not go through.')
    }
    const { stop } = listening(glasses)
    await settle()
    const closed = stop()
    life.end()
    await settle(60_000)
    expect(await closed).toBe(false)
  })

  it('marks the first sound after it asked for the microphone again, once, also when that sound comes before the answer', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let opened = () => {}
    let hang = false
    fake.bridge.audioControl = async (on, source) => {
      if (on && hang) await new Promise<void>(done => (opened = done))
      return answer(on, source)
    }
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(1))
    hang = true
    await settle(MIC_SILENT_MS)
    fake.sound(new Uint8Array(2))
    opened()
    await settle()
    fake.sound(new Uint8Array(3))
    expect(heard.map(({ pcm, gap }) => [pcm.length, gap])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ])
  })

  it('reports the fixed sentence when what a listener gives back only looks like a promise and fails', async () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const { fake, glasses } = setup()
    glasses.listen(() => ({ then: (_: unknown, failed: (error: Error) => void) => failed(new Error('what was said')) }))
    await settle()
    fake.sound(new Uint8Array(2))
    await settle()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual(['Error: Earshot: a listener of the microphone threw.'])
  })

  it('marks the first sound after a hold also when nothing was heard during it', async () => {
    const { fake, glasses } = setup()
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(1))
    holding(glasses).stop()
    fake.sound(new Uint8Array(2))
    expect(heard.map(({ pcm, gap }) => [pcm.length, gap])).toEqual([
      [1, true],
      [2, true],
    ])
  })

  it('keeps its word to one who stopped when others, told the news, stop again and start anew: it waits for all of it', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let opened = () => {}
    let hang = false
    fake.bridge.audioControl = async (on, source) => {
      if (on && hang) await new Promise<void>(done => (opened = done))
      return answer(on, source)
    }
    const { stop } = listening(glasses)
    await settle()
    hang = true
    let again = false
    glasses.onMic(open => void (open || again || ((again = true), void stop())))
    glasses.onMic(open => void (open || glasses.listen(() => {})))
    let settledWhile: string | null | undefined
    void stop().then(() => (settledWhile = fake.mic))
    await settle()
    expect(settledWhile).toBeUndefined()
    opened()
    await settle()
    expect(settledWhile).toBe('glasses')
  })

  it('asks no second time for a hold that was over before the first answer came, and marks no break for it', async () => {
    const { fake, glasses } = setup()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let opened = () => {}
    let opens = 0
    fake.bridge.audioControl = async (on, source) => {
      if (on && ++opens) await new Promise<void>(done => (opened = done))
      return answer(on, source)
    }
    const { heard } = listening(glasses)
    await settle()
    fake.sound(new Uint8Array(1))
    holding(glasses).stop()
    fake.sound(new Uint8Array(2))
    opened()
    await settle()
    fake.sound(new Uint8Array(3))
    expect(heard.map(({ pcm, gap }) => [pcm.length, gap])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ])
    expect(opens).toBe(1)
  })

  it('refuses a time to ask again of more than a day, which no timer could keep', () => {
    const { glasses } = setup()
    expect(() => glasses.listen(() => {}, { reopenAfterMs: 86_400_001 })).toThrow(RangeError)
    expect(() => glasses.listen(() => {}, { reopenAfterMs: 86_400_000 })).not.toThrow()
  })

  it('tells of the close when the last listener leaves', async () => {
    const { glasses } = setup()
    const told: boolean[] = []
    glasses.onMic(open => told.push(open))
    const { stop } = listening(glasses)
    await settle()
    stop()
    await settle()
    expect(told).toEqual([true, false])
  })

  it('takes a speaker named like something every object has for unknown', async () => {
    const { fake, glasses } = setup()
    const { heard } = listening(glasses)
    await settle()
    fake.emit({ audioEvent: { audioPcm: new Uint8Array(2), speakerRole: 'constructor' } })
    expect(heard.map(({ speaker }) => speaker)).toEqual(['unknown'])
  })

  it('hands no sound to a listener that another stopped while the same sound was being handed out', async () => {
    const { fake, glasses } = setup()
    let stopSecond = () => {}
    glasses.listen(() => stopSecond())
    const second = listening(glasses)
    stopSecond = second.stop
    await settle()
    fake.sound(new Uint8Array(2))
    expect(second.heard).toEqual([])
  })

  it('stops handing sound to a listener that left, and sound is not input', async () => {
    const { fake, glasses } = setup()
    const inputs: Input[] = []
    glasses.onInput(input => inputs.push(input))
    const { heard, stop } = listening(glasses)
    await settle()
    stop()
    fake.sound(new Uint8Array(320))
    expect(heard).toEqual([])
    expect(inputs).toEqual([])
  })

  it('closes when the lifetime ends with it open, and listens to nothing after', async () => {
    const { life, fake, glasses } = setup()
    listening(glasses)
    await settle()
    life.end()
    await settle()
    expect(fake.mic).toBeNull()
    const late = listening(glasses)
    await settle(10_000)
    fake.sound(new Uint8Array(2))
    expect(late.heard).toEqual([])
    expect(mics(fake)).toEqual(['mic open', 'mic close'])
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
    expect(traced.length).toBe(1)
    const { lines, menu } = JSON.parse(traced[0].slice(FRAME_TAG.length))
    expect(lines[0]).toBe('Threads')
    expect(lines.slice(1).map((line: string) => line.replace(/[╭╮╰╯─│]/g, '').trim())).toEqual(['', 'Listening', ''])
    expect(menu).toEqual(['Refresh'])
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
    expect(fake.lines()[0]).toBe('Deploys')
    expect(fake.lines().some(line => / Listening /.test(line))).toBe(true)
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

  it('says how far it is with the frames asked of it: the one shown, and the one on its way that a newer one waits behind', async () => {
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge)
    glasses.draw(frame(box('title', 'One')))
    await settle()
    expect([glasses[PROGRESS].shown, glasses[PROGRESS].sending]).toEqual([1, 0])
    let release = () => {}
    const waiting = new Promise<void>(go => (release = go))
    const real = fake.bridge.textContainerUpgrade
    fake.bridge.textContainerUpgrade = async upgrade => {
      await waiting
      return real(upgrade)
    }
    glasses.draw(frame(box('title', 'Two')))
    await settle(0)
    glasses.draw(frame(box('title', 'Three')))
    glasses.draw(frame(box('title', 'Four')))
    expect([glasses[PROGRESS].shown, glasses[PROGRESS].sending]).toEqual([1, 2])
    release()
    await settle()
    expect([glasses[PROGRESS].shown, glasses[PROGRESS].sending]).toEqual([4, 0])
  })

  it('has said which frame is on its way, and which is shown, before it tells whoever watches of the begin and the end', async () => {
    const seen: Array<[string, number, number]> = []
    const glasses: Glasses = new Glasses(new Lifetime(), fakeBridge().bridge, {
      watch: event => {
        if (event.at === 'begin' || event.at === 'end') seen.push([event.at, glasses[PROGRESS].sending, glasses[PROGRESS].shown])
      },
    })
    glasses.draw(frame(box('title', 'One')))
    await settle()
    expect(seen).toEqual([
      ['begin', 1, 0],
      ['end', 0, 1],
    ])
  })

  it('gives each draw its own number, also one asked for from inside the telling of another', () => {
    let nested = 0
    const glasses: Glasses = new Glasses(new Lifetime(), fakeBridge().bridge, {
      watch: event => {
        if (event.at === 'ask' && event.frame === 1) nested = glasses.draw(frame(box('title', 'Inner')))
      },
    })
    expect([glasses.draw(frame(box('title', 'Outer'))), nested]).toEqual([1, 2])
  })

  it('draws the newer of two frames when the second was asked for from inside the telling of the first', async () => {
    const fake = fakeBridge()
    const glasses: Glasses = new Glasses(new Lifetime(), fake.bridge, {
      watch: event => {
        if (event.at === 'ask' && event.frame === 1) glasses.draw(frame(box('title', 'Inner')))
      },
    })
    glasses.draw(frame(box('title', 'Outer')))
    await settle()
    expect(fake.lines()).toEqual(['Inner'])
    expect(glasses.shown).toBe(2)
  })

  it('does not count a frame as shown when its lifetime ended while the glasses were still taking it', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    let answer = () => {}
    const waiting = new Promise<void>(go => (answer = go))
    const real = fake.bridge.createStartUpPageContainer
    fake.bridge.createStartUpPageContainer = async page => {
      await waiting
      return real(page)
    }
    glasses.draw(frame(box('title', 'One')))
    await settle(0)
    life.end()
    answer()
    await settle()
    expect(glasses.shown).toBe(0)
  })

  it('tells whoever follows its progress each time a frame is on its way or on the glasses', async () => {
    const glasses = new Glasses(new Lifetime(), fakeBridge().bridge)
    const seen: Array<[number, number]> = []
    glasses[PROGRESS].onChange(() => void seen.push([glasses[PROGRESS].sending, glasses[PROGRESS].shown]))
    glasses.draw(frame(box('title', 'One')))
    await settle()
    expect(seen).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ])
  })

  it('knows which frame a box of text is from, also when another box of the same frame was refused', async () => {
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge)
    glasses.draw(frame(box('title', 'One'), box('body', 'first')))
    await settle()
    fake.refuse('update', 1)
    glasses.draw(frame(box('title', 'Two'), box('body', 'second')))
    await settle(0)
    expect(glasses.shown).toBe(1)
    expect([glasses[PROGRESS].has('title'), glasses[PROGRESS].has('body')]).toEqual([1, 2])
  })

  it('has noted which frame a box of text is from before it tells whoever watches of the answer', async () => {
    const seen: number[] = []
    const glasses: Glasses = new Glasses(new Lifetime(), fakeBridge().bridge, {
      watch: event => {
        if (event.at === 'answer' && event.op === 'update' && event.ok) seen.push(glasses[PROGRESS].has('title'))
      },
    })
    glasses.draw(frame(box('title', 'One')))
    await settle()
    glasses.draw(frame(box('title', 'Two')))
    await settle()
    expect(seen).toEqual([2])
  })

  it('forgets which frame a box was from once a rebuilt page no longer has that box', async () => {
    const glasses = new Glasses(new Lifetime(), fakeBridge().bridge)
    glasses.draw(frame(box('old', 'One')))
    await settle()
    glasses.draw(frame(box('new', 'Two')))
    await settle(1_000)
    expect([glasses[PROGRESS].has('old'), glasses[PROGRESS].has('new')]).toEqual([0, 2])
  })

  it('says which frame the menu on the glasses is from as soon as the page is built, though a picture of it is still refused', async () => {
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge)
    glasses.draw(frame(box('title', 'One')))
    await settle()
    fake.refuse('picture', 100)
    const icon = { id: 'icon', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }
    glasses.draw({ ...frame(box('title', 'Two')), menu: [{ id: 1, name: 'Open' }], pictures: [icon] })
    await settle(400)
    expect([glasses.shown, glasses[PROGRESS].menu]).toEqual([1, 2])
  })

  it('tells nothing of its progress, and leaves no frame as being sent, once its lifetime has ended', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    glasses.draw(frame(box('title', 'One')))
    await settle()
    let answer = () => {}
    const waiting = new Promise<void>(go => (answer = go))
    const real = fake.bridge.textContainerUpgrade
    fake.bridge.textContainerUpgrade = async upgrade => (await waiting, real(upgrade))
    glasses.draw(frame(box('title', 'Two')))
    await settle(0)
    let told = 0
    glasses[PROGRESS].onChange(() => void told++)
    life.end()
    answer()
    await settle()
    expect([told, glasses[PROGRESS].sending]).toEqual([0, 0])
  })

  it('sends no picture, and counts no frame as being sent, when the page was taken only after its lifetime ended', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    let answer = () => {}
    const waiting = new Promise<void>(go => (answer = go))
    const real = fake.bridge.createStartUpPageContainer
    fake.bridge.createStartUpPageContainer = async page => (await waiting, real(page))
    const icon = { id: 'icon', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }
    glasses.draw({ ...frame(box('title', 'One')), pictures: [icon] })
    await settle(0)
    life.end()
    expect(glasses[PROGRESS].sending).toBe(0)
    answer()
    await settle()
    expect(fake.calls.filter(call => call.includes('picture'))).toEqual([])
  })

  it('sends no picture when its lifetime ends between the page being taken and the picture going out', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge, {
      watch: event => {
        if (event.at === 'answer' && event.op === 'create') queueMicrotask(() => queueMicrotask(() => life.end()))
      },
    })
    const icon = { id: 'icon', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }
    glasses.draw({ ...frame(box('title', 'One')), pictures: [icon] })
    await settle()
    expect(fake.calls.filter(call => call.includes('picture'))).toEqual([])
  })

  it('makes no call that its lifetime ended just before, as whoever watches was told of it', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge, {
      watch: event => {
        if (event.at === 'call' && event.op === 'picture') life.end()
      },
    })
    const icon = { id: 'icon', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }
    glasses.draw({ ...frame(box('title', 'One')), pictures: [icon] })
    await settle()
    expect(fake.calls.filter(call => call.includes('picture'))).toEqual([])
  })

  it('lets a frame that was taken back leave what the glasses show, however many frames were asked for before it', async () => {
    const fake = fakeBridge()
    const glasses = new Glasses(new Lifetime(), fake.bridge)
    glasses.draw(frame(box('title', 'Shown')))
    await settle()
    glasses.draw(frame(box('title', 'Stale')))
    const newest = glasses.draw(frame(box('title', 'Newest')))
    glasses[PROGRESS].drop(newest)
    glasses.overlay('Status')
    glasses.overlay(null)
    await settle()
    expect(fake.lines()).toEqual(['Shown'])
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
    let open = () => {}
    fake.bridge.audioControl = () => new Promise<boolean>(opened => (open = () => opened(true)))
    glasses.listen(() => {})
    await settle()
    fake.calls.length = 0
    seen.length = 0
    return { fake, glasses, seen, open }
  }

  it('starts no rebuild, since the Even app answers one call at a time and a rebuild would hold the microphone back', async () => {
    const { fake, glasses, seen, open } = await held()
    glasses.draw({ boxes: [box('title', 'Threads'), box('body', 'One', { y: 27 })], menu: [{ id: 1, name: 'Refresh' }] })
    await settle(2_000)
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
})

describe('a call an app makes to the Even app itself', () => {
  it('holds rebuilds back until it is answered, when the app says so', async () => {
    const { fake, glasses } = setup()
    glasses.draw(frame(box('title', 'Threads')))
    await settle(REBUILD_GAP_MS)
    let answered = () => {}
    glasses.holdRebuilds(new Promise<void>(done => (answered = done)))
    glasses.draw(frame(box('title', 'Threads'), box('body', 'One', { y: 27 })))
    await settle(1_000)
    expect(fake.calls).toEqual(['create'])
    answered()
    await settle()
    expect(fake.calls).toEqual(['create', 'rebuild'])
  })
})
