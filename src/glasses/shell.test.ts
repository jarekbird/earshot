import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action, type Action } from '../action.js'
import { Lifetime } from '../lifetime.js'
import { matchWords } from '../navigator.js'
import { Rolling } from '../rolling.js'
import { Router, type Screen } from '../router.js'
import { boxes, list, text } from '../view.js'
import { fakeBridge } from './fake.js'
import { Glasses, OVERLAY_DIM } from './glasses.js'
import { SayError } from '../say.js'
import { Shell, type VoiceOptions } from './shell.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = async (ms = 400) => void (await vi.advanceTimersByTimeAsync(ms))
const names = ['Ana', 'Ben', 'Cy']
const tone = (ms: number, loudness = 8_000) => {
  const samples = new Int16Array((16_000 * ms) / 1000)
  for (let at = 0; at < samples.length; at++) samples[at] = Math.round(loudness * Math.sin(at / 5))
  return new Uint8Array(samples.buffer)
}

function world(more: { home?: (parts: Parts) => Screen; appActions?: () => Action[]; voice?: VoiceOptions } = {}) {
  const ran: string[] = []
  const life = new Lifetime()
  const fake = fakeBridge()
  const glasses = new Glasses(life, fake.bridge)
  const people = [...names]
  const open: Action = action({
    id: 'open',
    say: 'Open',
    targets: () => people.map(name => ({ id: name.toLowerCase(), say: name, value: name })),
    run: name => {
      ran.push(`open ${name}`)
      router.open({ id: 'person', view: () => text({ title: name, body: Array.from({ length: 30 }, (_, n) => `Line ${n}`).join('\n') }) })
    },
  })
  const refresh = action({ id: 'refresh', say: 'Refresh', run: () => void ran.push('refresh') })
  const rolling = new Rolling(life)
  for (const name of people) rolling.add(open, name.toLowerCase())
  const parts: Parts = { open, refresh, ran, people, rolling }
  const home = more.home?.(parts) ?? { id: 'people', actions: () => [open, refresh], view: () => list({ title: 'People', action: open }) }
  const router: Router = new Router({ home, actions: more.appActions })
  if (more.voice) more.voice.rolling ??= rolling
  const shell = new Shell(life, glasses, router, { voice: more.voice })
  const menu = () => fake.menuItems().map(item => item.name)
  const front = () => fake.overlay()
  const cursor = () =>
    fake
      .boxes()
      .find(box => box.name === 'cursor')
      ?.text.trim()
  return { ...parts, life, fake, glasses, router, shell, menu, front, cursor }
}

interface Parts {
  open: Action
  refresh: Action
  ran: string[]
  people: string[]
  rolling: Rolling
}

describe('drawing', () => {
  it('draws the list of the current screen, with the cursor on the first item', async () => {
    const { fake, cursor } = world()
    await settle()
    expect(fake.lines()).toEqual(['People', '> Ana', 'Ben', 'Cy'])
    expect(cursor()).toBe('Ana')
  })

  it('draws the next screen when the router moves, and the last one on the way back', async () => {
    const { fake, router } = world()
    await settle()
    router.open({ id: 'about', view: () => text({ title: 'About', body: 'Earshot' }) })
    await settle()
    expect(fake.lines()).toEqual(['About', 'Earshot'])
    router.back()
    await settle()
    expect(fake.lines()[0]).toBe('People')
  })

  it('draws again when asked, with what the app has now', async () => {
    const { fake, shell, people } = world()
    await settle()
    people.push('Di')
    shell.redraw()
    await settle()
    expect(fake.lines()).toContain('Di')
  })

  it('lists the actions of a screen that has no view of its own', async () => {
    const { fake, menu, ran } = world({ home: ({ refresh }) => ({ id: 'bare', actions: () => [refresh] }) })
    await settle()
    expect(fake.lines()).toEqual(['> Refresh', 'Go back', 'Go home'])
    expect(menu()).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual(['refresh'])
  })

  it('stops with its lifetime', async () => {
    const { fake, life, router } = world()
    await settle()
    life.end()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    fake.down()
    await settle()
    expect(fake.lines()[0]).toBe('People')
  })
})

describe('a list', () => {
  it('moves the cursor with a swipe, in place, and stops at each end', async () => {
    const { fake, cursor } = world()
    await settle()
    fake.calls.length = 0
    fake.down()
    await settle()
    expect(cursor()).toBe('Ben')
    fake.down()
    fake.down()
    fake.down()
    await settle()
    expect(cursor()).toBe('Cy')
    fake.up()
    fake.up()
    fake.up()
    await settle()
    expect(cursor()).toBe('Ana')
    expect(fake.calls.filter(call => call === 'rebuild')).toEqual([])
  })

  it('runs its action on the item under the cursor with a tap', async () => {
    const { fake, ran } = world()
    await settle()
    fake.down()
    fake.tap()
    await settle()
    expect(ran).toEqual(['open Ben'])
    expect(fake.lines()[0]).toBe('Ben  ▼')
  })

  it('finds the cursor where it was left on the way back', async () => {
    const { fake, cursor } = world()
    await settle()
    fake.down()
    fake.down()
    fake.tap()
    await settle()
    fake.double()
    await settle()
    expect(cursor()).toBe('Cy')
  })

  it('does nothing on a tap when it is empty', async () => {
    const { fake, people, shell, ran } = world()
    people.length = 0
    shell.redraw()
    await settle()
    fake.tap()
    await settle()
    expect(ran).toEqual([])
    expect(fake.lines()).toEqual(['People', 'Nothing here'])
  })
})

describe('a text screen', () => {
  it('scrolls two lines with each swipe', async () => {
    const { fake } = world()
    await settle()
    fake.tap()
    await settle()
    const first = () =>
      fake
        .boxes()
        .find(box => box.name === 'body')!
        .text.split('\n')[0]
    expect(first()).toBe('Line 0')
    fake.down()
    await settle()
    expect(first()).toBe('Line 2')
    fake.up()
    fake.up()
    await settle()
    expect(first()).toBe('Line 0')
  })
})

describe('a screen of boxes', () => {
  const custom = (more: { blocked?: () => string | null } = {}) => {
    const made = world({
      home: ({ ran, refresh, open }) => {
        const count = action({ id: 'count', say: 'Count', run: () => void ran.push('count') })
        const older = action({ id: 'older', say: 'Older', blocked: more.blocked, run: () => void ran.push('older') })
        return {
          id: 'custom',
          actions: () => [refresh],
          view: () =>
            boxes([{ id: 'only', x: 0, y: 0, w: 576, h: 27, text: 'Custom' }], {
              on: { tap: count, up: older, down: { action: open, target: 'ben' } },
              pictures: [{ id: 'chart', x: 300, y: 54, w: 200, h: 100, key: 'a', data: new Uint8Array([7]) }],
            }),
        }
      },
      voice: { transcribe: async () => 'count' },
    })
    return made
  }

  it('draws the boxes and the pictures', async () => {
    const { fake } = custom()
    await settle()
    expect(fake.lines()).toEqual(['Custom'])
    expect(fake.pictures()).toEqual([{ name: 'chart', x: 300, y: 54, w: 200, h: 100, data: [7] }])
  })

  it('E9: runs the action the screen bound to a tap or a swipe, on its target when it has one', async () => {
    const { fake, ran } = custom()
    await settle()
    fake.tap()
    fake.up()
    fake.down()
    await settle()
    expect(ran).toEqual(['count', 'older', 'open Ben'])
  })

  it('says why when the action bound to a gesture cannot run', async () => {
    const { fake, ran, front } = custom({ blocked: () => 'Nothing older' })
    await settle()
    fake.up()
    await settle()
    expect(ran).toEqual([])
    expect(front()).toBe('Nothing older')
  })

  it("E9: keeps what a gesture runs out of Even's menu, and offers it to voice", async () => {
    const { fake, ran, menu } = custom()
    await settle()
    expect(menu()).toEqual(['Refresh', 'Go back', 'Go home'])
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle()
    expect(ran).toEqual(['count'])
  })
})

describe('a double tap', () => {
  it('goes back, and from the home screen asks Even to close the app', async () => {
    const { fake, router } = world()
    await settle()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    fake.double()
    expect(router.depth).toBe(1)
    expect(fake.exits).toEqual([])
    fake.double()
    await settle()
    expect(fake.exits).toEqual([1])
  })
})

describe("Even's menu", () => {
  it("lists the screen's and the app's other actions, without the one a tap runs", async () => {
    const about = action({ id: 'about', say: 'About', run: () => {} })
    const { menu } = world({ appActions: () => [about] })
    await settle()
    expect(menu()).toEqual(['Refresh', 'About', 'Go back', 'Go home'])
  })

  it('runs the action that is picked', async () => {
    const { fake, ran } = world()
    await settle()
    fake.pick('Refresh')
    await settle()
    expect(ran).toEqual(['refresh'])
  })

  it('asks which one when the picked action needs a target, then runs it on the one tapped', async () => {
    const { fake, ran, router, cursor } = world({
      home: ({ open, refresh }) => ({ id: 'plain', actions: () => [open, refresh], view: () => text({ title: 'Home', body: 'Hello' }) }),
    })
    await settle()
    fake.pick('Open')
    await settle()
    expect(fake.lines()).toEqual(['Open', '> Ana', 'Ben', 'Cy'])
    fake.down()
    await settle()
    expect(cursor()).toBe('Ben')
    fake.tap()
    await settle()
    expect(ran).toEqual(['open Ben'])
    expect(router.depth).toBe(2)
    expect(router.current.id).toBe('person')
  })

  it('keeps the same number for an action on every screen, so a pick from an old menu cannot run another', async () => {
    const { fake, router, ran, front } = world()
    await settle()
    const refreshItem = fake.menuItems().find(item => item.name === 'Refresh')!.id
    router.open({
      id: 'other',
      actions: () => [action({ id: 'delete', say: 'Delete', run: () => void ran.push('delete') })],
      view: () => text({ body: 'x' }),
    })
    await settle()
    expect(fake.menuItems().find(item => item.name === 'Delete')!.id).not.toBe(refreshItem)
    fake.menu(refreshItem)
    await settle()
    expect(ran).toEqual([])
    expect(front()).toBe('Not available here')
  })

  it('ignores a pick from the menu of a screen that is no longer the current one, while the glasses still show it', async () => {
    const { fake, ran, router } = world()
    await settle()
    const refresh = fake.menuItems().find(item => item.name === 'Refresh')!
    router.open({
      id: 'other',
      actions: () => [action({ id: 'refresh', say: 'Refresh', run: () => void ran.push('other refresh') })],
      view: () => text({ body: 'Other' }),
    })
    fake.menu(refresh.id)
    await settle()
    expect(ran).toEqual([])
    fake.menu(refresh.id)
    await settle()
    expect(ran).toEqual(['other refresh'])
  })

  it('folds what is over ten into a list behind More', async () => {
    const many = Array.from({ length: 12 }, (_, n) => action({ id: `a${n}`, say: `Action ${n}`, run: () => {} }))
    const { fake, menu, ran } = world({
      home: () => ({
        id: 'many',
        actions: () => [...many.slice(0, 11), action({ id: 'last', say: 'Last', run: () => void ran.push('last') })],
        view: () => text({ body: 'x' }),
      }),
    })
    await settle()
    expect(menu()).toEqual([...many.slice(0, 9).map(a => a.say), 'More…'])
    fake.pick('More…')
    await settle()
    expect(fake.lines()).toEqual(['More…', '> Action 9', 'Action 10', 'Last', 'Go back', 'Go home'])
    fake.down()
    fake.down()
    fake.tap()
    await settle()
    expect(ran).toEqual(['last'])
    expect(fake.lines()).toEqual(['x'])
  })
})

describe('an action that cannot run', () => {
  const blockedHome = (why: () => string | null) => () => ({
    id: 'home',
    actions: () => [action({ id: 'send', say: 'Send', blocked: why, run: () => {} })],
    view: () => text({ title: 'Home', body: 'Hello' }),
  })

  it('says why over the dimmed page, for a few seconds', async () => {
    const { fake, front } = world({ home: blockedHome(() => 'Watch only') })
    await settle()
    fake.pick('Send')
    await settle()
    expect(front()).toBe('Watch only')
    expect(fake.boxes().find(box => box.name === 'body')!.brightness).toBe(OVERLAY_DIM)
    await settle(3_000)
    expect(front()).toBe('')
    expect(fake.boxes().find(box => box.name === 'body')!.brightness).toBe(4)
  })

  it('takes the notice away at the next tap or swipe', async () => {
    const { fake, front } = world({ home: blockedHome(() => 'Watch only') })
    await settle()
    fake.pick('Send')
    await settle()
    fake.down()
    await settle()
    expect(front()).toBe('')
  })

  it('says a target is gone when it left before the tap landed', async () => {
    const { fake, front, people, ran } = world()
    await settle()
    people.length = 0
    fake.tap()
    await settle()
    expect(ran).toEqual([])
    expect(front()).toBe('That is gone')
  })

  it('says it did not work when the action throws, and reports the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, front } = world({
      home: () => ({
        id: 'home',
        actions: () => [
          action({
            id: 'send',
            say: 'Send',
            run: () => {
              throw new Error('offline')
            },
          }),
        ],
        view: () => text({ body: 'Hello' }),
      }),
    })
    await settle()
    fake.pick('Send')
    await settle()
    expect(front()).toBe('That did not work')
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('an action that asks first', () => {
  const home = ({ ran, people }: Parts) => ({
    id: 'home',
    actions: () => [
      action({
        id: 'delete',
        say: 'Delete',
        risk: 'confirm',
        targets: () => people.map(name => ({ id: name.toLowerCase(), say: name, value: name })),
        run: name => void ran.push(`delete ${name}`),
      }),
    ],
    view: () => text({ title: 'Home', body: 'Hello' }),
  })
  const asked = async () => {
    const made = world({ home })
    await settle()
    made.fake.pick('Delete')
    await settle()
    made.fake.down()
    made.fake.tap()
    await settle()
    return made
  }

  it('asks over the page, naming the action and its target, and runs on a tap', async () => {
    const { fake, front, ran } = await asked()
    expect(front()).toBe('Delete: Ben?\nTap to confirm')
    expect(ran).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual(['delete Ben'])
    expect(front()).toBe('')
  })

  it('does not run on anything but a tap', async () => {
    for (const other of ['double', 'up', 'down'] as const) {
      const { fake, front, ran, router } = await asked()
      fake[other]()
      await settle()
      expect(ran).toEqual([])
      expect(front()).toBe('')
      expect(router.depth).toBe(1)
    }
  })

  it('keeps asking through what Even reports around its menu', async () => {
    const { fake, front } = await asked()
    fake.foreground()
    fake.background()
    await settle(10_000)
    expect(front()).toBe('Delete: Ben?\nTap to confirm')
  })

  it('is called off by a hold, which starts a voice command', async () => {
    const { fake, front, ran } = await asked()
    fake.hold()
    await settle(50)
    expect(front()).toBe('Voice is not set up')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
  })
})

describe('a hold', () => {
  const hearing = (...lines: string[]) => {
    const asked: number[] = []
    const voice: VoiceOptions = {
      transcribe: async audio => {
        asked.push(audio.seconds)
        return lines.shift() ?? ''
      },
    }
    return { voice, asked }
  }
  const say = async (fake: ReturnType<typeof fakeBridge>, ms = 800, loudness = 8_000) => {
    fake.hold()
    await settle(50)
    fake.sound(tone(ms / 2, loudness))
    fake.sound(tone(ms / 2, loudness))
    fake.release()
    await settle(50)
  }

  it('says voice is not set up when the app gave no transcriber', async () => {
    const { fake, front } = world()
    await settle()
    fake.hold()
    await settle(50)
    expect(front()).toBe('Voice is not set up')
    expect(fake.mic).toBeNull()
  })

  it('opens the microphone and says it is listening, then closes it at the release', async () => {
    const { fake, front } = world({ voice: hearing('refresh').voice })
    await settle()
    fake.hold()
    await settle(50)
    expect(fake.mic).toBe('glasses')
    expect(front()).toBe('Listening ▁▁▁▁▁▁▁▁')
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    expect(fake.mic).toBeNull()
  })

  it('sends what was recorded to the transcriber, shows the words, and runs what they ask for', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, front, ran, router } = world({ voice })
    await settle()
    await say(fake)
    expect(asked).toEqual([0.8])
    expect(ran).toEqual(['open Ben'])
    expect(router.current.id).toBe('person')
    expect(front()).toBe('"open ben"')
    await settle(2_000)
    expect(front()).toBe('')
  })

  it('goes back when asked to', async () => {
    const { fake, router } = world({ voice: hearing('open cy', 'go back').voice })
    await settle()
    await say(fake)
    expect(router.depth).toBe(2)
    await say(fake)
    expect(router.depth).toBe(1)
  })

  it('E9: scrolls a text when asked to, a screenful at a time', async () => {
    const { fake } = world({ voice: hearing('open cy', 'scroll down', 'scroll up').voice })
    const body = () =>
      fake
        .boxes()
        .find(box => box.name === 'body')!
        .text.split('\n')[0]
    await settle()
    await say(fake)
    await settle(2_000)
    expect(body()).toBe('Line 0')
    await say(fake)
    await settle(2_000)
    expect(body()).toBe('Line 8')
    await say(fake)
    await settle(2_000)
    expect(body()).toBe('Line 0')
  })

  it('E9: moves the cursor of a list when asked to, and chooses the row it is on', async () => {
    const { fake, cursor, ran } = world({ voice: hearing('move down', 'move down', 'move up', 'choose this one').voice })
    await settle()
    await say(fake)
    await say(fake)
    expect(cursor()).toBe('Cy')
    await say(fake)
    expect(cursor()).toBe('Ben')
    await say(fake)
    expect(ran).toEqual(['open Ben'])
  })

  it('tells the model which row the cursor is on, unless that row is private', async () => {
    const screens: (string | undefined)[] = []
    const voice: VoiceOptions = {
      ...hearing('refresh', 'refresh').voice,
      model: {
        choose: async question => {
          screens.push(question.screen)
          return {}
        },
      },
    }
    const secret = action({
      id: 'read',
      say: 'Read',
      targets: () => [{ id: 'a', say: 'Salary letter', value: 'a', private: true }],
      run: () => {},
    })
    const { fake, router } = world({ voice })
    await settle()
    fake.down()
    await say(fake)
    expect(screens).toEqual(['Selected: Ben'])
    router.open({ id: 'letters', context: () => 'Letters', view: () => list({ action: secret }) })
    await settle()
    await say(fake)
    expect(screens[1]).toBe('Letters')
  })

  it("didn't catch a recording that is too short, silent or without words, and asks nobody about the first two", async () => {
    const { voice, asked } = hearing('')
    const { fake, front } = world({ voice })
    await settle()
    await say(fake, 300)
    expect(front()).toBe("Didn't catch that")
    await say(fake, 800, 50)
    expect(front()).toBe("Didn't catch that")
    expect(asked).toEqual([])
    await say(fake)
    expect(front()).toBe("Didn't catch that")
    expect(asked).toEqual([0.8])
  })

  it('says so when the microphone does not open', async () => {
    const { fake, front } = world({ voice: hearing('refresh').voice })
    await settle()
    fake.refuse('mic', 1)
    fake.hold()
    await settle(50)
    expect(front()).toBe('The microphone did not open')
  })

  it('says no match when the words fit nothing and no other agent takes them', async () => {
    const { fake, front, ran } = world({ voice: hearing('what is the weather').voice })
    await settle()
    await say(fake)
    expect(front()).toBe('No match')
    expect(ran).toEqual([])
  })

  it('lists the few candidates to tap when the navigator is unsure', async () => {
    const { fake, ran } = world({ voice: hearing('ana ben').voice })
    await settle()
    await say(fake)
    expect(fake.lines()).toEqual(['Which one?', '> Open: Ana', 'Open: Ben'])
    fake.down()
    fake.tap()
    await settle()
    expect(ran).toEqual(['open Ben'])
  })

  it('asks before an action marked voice only when the words chose it: a pick from the menu runs at once', async () => {
    const { voice } = hearing('stop it')
    const { fake, front, ran } = world({
      voice,
      home: ({ ran }) => ({
        id: 'home',
        actions: () => [action({ id: 'stop', say: 'Stop', risk: 'voice', run: () => void ran.push('stop') })],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    fake.pick('Stop')
    await settle()
    expect(ran).toEqual(['stop'])
    await say(fake)
    expect(front()).toBe('Stop?\nTap to confirm')
    expect(ran).toEqual(['stop'])
    fake.tap()
    await settle()
    expect(ran).toEqual(['stop', 'stop'])
  })

  it('still asks when the words pick the action and then its target from the list: no write without a tap', async () => {
    const { voice } = hearing('allow it', 'choose this one')
    const { fake, front, ran } = world({
      voice,
      home: ({ ran }) => ({
        id: 'home',
        actions: () => [
          action({
            id: 'allow',
            say: 'Allow',
            risk: 'voice',
            targets: () => [
              { id: 'r1', say: 'Run the migration', value: 'r1' },
              { id: 'r2', say: 'Drop the table', value: 'r2' },
            ],
            run: id => void ran.push(`allow ${id}`),
          }),
        ],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    await say(fake)
    await settle(2_000)
    expect(fake.lines()).toEqual(['Allow', '> Run the migration', 'Drop the table'])
    await say(fake)
    expect(front()).toBe('Allow: Run the migration?\nTap to confirm')
    expect(ran).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual(['allow r1'])
  })

  it('takes an action and its choice from one sentence, and still asks before a write', async () => {
    const { voice } = hearing('allow run the migration')
    const { fake, front, ran } = world({
      voice,
      home: ({ ran }) => ({
        id: 'home',
        actions: () => [
          action({
            id: 'allow',
            say: 'Allow',
            risk: 'voice',
            targets: () => [
              { id: 'r1', say: 'Run the migration', value: 'r1' },
              { id: 'r2', say: 'Drop the table', value: 'r2' },
            ],
            run: id => void ran.push(`allow ${id}`),
          }),
        ],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    await say(fake)
    expect(front()).toBe('Allow: Run the migration?\nTap to confirm')
    expect(ran).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual(['allow r1'])
  })

  it('E10: a rolling item said on another screen opens under home, so a double tap goes up, not back', async () => {
    const { voice } = hearing('ana', 'ben')
    const { fake, router } = world({ voice })
    await settle()
    await say(fake)
    await settle(2_000)
    expect(fake.lines()[0]).toContain('Ana')
    expect(router.depth).toBe(2)
    await say(fake)
    await settle(2_000)
    expect(fake.lines()[0]).toContain('Ben')
    expect(router.depth).toBe(2)
    fake.double()
    await settle()
    expect(fake.lines()[0]).toBe('People')
  })

  it("E10: an action of the app opens under home from any screen, and a screen's own action opens a child", async () => {
    const { fake, router } = world({
      appActions: () => [
        action({ id: 'about', say: 'About', run: () => router.open({ id: 'about', view: () => text({ title: 'About', body: 'x' }) }) }),
      ],
    })
    await settle()
    fake.tap()
    await settle()
    expect(router.depth).toBe(2)
    fake.pick('About')
    await settle()
    expect(fake.lines()[0]).toBe('About')
    expect(router.depth).toBe(2)
  })

  it("lets an action show its targets on the app's own screen, and asks only before the targets that write", async () => {
    const { voice } = hearing('thread queue', 'thread archive')
    const { fake, front, ran, router } = world({
      voice,
      home: ({ ran }) => ({
        id: 'home',
        actions: () => [
          action({
            id: 'thread',
            say: 'Thread',
            targets: () => [
              { id: 'queue', say: 'Queue', value: 'queue' },
              { id: 'archive', say: 'Archive', value: 'archive', risk: 'voice' },
            ],
            choose: () => router.open({ id: 'menu', view: () => text({ title: 'The thread menu', body: 'x' }) }),
            run: id => void ran.push(id),
          }),
        ],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    fake.pick('Thread')
    await settle()
    expect(fake.lines()[0]).toContain('The thread menu')
    fake.double()
    await settle()
    await say(fake)
    await settle(2_000)
    expect(ran).toEqual(['queue'])
    await say(fake)
    expect(front()).toBe('Thread: Archive?\nTap to confirm')
    expect(ran).toEqual(['queue'])
    fake.tap()
    await settle()
    expect(ran).toEqual(['queue', 'archive'])
  })

  it('drops its question when the screen changes before the tap', async () => {
    const { voice } = hearing('stop it')
    const { fake, front, ran, router } = world({
      voice,
      home: ({ ran }) => ({
        id: 'home',
        actions: () => [action({ id: 'stop', say: 'Stop', risk: 'voice', run: () => void ran.push('stop') })],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    await say(fake)
    expect(front()).toBe('Stop?\nTap to confirm')
    router.open({ id: 'other', actions: () => [], view: () => text({ body: 'Other' }) })
    await settle()
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
  })

  it('still asks before an action that needs it', async () => {
    const { voice } = hearing('delete ben')
    const { fake, front, ran } = world({
      voice,
      home: ({ people, ran, rolling }) => {
        const remove = action({
          id: 'delete',
          say: 'Delete',
          risk: 'confirm',
          targets: () => people.map(name => ({ id: name.toLowerCase(), say: name, value: name })),
          run: name => void ran.push(`delete ${name}`),
        })
        rolling.add(remove, 'ben')
        return { id: 'home', actions: () => [remove], view: () => text({ title: 'Home', body: 'Hello' }) }
      },
    })
    await settle()
    await say(fake)
    expect(front()).toBe('Delete: Ben?\nTap to confirm')
    expect(ran).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual(['delete Ben'])
  })

  it('runs an item of the rolling set from a screen that does not have its action', async () => {
    const { fake, ran, router } = world({ voice: hearing('open cy').voice })
    await settle()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    await settle()
    await say(fake)
    expect(ran).toEqual(['open Cy'])
  })

  it('tells the model what is on the screen, and what the other agents take', async () => {
    const asked: { screen?: string; says: string[] }[] = []
    const { voice } = hearing('refresh')
    voice.model = {
      choose: async question => {
        asked.push({ screen: question.screen, says: question.options.map(option => option.say) })
        return {}
      },
    }
    voice.otherwise = 'A note to remember'
    voice.agents = [() => ({ kind: 'notMine' })]
    const { fake } = world({
      voice,
      home: ({ refresh }) => ({ id: 'home', actions: () => [refresh], context: () => 'Two notes', view: () => text({ body: 'Hello' }) }),
    })
    await settle()
    await say(fake)
    expect(asked).toEqual([
      {
        screen: 'Two notes',
        says: ['Go back', 'Go home', 'A note to remember', 'None of these', 'Refresh', 'Open: Cy', 'Open: Ben', 'Open: Ana'],
      },
    ])
  })

  it("hands words the navigator passes on to the app's agents, in order", async () => {
    const got: string[] = []
    const { voice } = hearing('remember the milk')
    voice.agents = [
      heard => {
        got.push(`first ${heard.words} ${heard.hasNext}`)
        return { kind: 'notMine' }
      },
      heard => {
        got.push(`second ${heard.words} ${heard.hasNext}`)
        return { kind: 'handled', say: 'Saved' }
      },
    ]
    const { fake, front } = world({ voice })
    await settle()
    await say(fake)
    expect(got).toEqual(['first remember the milk true', 'second remember the milk false'])
    expect(front()).toBe('Saved')
  })

  it('shows what a transcriber says went wrong, or that voice did not work', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures: unknown[] = [new SayError('Set up voice on your phone'), new Error('boom')]
    const { fake, front } = world({
      voice: {
        transcribe: async () => {
          throw failures.shift()
        },
      },
    })
    await settle()
    await say(fake)
    expect(front()).toBe('Set up voice on your phone')
    expect(error).not.toHaveBeenCalled()
    await say(fake)
    expect(front()).toBe('Voice did not work')
    expect(error).toHaveBeenCalledOnce()
  })

  it('waits, unless told otherwise, as long as a service may take for the words and then for its answer', async () => {
    const later = <T>(value: T, ms: number) => new Promise<T>(done => setTimeout(() => done(value), ms))
    const { fake, front, ran } = world({
      voice: {
        transcribe: () => later('refresh', 29_000),
        model: { choose: async question => later(await matchWords.choose(question), 11_000) },
      },
    })
    await settle()
    await say(fake)
    await settle(41_000)
    expect(ran).toEqual(['refresh'])
    const never = world({ voice: { transcribe: () => new Promise<string>(() => {}) } })
    await settle()
    await say(never.fake)
    await settle(44_000)
    expect(never.front()).toBe('…')
    await settle(1_000)
    expect(never.front()).toBe('No answer in time')
    expect(front()).not.toBe('No answer in time')
  })

  it('gives up on an answer that takes too long, and ignores it when it comes', async () => {
    let answer = (_: string) => {}
    const { fake, front, ran } = world({ voice: { transcribe: () => new Promise<string>(done => (answer = done)), timeoutMs: 5_000 } })
    await settle()
    await say(fake)
    expect(front()).toBe('…')
    await settle(5_000)
    expect(front()).toBe('No answer in time')
    answer('refresh')
    await settle()
    expect(ran).toEqual([])
  })

  it('drops the answer when the screen changed while it was deciding', async () => {
    let answer = (_: string) => {}
    const { fake, front, ran, router } = world({ voice: { transcribe: () => new Promise<string>(done => (answer = done)) } })
    await settle()
    await say(fake)
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    answer('refresh')
    await settle()
    expect(ran).toEqual([])
    expect(front()).toBe('')
  })

  it("E7: hands the transcriber the command's lifetime, which ends when the command is called off", async () => {
    const { voice } = hearing('refresh')
    const { fake } = world({ voice })
    await settle()
    const lives: Lifetime[] = []
    voice.transcribe = (_audio, life) => (lives.push(life), new Promise<string>(() => {}))
    await say(fake)
    expect(lives.map(life => life.ended)).toEqual([false])
    fake.double()
    await settle(50)
    expect(lives[0].ended).toBe(true)
  })

  it('is called off by a double tap, while listening or while deciding', async () => {
    const { voice, asked } = hearing('refresh', 'refresh')
    const { fake, front, ran, router } = world({ voice })
    await settle()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    fake.double()
    await settle(50)
    expect(fake.mic).toBeNull()
    expect(front()).toBe('')
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
    expect(router.depth).toBe(2)

    let answer = (_: string) => {}
    voice.transcribe = () => new Promise<string>(done => (answer = done))
    await say(fake)
    fake.double()
    answer('refresh')
    await settle()
    expect(ran).toEqual([])
    expect(router.depth).toBe(2)
  })

  it('shows how loud it hears the speaker, in bars beside the word', async () => {
    const { fake, front } = world({ voice: hearing('refresh').voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(100, 30_000))
    fake.sound(tone(100, 300))
    await settle(300)
    expect(front()).toBe('Listening ▁▁▁▁▁▁█▃')
    fake.release()
    await settle(600)
    expect(front()).not.toContain('Listening')
  })

  it('stops what an agent has pending at any touch, without running what was touched', async () => {
    const sent: string[] = []
    let ended = false
    const voice: VoiceOptions = {
      transcribe: async () => 'tell the team',
      model: { choose: async ({ options }) => ({ [options.find(option => option.role === 'pass')!.id]: 1 }) },
      agents: [
        async ({ words, life }) => {
          life!.own(() => (ended = true))
          await life!.guard(new Promise<void>(done => life!.timeout(done, 3_000)))
          sent.push(words)
          return { kind: 'handled' }
        },
      ],
    }
    const { fake, front, ran, router } = world({ voice })
    await settle()
    await say(fake)
    expect(front()).toBe('"tell the team"')
    fake.tap()
    await settle(5_000)
    expect(ended).toBe(true)
    expect(sent).toEqual([])
    expect(ran).toEqual([])
    expect(router.depth).toBe(1)
    expect(front()).toBe('')

    await say(fake)
    await settle(3_000)
    expect(sent).toEqual(['tell the team'])
  })

  it('starts over when the touchpad is held again while an agent has something pending', async () => {
    const sent: string[] = []
    const lines = ['first try', 'second try']
    const voice: VoiceOptions = {
      transcribe: async () => lines.shift() ?? '',
      model: { choose: async ({ options }) => ({ [options.find(option => option.role === 'pass')!.id]: 1 }) },
      agents: [
        async ({ words, life }) => {
          await life!.guard(new Promise<void>(done => life!.timeout(done, 3_000)))
          sent.push(words)
          return { kind: 'handled' }
        },
      ],
    }
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    await say(fake)
    await settle(5_000)
    expect(sent).toEqual(['second try'])
  })

  it("hands the recording to the app's agents when the transcriber cannot transcribe, and asks no model", async () => {
    const got: Array<{ words: string; seconds: number | undefined }> = []
    const choose = vi.fn(async () => ({}))
    const voice: VoiceOptions = {
      transcribe: async () => null,
      model: { choose },
      agents: [
        ({ words, audio }) => {
          got.push({ words, seconds: audio?.seconds })
          return { kind: 'handled', say: 'Sent as a recording' }
        },
      ],
    }
    const { fake, front } = world({ voice })
    await settle()
    await say(fake)
    expect(got).toEqual([{ words: '', seconds: 0.8 }])
    expect(choose).not.toHaveBeenCalled()
    expect(front()).toBe('Sent as a recording')
  })

  it("didn't catch a recording nobody could transcribe and no agent took", async () => {
    const { fake, front } = world({ voice: { transcribe: async () => null } })
    await settle()
    await say(fake)
    expect(front()).toBe("Didn't catch that")
  })

  it('listens for as long as the app allows', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake } = world({ voice: { ...voice, maxHoldMs: 300_000 } })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    await settle(60_000)
    expect(fake.mic).toBe('glasses')
    await settle(240_000)
    expect(fake.mic).toBeNull()
    expect(asked).toEqual([0.8])
  })

  it('is called off when the app goes to the background or is closed, while it listens or an agent has something pending', async () => {
    const sent: string[] = []
    const asked: number[] = []
    const voice: VoiceOptions = {
      transcribe: async audio => {
        asked.push(audio.seconds)
        return 'tell the team'
      },
      model: { choose: async ({ options }) => ({ [options.find(option => option.role === 'pass')!.id]: 1 }) },
      agents: [
        async ({ words, life }) => {
          await life!.guard(new Promise<void>(done => life!.timeout(done, 3_000)))
          sent.push(words)
          return { kind: 'handled' }
        },
      ],
    }
    const { fake, front } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    fake.background()
    await settle(50)
    expect(fake.mic).toBeNull()
    expect(front()).toBe('')
    fake.release()
    await settle(50)
    expect(asked).toEqual([])

    await say(fake)
    fake.exit()
    await settle(5_000)
    expect(sent).toEqual([])
  })

  it('asks no further agent once the command was called off, however late the model answers', async () => {
    let answer = (_: Record<string, number>) => {}
    const took: string[] = []
    const voice: VoiceOptions = {
      transcribe: async () => 'tell the team',
      model: { choose: ({ options }) => new Promise(done => (answer = () => done({ [options.find(o => o.role === 'pass')!.id]: 1 }))) },
      agents: [
        ({ words }) => {
          took.push(words)
          return { kind: 'handled' }
        },
      ],
    }
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    fake.double()
    answer({})
    await settle()
    expect(took).toEqual([])
  })

  it('tells the app when it starts to listen, and is busy from then until the command is done', async () => {
    let listens = 0
    const { voice } = hearing('refresh')
    const { fake, shell } = world({ voice: { ...voice, onListen: () => listens++ } })
    await settle()
    expect(shell.busy).toBe(false)
    fake.hold()
    fake.hold()
    await settle(50)
    expect(listens).toBe(1)
    expect(shell.busy).toBe(true)
    fake.sound(tone(800))
    fake.release()
    await settle()
    expect(shell.busy).toBe(false)
  })

  it('drops what was said when the screen changed while it listened', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, front, ran, router } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    fake.release()
    await settle()
    expect(asked).toEqual([])
    expect(ran).toEqual([])
    expect(front()).toBe('')
  })

  it('ends by itself after a minute without a release', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, ran } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    await settle(60_000)
    expect(fake.mic).toBeNull()
    expect(asked).toEqual([0.8])
    expect(ran).toEqual(['refresh'])
  })
})
