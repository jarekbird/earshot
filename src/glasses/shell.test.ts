import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action, type Action } from '../action.js'
import { Lifetime } from '../lifetime.js'
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
  const front = () => fake.boxes().at(-1)!.text.trim()
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
  it('draws the boxes and hands it the taps and swipes', async () => {
    const heard: string[] = []
    const { fake } = world({
      home: () => ({
        id: 'custom',
        view: () => boxes([{ id: 'only', x: 0, y: 0, w: 576, h: 27, text: 'Custom' }], input => void heard.push(input.kind)),
      }),
    })
    await settle()
    expect(fake.lines()).toEqual(['Custom'])
    fake.tap()
    fake.up()
    fake.down()
    expect(heard).toEqual(['tap', 'up', 'down'])
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
  const tone = (ms: number, loudness = 8_000) => {
    const samples = new Int16Array((16_000 * ms) / 1000)
    for (let at = 0; at < samples.length; at++) samples[at] = Math.round(loudness * Math.sin(at / 5))
    return new Uint8Array(samples.buffer)
  }
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
    expect(front()).toBe('Listening')
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
    expect(fake.lines()).toEqual(['Which one?', '> Open: Ben', 'Open: Ana'])
    fake.down()
    fake.tap()
    await settle()
    expect(ran).toEqual(['open Ana'])
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
