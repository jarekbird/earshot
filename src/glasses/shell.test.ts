import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action, type Action } from '../action.js'
import { Lifetime } from '../lifetime.js'
import { matchWords } from '../navigator.js'
import { Rolling } from '../rolling.js'
import { Router, type Screen } from '../router.js'
import { boxes, list, text } from '../view.js'
import { fakeBridge } from './fake.js'
import { Glasses, MIC_SILENT_MS, OVERLAY_DIM, type Drawing } from './glasses.js'
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

function world(
  more: { home?: (parts: Parts) => Screen; appActions?: () => Action[]; voice?: VoiceOptions; watch?: (event: Drawing) => void } = {},
) {
  const ran: string[] = []
  const life = new Lifetime()
  const fake = fakeBridge()
  const glasses = new Glasses(life, fake.bridge, { watch: more.watch })
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

describe('a text that stays at its end', () => {
  it('draws its newest line on the glasses also when the lines before it are long, and holds its place once swiped up', async () => {
    const { fake, router, shell } = world()
    const log = [...Array.from({ length: 12 }, () => 'i'.repeat(115)), 'LATEST']
    router.open({ id: 'log', view: () => text({ body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines().at(-1)).toBe('LATEST')
    fake.up()
    await settle()
    expect(fake.lines()).not.toContain('LATEST')
    const held = fake.lines()
    log.push('NEWER')
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(held)
  })
})

describe('a text that stays at its end, with pages the byte limit keeps short', () => {
  it('shows every line to a wearer who swipes up to the top and back down', async () => {
    const { fake, router } = world()
    const dense = Array.from({ length: 12 }, (_, at) => `${String(at).padStart(2, '0')}${'í'.repeat(110)}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: dense.join('\n'), end: true }) })
    await settle()
    const seen = new Set<string>()
    const look = () => fake.lines().forEach(line => /^\d\d/.test(line) && seen.add(line.slice(0, 2)))
    look()
    for (let swipes = 0; swipes < 12; swipes++) {
      fake.up()
      await settle()
      look()
    }
    expect([...seen].sort()).toEqual(dense.map(line => line.slice(0, 2)))
    for (let swipes = 0; swipes < 12; swipes++) {
      fake.down()
      await settle()
    }
    expect(fake.lines().at(-1)?.slice(0, 2)).toBe('11')
  })
})

describe('a text that stays at its end, with a page that holds one line', () => {
  it('moves one line at a swipe, so the wearer reads each of them, up and down', async () => {
    const { fake, router } = world()
    const heavy = Array.from({ length: 5 }, (_, at) => `${'🧪'.repeat(130)}${at}`)
    router.open({ id: 'log', view: () => text({ body: heavy.join('\n'), end: true }) })
    await settle()
    const shown = () =>
      fake
        .lines()
        .map(line => line.at(-1))
        .join('')
    const read = [shown()]
    for (let swipes = 0; swipes < 4; swipes++) {
      fake.up()
      await settle()
      read.push(shown())
    }
    for (let swipes = 0; swipes < 4; swipes++) {
      fake.down()
      await settle()
      read.push(shown())
    }
    expect(read).toEqual(['4', '3', '2', '1', '0', '1', '2', '3', '4'])
  })
})

describe('a text that stays at its end, while more of it is on its way to the glasses', () => {
  it('counts a swipe from the page the wearer is looking at, not from one not yet drawn', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 12 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 12')
    let release = () => {}
    const waiting = new Promise<void>(go => (release = go))
    const real = fake.bridge.textContainerUpgrade
    fake.bridge.textContainerUpgrade = async upgrade => {
      await waiting
      return real(upgrade)
    }
    for (let at = 13; at <= 24; at++) log.push(`Line ${at}`)
    shell.redraw()
    await settle(0)
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 2')
  })
})

const held = (fake: ReturnType<typeof world>['fake']) => {
  let release = () => {}
  const waiting = new Promise<void>(go => (release = go))
  const real = fake.bridge.textContainerUpgrade
  fake.bridge.textContainerUpgrade = async upgrade => {
    await waiting
    return real(upgrade)
  }
  return () => release()
}

function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('a text that stays at its end, swiped any way while the glasses are behind and more text comes', () => {
  type Step = 'up' | 'down' | 'elsewhere' | 'drawn' | { more: string[] }
  const SEEDS = Array.from({ length: 300 }, (_, seed) => seed + 1)
  const isSwipe = (step: Step) => step === 'up' || step === 'down'

  function steps(seed: number): Step[] {
    const next = random(seed)
    let line = 30
    return Array.from({ length: 1 + Math.floor(next() * 9) }, (): Step => {
      const pick = next()
      if (pick < 0.3) return 'up'
      if (pick < 0.6) return 'down'
      if (pick < 0.68) return 'elsewhere'
      if (pick < 0.78) return 'drawn'
      return {
        more: Array.from({ length: 1 + Math.floor(next() * 12) }, () => `Line ${++line}${next() < 0.2 ? ' ' + 'í'.repeat(110) : ''}`),
      }
    })
  }

  function swipesFirst(taken: Step[]): Step[] {
    const windows: Step[][] = [[]]
    for (const step of taken) step === 'drawn' ? windows.push([]) : windows.at(-1)?.push(step)
    return windows.flatMap(window => [...window.filter(isSwipe), ...window.filter(step => !isSwipe(step))])
  }

  async function shownAfter(taken: Step[], behind: boolean): Promise<string[]> {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: `${log.length} lines`, body: log.join('\n'), end: true }) })
    await settle()
    let release = behind ? held(fake) : () => {}
    for (const step of taken) {
      if (step === 'up' || step === 'down') fake[step]()
      else if (step === 'elsewhere') {
        router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
        router.back()
      } else if (step === 'drawn') {
        release()
        await settle()
        release = behind ? held(fake) : () => {}
      } else {
        log.push(...step.more)
        shell.redraw()
      }
      await settle(behind ? 0 : undefined)
    }
    release()
    await settle()
    return fake.lines()
  }

  it.each(SEEDS)(
    'lands where the same swipes land when each is drawn before the next, with what else happened meanwhile after them (seed %i)',
    async seed => {
      const taken = steps(seed)
      expect(await shownAfter(taken, true)).toEqual(await shownAfter(swipesFirst(taken), false))
    },
  )
})

describe('a text that stays at its end, swiped twice before the glasses have drawn the first swipe', () => {
  it('counts the second swipe on from the first, so neither is lost', async () => {
    const { fake, router } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    const release = held(fake)
    fake.up()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 18')
  })

  it('counts a swipe back the other way on from the swipes before it, also when those reached the end', async () => {
    const { fake, router } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    fake.up()
    await settle()
    fake.up()
    await settle()
    expect(fake.lines()[1]).toBe('Line 18')
    const release = held(fake)
    fake.down()
    fake.down()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('goes on following the end after swipes that came back to it before the glasses had drawn any of them', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    const release = held(fake)
    fake.up()
    fake.down()
    release()
    await settle()
    log.push('Line 31')
    shell.redraw()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 31')
  })

  it('counts a swipe on from the swipes before it, not from text the app added between them that no one has seen', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    const release = held(fake)
    fake.up()
    fake.down()
    for (let at = 31; at <= 50; at++) log.push(`Line ${at}`)
    shell.redraw()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('keeps a swipe that is not yet drawn when another screen was opened and left before the glasses drew anything', async () => {
    const { fake, router } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    const release = held(fake)
    fake.up()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    router.back()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 18')
  })

  it('counts a swipe up from the page the wearer saw, when a swipe down at the end only went on following it', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    const release = held(fake)
    for (let at = 31; at <= 50; at++) log.push(`Line ${at}`)
    shell.redraw()
    fake.down()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('counts a swipe from the text the wearer saw also when the app changes that very view and hands it over again', async () => {
    const { fake, router, shell } = world()
    const view = text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'), end: true })
    router.open({ id: 'log', view: () => view })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    const release = held(fake)
    if (view.kind === 'text') view.body = Array.from({ length: 50 }, (_, at) => `Line ${at + 1}`).join('\n')
    shell.redraw()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('counts a swipe from the frame the glasses have just shown, when a newer one was already waiting behind it', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    const first = held(fake)
    for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
    shell.redraw()
    await settle(0)
    for (let at = 41; at <= 50; at++) log.push(`Line ${at}`)
    shell.redraw()
    first()
    const second = held(fake)
    await settle(0)
    expect(fake.lines().at(-1)).toBe('Line 40')
    fake.up()
    second()
    await settle()
    expect(fake.lines()[1]).toBe('Line 30')
  })

  it.each(['begin', 'end'] as const)(
    'counts a swipe from the frame the glasses show, also when the app drew again as it was told of the %s of that frame',
    async moment => {
      const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
      let again = false
      let hold = false
      const watch = (event: Drawing) => {
        if (again && event.at === moment) {
          again = false
          hold = true
          for (let at = 41; at <= 50; at++) log.push(`Line ${at}`)
          shell.redraw()
        }
        if (hold && event.at === 'end') {
          hold = false
          release = held(fake)
        }
      }
      const { fake, router, shell } = world({ watch })
      let release = () => {}
      router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
      await settle()
      for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
      again = true
      shell.redraw()
      await settle(0)
      expect(fake.lines().at(-1)).toBe('Line 40')
      fake.up()
      release()
      await settle()
      expect(fake.lines()[1]).toBe('Line 30')
    },
  )

  it('counts a swipe from text the glasses wrote in place while a rebuild of the page was held back', async () => {
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    const { fake, glasses, router, shell } = world()
    const offered = [action({ id: 'mark', say: 'Mark', run: () => {} })]
    router.open({ id: 'log', actions: () => offered, view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    let done = () => {}
    glasses.holdRebuilds(new Promise<void>(go => (done = go)))
    for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
    offered[0] = action({ id: 'clear', say: 'Clear', run: () => {} })
    shell.redraw()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 40')
    fake.up()
    done()
    await settle()
    expect(fake.lines()[1]).toBe('Line 30')
  })

  it('takes swipes on the screen an app opened from inside the telling of a draw of the screen before', async () => {
    let jump = false
    const watch = (event: Drawing) => {
      if (!jump || event.at !== 'ask') return
      jump = false
      router.open({
        id: 'log',
        view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n') }),
      })
    }
    const { fake, router, shell } = world({ watch })
    await settle()
    jump = true
    shell.redraw()
    await settle()
    expect(fake.lines()[1]).toBe('Line 1')
    fake.down()
    await settle()
    expect(fake.lines()[1]).toBe('Line 3')
  })

  it('counts a swipe from text written in place during a held rebuild, also when the app drew again as it was told the frame waits', async () => {
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    let again = false
    let release = () => {}
    const watch = (event: Drawing) => {
      if (!again || event.at !== 'wait') return
      again = false
      for (let at = 41; at <= 50; at++) log.push(`Line ${at}`)
      shell.redraw()
    }
    const { fake, glasses, router, shell } = world({ watch })
    const offered = [action({ id: 'mark', say: 'Mark', run: () => {} })]
    router.open({ id: 'log', actions: () => offered, view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    let done = () => {}
    glasses.holdRebuilds(new Promise<void>(go => (done = go)))
    for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
    offered[0] = action({ id: 'clear', say: 'Clear', run: () => {} })
    again = true
    const real = fake.bridge.textContainerUpgrade
    let writes = 0
    fake.bridge.textContainerUpgrade = async upgrade => {
      if (++writes > 1) await new Promise<void>(go => (release = go))
      return real(upgrade)
    }
    shell.redraw()
    await settle(0)
    expect(fake.lines().at(-1)).toBe('Line 40')
    fake.up()
    release()
    done()
    await settle()
    expect(fake.lines()[1]).toBe('Line 30')
  })

  it('counts a swipe from the words the glasses took, also when they refused the title that came with them', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    let title = 'Log'
    router.open({ id: 'log', view: () => text({ title, body: log.join('\n'), end: true }) })
    await settle()
    title = 'Log, later'
    for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
    fake.refuse('update', 1)
    shell.redraw()
    await settle(0)
    expect(fake.lines().at(-1)).toBe('Line 40')
    fake.up()
    await settle(5_000)
    expect(fake.lines()[1]).toBe('Line 30')
  })

  it('counts a swipe that comes while the glasses are being asked for the one before it on from that one', async () => {
    let more = false
    const watch = (event: Drawing) => {
      if (!more || event.at !== 'ask') return
      more = false
      fake.up()
    }
    const { fake, router } = world({ watch })
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    more = true
    fake.up()
    await settle()
    expect(fake.lines()[1]).toBe('Line 18')
  })

  it('counts a swipe from words the glasses have just taken, when it comes as whoever watches is told of that answer', async () => {
    let swipe = false
    const watch = (event: Drawing) => {
      if (!swipe || event.at !== 'answer' || !event.ok || event.box !== 'body') return
      swipe = false
      fake.up()
    }
    const { fake, router, shell } = world({ watch })
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    for (let at = 31; at <= 40; at++) log.push(`Line ${at}`)
    swipe = true
    shell.redraw()
    await settle()
    expect(fake.lines()[1]).toBe('Line 30')
  })

  it('runs a pick from the menu the glasses show, though a picture of that page is still refused', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    await settle()
    const go = action({ id: 'go', say: 'Go', run: () => void ran.push('go') })
    fake.refuse('picture', 100)
    router.open({
      id: 'card',
      actions: () => [go],
      view: () =>
        boxes([{ id: 'title', x: 0, y: 0, w: 200, h: 40, text: 'Card' }], {
          pictures: [{ id: 'icon', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }],
        }),
    })
    await settle()
    fake.pick('Go')
    await settle(100)
    expect(ran).toEqual(['go'])
  })

  it('follows its end from the moment an app turns that on, also on a screen that was swiped before', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    let end = false
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end }) })
    await settle()
    fake.down()
    await settle()
    fake.up()
    await settle()
    expect(fake.lines()[1]).toBe('Line 1')
    end = true
    shell.redraw()
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
    log.push('Line 31')
    shell.redraw()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 31')
  })

  it('drops a swipe not yet drawn when its screen is replaced, also by a new showing of the very same screen', async () => {
    const { fake, router, shell } = world()
    let lines = 30
    const body = () => Array.from({ length: lines }, (_, at) => `Line ${at + 1}`).join('\n')
    const log = { id: 'log', view: () => text({ title: 'Log', body: body(), end: true }) }
    router.open(log)
    await settle()
    const release = held(fake)
    fake.up()
    lines = 3
    router.replace(log)
    lines = 50
    shell.redraw()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 42')
  })

  it('keeps the swipes and the words of a screen that stays on the path while the very same screen is opened over it and left', async () => {
    const { fake, router, shell } = world()
    const lines = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    const log = { id: 'log', view: () => text({ title: 'Log', body: lines.join('\n'), end: true }) }
    router.open(log)
    await settle()
    const release = held(fake)
    fake.up()
    fake.down()
    router.open(log)
    router.back()
    for (let at = 31; at <= 50; at++) lines.push(`Line ${at}`)
    shell.redraw()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('keeps a swipe not yet drawn on a screen lower on the path while screens above it come and go', async () => {
    const { fake, router } = world()
    const log = {
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'), end: true }),
    }
    router.open(log)
    await settle()
    const release = held(fake)
    fake.up()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    router.replace({ id: 'more', view: () => text({ body: 'More' }) })
    router.back()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 18')
  })

  it('takes no swipe for a screen while the glasses still show the one that was opened over it and left', async () => {
    const { fake, router } = world()
    const lines = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: lines.join('\n'), end: true }) })
    await settle()
    const first = held(fake)
    fake.up()
    fake.down()
    router.open({ id: 'about', view: () => text({ body: 'Earshot' }) })
    first()
    await settle()
    expect(fake.lines()).toEqual(['Earshot'])
    const second = held(fake)
    for (let at = 31; at <= 50; at++) lines.push(`Line ${at}`)
    router.back()
    fake.up()
    second()
    await settle()
    expect(fake.lines()[1]).toBe('Line 42')
  })

  it('gives each showing of a screen a place of its own, so a swipe on one opened over itself leaves the one below where it was', async () => {
    const { fake, router } = world()
    const log = {
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'), end: true }),
    }
    router.open(log)
    await settle()
    router.open(log)
    await settle()
    fake.up()
    router.back()
    await settle()
    expect(fake.lines()[1]).toBe('Line 22')
  })

  it('keeps a swipe not yet drawn on a screen while a shorter showing of that very screen comes and goes over it', async () => {
    const { fake, router } = world()
    let lines = 30
    const log = {
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: lines }, (_, at) => `Line ${at + 1}`).join('\n'), end: true }),
    }
    router.open(log)
    await settle()
    const release = held(fake)
    fake.up()
    lines = 3
    router.open(log)
    lines = 30
    router.back()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 20')
  })

  it('lets an app replace its home screen with a shell attached, and draws the new one', async () => {
    const { fake, router } = world()
    await settle()
    router.replace({ id: 'next', view: () => text({ body: 'Next home' }) })
    await settle()
    expect(fake.lines()).toEqual(['Next home'])
  })

  it('sends the glasses no frame asked for just before the router was closed, nor with an overlay after', async () => {
    const { fake, router, shell } = world()
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Never to be shown'
    shell.redraw()
    router.close()
    await settle()
    shell.notice('Status')
    await settle(5_000)
    expect(fake.lines()).toEqual(['Before'])
  })

  it('takes no tap for controls whose label the glasses refused, though another box of that frame was taken', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    const control = (id: string) => {
      const act = action({ id: 'act', say: id, run: () => void ran.push(id) })
      return {
        id,
        view: () =>
          boxes(
            [
              { id: 'body', x: 0, y: 0, w: 200, h: 40, text: `${id} body` },
              { id: 'prompt', x: 0, y: 60, w: 200, h: 40, text: `Tap: ${id}` },
            ],
            { on: { tap: act } },
          ),
      }
    }
    router.open(control('Keep'))
    await settle()
    const real = fake.bridge.textContainerUpgrade
    fake.bridge.textContainerUpgrade = async upgrade => (upgrade.containerName === 'prompt' ? false : real(upgrade))
    router.replace(control('Delete'))
    await settle(100)
    expect(fake.lines()).toContain('Tap: Keep')
    fake.tap()
    await settle(100)
    expect(ran).toEqual([])
  })

  it('takes no tap for controls that changed on the same screen while the glasses still show the old label', async () => {
    const ran: string[] = []
    const { fake, router, shell } = world()
    let now = 'Pause'
    const act = (id: string) => action({ id, say: id, run: () => void ran.push(id) })
    const acts = { Pause: act('Pause'), Resume: act('Resume') }
    router.open({
      id: 'player',
      view: () =>
        boxes([{ id: 'prompt', x: 0, y: 0, w: 200, h: 40, text: `Tap: ${now}` }], { on: { tap: acts[now as 'Pause' | 'Resume'] } }),
    })
    await settle()
    fake.refuse('update', 1)
    now = 'Resume'
    shell.redraw()
    await settle(100)
    expect(fake.lines()).toEqual(['Tap: Pause'])
    fake.tap()
    await settle(100)
    expect(ran).toEqual([])
    await settle(5_000)
    expect(fake.lines()).toEqual(['Tap: Resume'])
    fake.tap()
    await settle(100)
    expect(ran).toEqual(['Resume'])
  })

  it('sends the glasses none of several frames asked for before the router was closed, nor with an overlay after', async () => {
    const { fake, router, shell } = world()
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Stale'
    shell.redraw()
    body = 'Newest'
    shell.redraw()
    router.close()
    await settle()
    shell.notice('Status')
    await settle(5_000)
    expect(fake.lines()).toEqual(['Before'])
  })

  it('runs nothing for a tap or a swipe once the router is closed', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    const count = action({ id: 'count', say: 'Count', run: () => void ran.push('count') })
    router.open({
      id: 'card',
      view: () => boxes([{ id: 'title', x: 0, y: 0, w: 200, h: 40, text: 'Card' }], { on: { tap: count, up: count } }),
    })
    await settle()
    router.close()
    fake.tap()
    fake.up()
    await settle()
    expect(ran).toEqual([])
  })

  it('sends the glasses no frame of a showing that was closed while that frame was being asked for', async () => {
    let close = false
    const watch = (event: Drawing) => {
      if (!close || event.at !== 'ask') return
      close = false
      router.close()
    }
    const { fake, router, shell } = world({ watch })
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Never to be shown'
    close = true
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(['Before'])
  })

  it('draws the screen a list moved on to while it was asked for its rows, not the list it left', async () => {
    const { fake, router } = world()
    const index = { id: 'index', view: () => text({ body: 'Index' }) }
    let moved = false
    const pick = action({
      id: 'pick',
      say: 'Pick',
      targets: () => {
        if (!moved) {
          moved = true
          router.replace(index)
        }
        return [{ id: 'a', say: 'Row', value: 'a' }]
      },
      run: () => {},
    })
    router.open({ id: 'rows', view: () => list({ title: 'Rows', action: pick }) })
    await settle()
    expect(fake.lines()).toEqual(['Index'])
  })

  it('runs a pick for the screen whose words the glasses show under a menu that did not change, though its picture is still refused', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    const refresh = action({ id: 'refresh', say: 'Refresh', run: () => void ran.push(router.current.id) })
    const card = (id: string) => ({
      id,
      actions: () => [refresh],
      view: () =>
        boxes([{ id: 'title', x: 0, y: 0, w: 200, h: 40, text: id }], {
          pictures: [{ id: 'icon', x: 376, y: 54, w: 200, h: 100, key: id, data: new Uint8Array([1, 2, 3]) }],
        }),
    })
    router.open(card('one'))
    await settle()
    fake.refuse('picture', 100)
    router.replace(card('two'))
    await settle()
    expect(fake.lines()).toEqual(['two'])
    fake.pick('Refresh')
    await settle(100)
    expect(ran).toEqual(['two'])
  })

  it('takes no touch for a screen of controls that the glasses do not show yet, while they still show the screen before', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    router.open({ id: 'log', view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n') }) })
    await settle()
    const { rebuildPageContainer } = fake.bridge
    let built = () => {}
    const building = new Promise<void>(go => (built = go))
    fake.bridge.rebuildPageContainer = async page => (await building, rebuildPageContainer(page))
    const count = action({ id: 'count', say: 'Count', run: () => void ran.push('count') })
    router.open({
      id: 'controls',
      view: () =>
        boxes(
          [
            { id: 'a', x: 0, y: 0, w: 200, h: 40, text: 'One' },
            { id: 'b', x: 0, y: 60, w: 200, h: 40, text: 'Two' },
          ],
          { on: { up: count, tap: count } },
        ),
    })
    fake.up()
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    built()
    await settle()
    fake.up()
    await settle(100)
    expect(ran).toEqual(['count'])
  })

  it('does not bring back, with an overlay, a frame that was taken back because its showing had closed', async () => {
    let close = false
    const watch = (event: Drawing) => {
      if (!close || event.at !== 'ask') return
      close = false
      router.close()
    }
    const { fake, router, shell } = world({ watch })
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Never to be shown'
    close = true
    shell.redraw()
    await settle()
    shell.notice('Status')
    await settle(5_000)
    expect(fake.lines()).toEqual(['Before'])
  })

  it('runs a pick for the newer screen from the moment its last changed words are taken, under a menu that did not change', async () => {
    const ran: string[] = []
    let pick = false
    const watch = (event: Drawing) => {
      if (!pick || event.at !== 'answer' || event.op !== 'update' || !event.ok) return
      pick = false
      fake.pick('Refresh')
    }
    const { fake, router } = world({ watch })
    const refresh = action({ id: 'refresh', say: 'Refresh', run: () => void ran.push(router.current.id) })
    const card = (id: string) => ({
      id,
      actions: () => [refresh],
      view: () => boxes([{ id: 'title', x: 0, y: 0, w: 200, h: 40, text: id }]),
    })
    router.open(card('one'))
    await settle()
    pick = true
    router.replace(card('two'))
    await settle()
    expect(ran).toEqual(['two'])
  })

  it('takes no swipe for a view of another kind that the glasses do not show yet', async () => {
    const ran: string[] = []
    const { fake, router, shell } = world()
    const count = action({ id: 'count', say: 'Count', run: () => void ran.push('count') })
    let controls = false
    router.open({
      id: 'log',
      view: () =>
        controls
          ? boxes([{ id: 'title', x: 0, y: 0, w: 200, h: 40, text: 'Controls' }], { on: { up: count } })
          : text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'), end: true }),
    })
    await settle()
    const release = held(fake)
    const { rebuildPageContainer } = fake.bridge
    let built = () => {}
    const building = new Promise<void>(go => (built = go))
    fake.bridge.rebuildPageContainer = async page => (await building, rebuildPageContainer(page))
    controls = true
    shell.redraw()
    fake.up()
    release()
    built()
    await settle()
    expect(ran).toEqual([])
    fake.up()
    await settle(100)
    expect(ran).toEqual(['count'])
  })

  it('runs no pick once the router is closed', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    router.open({
      id: 'card',
      actions: () => [action({ id: 'go', say: 'Go', run: () => void ran.push('go') })],
      view: () => text({ body: 'Card' }),
    })
    await settle()
    const go = fake.menuItems().find(item => item.name === 'Go')?.id ?? NaN
    router.close()
    fake.menu(go)
    await settle()
    expect(ran).toEqual([])
  })

  it('draws the screen an app moved on to while it was asked for the view of the one before, and takes picks for that one', async () => {
    const ran: string[] = []
    const { fake, menu, router } = world()
    const index = {
      id: 'index',
      actions: () => [action({ id: 'preview', say: 'Preview index', run: () => void ran.push('index') })],
      view: () => text({ body: 'Index' }),
    }
    let moved = false
    const recipe: Screen = {
      id: 'recipe',
      actions: () => [action({ id: 'preview', say: 'Preview recipe', run: () => void ran.push('recipe') })],
      view: () => {
        if (!moved) {
          moved = true
          router.replace(index)
        }
        return text({ body: 'Recipe' })
      },
    }
    router.open(recipe)
    await settle()
    expect(fake.lines()).toEqual(['Index'])
    expect(menu()).toContain('Preview index')
    fake.pick('Preview index')
    await settle(100)
    expect(ran).toEqual(['index'])
  })

  it('draws nothing more for a swipe once the router was closed from inside a draw', async () => {
    let close = false
    const watch = (event: Drawing) => {
      if (!close || event.at !== 'ask') return
      close = false
      router.close()
    }
    const { fake, glasses, router, shell } = world({ watch })
    router.open({
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'), end: true }),
    })
    await settle()
    close = true
    shell.redraw()
    await settle()
    const before = glasses.shown
    fake.up()
    await settle()
    expect(glasses.shown).toBe(before)
  })

  it('runs no pick from the menu of an earlier showing of a screen once that screen has been shown anew', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    let record = 'old'
    const go = action({ id: 'go', say: 'Go', run: () => void ran.push(record) })
    const card = { id: 'card', actions: () => [go], view: () => text({ title: 'Card', body: record }) }
    router.open(card)
    await settle()
    const release = held(fake)
    record = 'new'
    router.replace(card)
    fake.pick('Go')
    await settle(0)
    expect(ran).toEqual([])
    release()
    await settle()
    fake.pick('Go')
    await settle(100)
    expect(ran).toEqual(['new'])
  })

  it('counts a swipe on the page the wearer saw when the screen has meanwhile turned to following its end', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`)
    let end = false
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 1')
    const release = held(fake)
    end = true
    shell.redraw()
    fake.down()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 3')
  })

  it('counts the first from the page the wearer saw and the second on from there, while more text is on its way too', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 12 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    expect(fake.lines()[1]).toBe('Line 4')
    const release = held(fake)
    for (let at = 13; at <= 24; at++) log.push(`Line ${at}`)
    shell.redraw()
    await settle(0)
    fake.up()
    fake.up()
    release()
    await settle()
    expect(fake.lines()[1]).toBe('Line 1')
  })
})

describe('a text that stays at its end, swiped down while more of it is on its way', () => {
  it('goes on following the end: the wearer was at the end of what they could see', async () => {
    const { fake, router, shell } = world()
    const log = Array.from({ length: 12 }, (_, at) => `Line ${at + 1}`)
    router.open({ id: 'log', view: () => text({ title: 'Log', body: log.join('\n'), end: true }) })
    await settle()
    let release = () => {}
    const waiting = new Promise<void>(go => (release = go))
    const real = fake.bridge.textContainerUpgrade
    fake.bridge.textContainerUpgrade = async upgrade => {
      await waiting
      return real(upgrade)
    }
    for (let at = 13; at <= 24; at++) log.push(`Line ${at}`)
    shell.redraw()
    await settle(0)
    fake.down()
    release()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 24')
    log.push('Line 25')
    shell.redraw()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 25')
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

  it('drops the question when the router is closed, so a tap after that confirms nothing', async () => {
    const { fake, front, ran, router } = await asked()
    expect(front()).toBe('Delete: Ben?\nTap to confirm')
    router.close()
    fake.tap()
    await settle()
    expect(ran).toEqual([])
  })

  it('asks nothing for an action that closed the router as it was asked whether it may run', async () => {
    const ran: string[] = []
    const { fake, front, router } = world()
    let closed = false
    const risky = action({
      id: 'risky',
      say: 'Risky',
      risk: 'confirm',
      blocked: () => {
        if (!closed) {
          closed = true
          router.close()
        }
        return null
      },
      run: () => void ran.push('risky'),
    })
    router.open({ id: 'card', actions: () => [risky], view: () => text({ body: 'Card' }) })
    await settle()
    fake.pick('Risky')
    await settle()
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
  })

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

  it('sends nothing to the transcriber when the screen was shown anew during the hold, also as the very same screen', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router } = world({ voice })
    const card = { id: 'card', view: () => text({ body: 'Card' }) }
    router.open(card)
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    router.replace(card)
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
  })

  it('sends nothing to the transcriber when the router was closed during the hold', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    router.close()
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
  })

  it('asks no further agent about a turn once the screen it was said on has been shown anew', async () => {
    const heard: string[] = []
    let answer: (verdict: { kind: 'notMine' }) => void = () => {}
    const { voice } = hearing('remember this')
    voice.agents = [
      () => new Promise(done => (answer = done)),
      said => {
        heard.push(said.screen ?? '')
        return { kind: 'notMine' }
      },
    ]
    const { fake, router } = world({ voice })
    let marker = 'first showing'
    const card = { id: 'card', context: () => marker, view: () => text({ body: 'Card' }) }
    router.open(card)
    await settle()
    await say(fake)
    marker = 'second showing'
    router.replace(card)
    answer({ kind: 'notMine' })
    await settle()
    expect(heard).toEqual([])
  })

  it('ends a hold when the screen it began on is replaced, though the screen below stays', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router, shell } = world({ voice })
    router.open({ id: 'card', view: () => text({ body: 'Card' }) })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    expect(shell.busy).toBe(true)
    router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
    expect(shell.busy).toBe(false)
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
  })

  it('opens no microphone for a hold once the router is closed', async () => {
    const { voice } = hearing('open ben')
    const { fake, router } = world({ voice })
    await settle()
    router.close()
    fake.hold()
    await settle(500)
    expect(fake.mic).toBeNull()
  })

  it('asks no agent about a turn when the screen moved on as the app was asked for its context', async () => {
    const heard: string[] = []
    const { voice } = hearing('remember this')
    voice.model = {
      choose: async question => {
        heard.push(question.screen ?? '')
        return matchWords.choose(question)
      },
    }
    const { fake, router } = world({ voice })
    let moved = false
    const card: Screen = {
      id: 'card',
      context: () => {
        if (!moved) {
          moved = true
          router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        }
        return 'Previous context'
      },
      view: () => text({ body: 'Card' }),
    }
    router.open(card)
    await settle()
    await say(fake)
    await settle()
    expect(heard).toEqual([])
  })

  it('ends the wait for a turn with the turn, when the screen it was said on is replaced', async () => {
    const { fake, life, router } = world({ voice: { transcribe: () => new Promise<string>(() => {}), timeoutMs: 77_000 } })
    router.open({ id: 'card', view: () => text({ body: 'Card' }) })
    await settle()
    await say(fake)
    const waiting = vi.getTimerCount()
    router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
    expect(vi.getTimerCount()).toBeLessThan(waiting)
    life.end()
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

  it('takes the microphone alone while something else listens: the command stays out of what that hears, and the microphone stays open', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses, ran } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.sound(tone(100))
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    fake.sound(tone(200))
    expect(session).toEqual([tone(100).length, tone(200).length])
    expect(asked).toEqual([0.8])
    expect(ran).toEqual(['refresh'])
    expect(fake.mic).toBe('glasses')
    expect(fake.calls.filter(call => call.startsWith('mic'))).toEqual(['mic open', 'mic open'])
  })

  it('keeps a hold through a long silence', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, front, ran } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    await settle(MIC_SILENT_MS * 3)
    expect(front()).toMatch(/^Listening/)
    fake.release()
    await settle(50)
    expect(asked).toEqual([0.8])
    expect(ran).toEqual(['refresh'])
    expect(fake.calls.filter(call => call.startsWith('mic'))).toEqual(['mic open', 'mic close'])
  })

  it('asks for the microphone once as it starts, and never again through a long silence, also while something else listens', async () => {
    const { voice } = hearing('refresh')
    const { fake, glasses, front } = world({ voice })
    await settle()
    glasses.listen(() => {})
    await settle(50)
    fake.hold()
    await settle(MIC_SILENT_MS * 3)
    expect(front()).toMatch(/^Listening/)
    expect(fake.calls.filter(call => call.startsWith('mic'))).toEqual(['mic open', 'mic open'])
  })

  it('keeps what is said until the release from another listener, also when the microphone did not open at first', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses, front } = world({ voice })
    await settle()
    const session: number[] = []
    fake.refuse('mic', 2)
    glasses.listen(sound => session.push(sound.pcm.length))
    fake.hold()
    await settle(50)
    expect(front()).toBe('The microphone did not open')
    await settle(2_000)
    expect(fake.mic).toBe('glasses')
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
    expect(asked).toEqual([])
  })

  it('lets the microphone go when the shell ends in the middle of a hold', async () => {
    const life = new Lifetime()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    const mine = life.child()
    new Shell(mine, glasses, new Router({ home: { id: 'home' } }), { voice: hearing('refresh').voice })
    await settle()
    fake.hold()
    await settle(50)
    expect(fake.mic).toBe('glasses')
    mine.end()
    await settle()
    expect(fake.mic).toBeNull()
  })

  it('ends at the release of the touchpad that was held, not at another one', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold('right')
    await settle(50)
    fake.hold('ring')
    fake.release('ring')
    fake.sound(tone(800))
    fake.release('right')
    await settle(50)
    expect(session).toEqual([])
    expect(asked).toEqual([0.8])
  })

  it('does not end at a release that names no touchpad, when the hold named one', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses, front } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold('right')
    await settle(50)
    fake.sound(tone(800))
    fake.release('unknown')
    await settle(50)
    fake.sound(tone(200))
    expect(front()).toMatch(/^Listening/)
    expect(asked).toEqual([])
    expect(session).toEqual([])
    fake.release('right')
    await settle(50)
    expect(asked).toEqual([1])
  })

  it('ends at any release when the hold named no touchpad', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake } = world({ voice })
    await settle()
    fake.hold('unknown')
    await settle(50)
    fake.sound(tone(800))
    fake.release('right')
    await settle(50)
    expect(asked).toEqual([0.8])
  })

  it('ends cleanly when the app ends the shell from its own callback as the hold starts', async () => {
    const life = new Lifetime()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    const mine = life.child()
    const voice: VoiceOptions = { ...hearing('refresh').voice, onListen: () => mine.end() }
    new Shell(mine, glasses, new Router({ home: { id: 'home' } }), { voice })
    await settle()
    expect(() => fake.hold()).not.toThrow()
    await settle()
    expect(fake.mic).toBeNull()
    expect(fake.overlay()).toBe('')
  })

  it('takes its words off the page when it ends in the middle of a hold', async () => {
    const life = new Lifetime()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    const mine = life.child()
    new Shell(mine, glasses, new Router({ home: { id: 'home' } }), { voice: hearing('refresh').voice })
    await settle()
    fake.hold()
    await settle(50)
    expect(fake.overlay()).toMatch(/^Listening/)
    mine.end()
    await settle()
    expect(fake.overlay()).toBe('')
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
    expect(fake.mic).toBeNull()
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
    expect(asked).toEqual([])
    await settle(240_000)
    expect(asked).toEqual([0.8])
    fake.release()
    await settle(50)
    expect(fake.mic).toBeNull()
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
    expect(asked).toEqual([0.8])
    expect(ran).toEqual(['refresh'])
  })

  it('keeps the rest of what is said from the listeners until the release, when it ended by itself', async () => {
    const { voice } = hearing('refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    await settle(60_000)
    fake.sound(tone(300))
    expect(session).toEqual([])
    fake.release()
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })

  it('is not failed by the close of the microphone that a listener who just left had asked for', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    const answer = fake.bridge.audioControl.bind(fake.bridge)
    let closed = () => {}
    fake.bridge.audioControl = async (on, source) => {
      if (!on) await new Promise<void>(done => (closed = done))
      return answer(on, source)
    }
    const stop = glasses.listen(() => {})
    await settle(50)
    void stop()
    fake.hold()
    closed()
    await settle(50)
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    expect(asked).toEqual([0.8])
  })

  it('stops asking for the microphone when it is called off, and still keeps a listener from hearing until the release', async () => {
    const { voice } = hearing('refresh')
    const alone = world({ voice })
    await settle()
    alone.fake.hold()
    await settle(50)
    alone.fake.double()
    await settle(50)
    expect(alone.fake.mic).toBeNull()

    const shared = world({ voice: hearing('refresh').voice })
    await settle()
    const session: number[] = []
    shared.glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    shared.fake.hold()
    await settle(50)
    shared.fake.double()
    shared.fake.sound(tone(300))
    expect(session).toEqual([])
    expect(shared.fake.mic).toBe('glasses')
    shared.fake.release()
    shared.fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })

  it('keeps a listener from hearing for as long as any touchpad is down, whichever was pressed and let go meanwhile', async () => {
    const { voice } = hearing('refresh', 'refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold('right')
    await settle(60_000)
    fake.hold('ring')
    await settle(50)
    fake.release('ring')
    await settle(50)
    fake.sound(tone(300))
    expect(session).toEqual([])
    fake.release('right')
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })

  it('keeps a listener from hearing while a touchpad is held, also when no voice is set up', async () => {
    const { fake, glasses, front } = world()
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold()
    await settle(50)
    fake.sound(tone(300))
    expect(front()).toBe('Voice is not set up')
    expect(session).toEqual([])
    fake.release()
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })

  it('asks nothing of the microphone when a touchpad is held with no voice set up and nothing listening', async () => {
    const { fake } = world()
    await settle()
    fake.hold()
    await settle(50)
    fake.release()
    await settle(50)
    expect(fake.calls.filter(call => call.startsWith('mic'))).toEqual([])
  })

  it('asks for the microphone as it starts to record, so a hold right after the phone suspended the app still hears', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    glasses.listen(() => {})
    await settle(50)
    fake.sound(tone(100))
    fake.mic = null
    fake.hold()
    await settle(50)
    expect(fake.mic).toBe('glasses')
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    expect(asked).toEqual([0.8])
  })

  it('still takes a hold when a listener of the touchpad that the app put first throws', async () => {
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const life = new Lifetime()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    glasses.onInput(() => {
      throw new Error('an app failed')
    })
    const { voice, asked } = hearing('refresh')
    new Shell(life, glasses, new Router({ home: { id: 'home' } }), { voice })
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    fake.release()
    await settle(50)
    expect(session).toEqual([])
    expect(asked).toEqual([0.8])
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual(Array(2).fill('Error: Earshot: a listener of the touchpad threw.'))
    vi.unstubAllGlobals()
  })

  it('takes no hold once it has ended, also when it ends while that very press is being handed out', async () => {
    const life = new Lifetime()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    const mine = life.child()
    glasses.onInput(input => void (input.kind === 'hold' && mine.end()))
    new Shell(mine, glasses, new Router({ home: { id: 'home' } }), { voice: hearing('refresh').voice })
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })

  describe('a choice of the navigator that the person turns down', () => {
    const noting = (line: string, more: Partial<VoiceOptions> = {}) => {
      const got: Array<{ words: string; seconds: number | undefined }> = []
      const { voice, asked } = hearing(line)
      const choose = vi.fn(matchWords.choose)
      const all: VoiceOptions = {
        ...voice,
        model: { choose },
        instead: 'Keep as a note',
        agents: [
          ({ words, audio }) => {
            got.push({ words, seconds: audio?.seconds })
            return { kind: 'handled', say: 'Saved' }
          },
        ],
        ...more,
      }
      return { voice: all, got, asked, choose }
    }
    const allowing = ({ ran }: Parts): Screen => ({
      id: 'home',
      actions: () => [
        action({
          id: 'allow',
          say: 'Allow',
          risk: 'voice',
          targets: () => [{ id: 'r1', say: 'Run the migration', value: 'r1' }],
          run: id => void ran.push(`allow ${id}`),
        }),
        action({ id: 'wipe', say: 'Wipe', risk: 'confirm', run: () => void ran.push('wipe') }),
      ],
      view: () => text({ title: 'Home', body: 'Hello' }),
    })
    const ASKED = 'Allow: Run the migration?\nTap to confirm'

    it("hands the words to the app's agents at a swipe, and does not run what the navigator chose", async () => {
      const { voice, got, asked, choose } = noting('allow run the migration')
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      expect(front()).toBe(`${ASKED}\nSwipe: Keep as a note`)
      fake.down()
      await settle()
      expect(got).toEqual([{ words: 'allow run the migration', seconds: 0.8 }])
      expect(ran).toEqual([])
      expect(front()).toBe('Saved')
      expect(asked).toEqual([0.8])
      expect(choose).toHaveBeenCalledTimes(1)
    })

    it('takes a swipe either way', async () => {
      const { voice, got } = noting('allow run the migration')
      const { fake, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      fake.up()
      await settle()
      expect(got.map(heard => heard.words)).toEqual(['allow run the migration'])
      expect(ran).toEqual([])
    })

    it('still runs the choice at a tap and drops it at a double tap, and neither reaches the agents', async () => {
      const { voice, got } = noting('allow run the migration')
      voice.transcribe = async () => 'allow run the migration'
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      fake.double()
      await settle()
      expect(front()).toBe('')
      expect(ran).toEqual([])
      await say(fake)
      fake.tap()
      await settle()
      expect(ran).toEqual(['allow r1'])
      expect(got).toEqual([])
    })

    it('offers no swipe to an app that named nothing to do instead: a swipe only drops the question', async () => {
      const { voice, got } = noting('allow run the migration', { instead: undefined })
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      expect(front()).toBe(ASKED)
      fake.down()
      await settle()
      expect(front()).toBe('')
      expect(got).toEqual([])
      expect(ran).toEqual([])
    })

    it('offers no swipe when the app has no agent to hand the words to', async () => {
      const { voice } = noting('allow run the migration', { agents: [] })
      const { fake, front } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      expect(front()).toBe(ASKED)
    })

    it('offers no swipe on a question a touch raised: there are no words to hand on', async () => {
      const { voice, got } = noting('allow run the migration')
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      fake.pick('Wipe')
      await settle()
      expect(front()).toBe('Wipe?\nTap to confirm')
      fake.down()
      await settle()
      expect(got).toEqual([])
      expect(ran).toEqual([])
    })

    it("offers no swipe on a question one of the app's own agents raised", async () => {
      const { voice } = noting('note this', {
        model: { choose: async ({ options }) => ({ [options.find(option => option.role === 'pass')!.id]: 1 }) },
        agents: [() => ({ kind: 'sure', action: 'allow', target: 'r1' }), () => ({ kind: 'handled', say: 'Saved' })],
      })
      const { fake, front } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      expect(front()).toBe(ASKED)
    })

    it('reads what to do instead when the question is asked, so an app can name it by what the words were for', async () => {
      let name = 'Keep as a note'
      const { voice } = noting('allow run the migration')
      Object.defineProperty(voice, 'instead', { get: () => name })
      const { fake, front } = world({ voice, home: allowing })
      await settle()
      name = 'Send to Ana'
      await say(fake)
      expect(front()).toBe(`${ASKED}\nSwipe: Send to Ana`)
    })

    it('drops the question when the screen changes, so a later swipe hands nothing on', async () => {
      const { voice, got } = noting('allow run the migration')
      const { fake, router } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      router.open({ id: 'about', view: () => text({ title: 'About', body: 'Earshot' }) })
      await settle()
      fake.down()
      await settle()
      expect(got).toEqual([])
    })

    it('says no match when no agent takes the words that were handed on', async () => {
      const { voice } = noting('allow run the migration', { agents: [() => ({ kind: 'notMine' })] })
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      fake.down()
      await settle()
      expect(front()).toBe('No match')
      expect(ran).toEqual([])
    })

    it('gives the agents a turn of their own, which any touch calls off', async () => {
      const sent: string[] = []
      let ended = false
      const { voice } = noting('allow run the migration', {
        agents: [
          async ({ words, life }) => {
            life!.own(() => (ended = true))
            await life!.guard(new Promise<void>(done => life!.timeout(done, 3_000)))
            sent.push(words)
            return { kind: 'handled' }
          },
        ],
      })
      const { fake, front, ran } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      fake.down()
      await settle(50)
      expect(front()).toBe('"allow run the migration"')
      expect(ended).toBe(false)
      fake.tap()
      await settle(5_000)
      expect(ended).toBe(true)
      expect(sent).toEqual([])
      expect(ran).toEqual([])
    })

    it('adds it as the last row where the navigator lists its candidates, and that row hands the words on', async () => {
      const { voice, got, choose } = noting('ana ben')
      const { fake, front, ran } = world({ voice })
      await settle()
      await say(fake)
      expect(fake.lines()).toEqual(['Which one?', '> Open: Ana', 'Open: Ben', 'Keep as a note'])
      fake.down()
      fake.down()
      fake.tap()
      await settle()
      expect(got.map(heard => heard.words)).toEqual(['ana ben'])
      expect(ran).toEqual([])
      expect(fake.lines()[0]).toBe('People')
      expect(front()).toBe('Saved')
      expect(choose).toHaveBeenCalledTimes(1)
    })

    it('hands on the words that raised the list, not the ones that chose the row, when the row is chosen by voice', async () => {
      const lines = ['ana ben', 'choose this one']
      const { voice, got } = noting('')
      voice.transcribe = async () => lines.shift() ?? ''
      const { fake, ran } = world({ voice })
      await settle()
      await say(fake)
      fake.down()
      fake.down()
      await say(fake)
      await settle()
      expect(got.map(heard => heard.words)).toEqual(['ana ben'])
      expect(ran).toEqual([])
      expect(fake.lines()[0]).toBe('People')
    })
  })

  it('counts a touchpad as let go after two days at the most, however long a hold the app allows', async () => {
    const { voice } = hearing('refresh')
    const { fake, glasses } = world({ voice: { ...voice, maxHoldMs: 14 * 86_400_000 } })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold()
    await settle(50)
    fake.sound(tone(200))
    expect(session).toEqual([])
  })

  it('lets the listeners hear again when no release came for twice its longest length', async () => {
    const { voice } = hearing('refresh')
    const { fake, glasses } = world({ voice })
    await settle()
    const session: number[] = []
    glasses.listen(sound => session.push(sound.pcm.length))
    await settle(50)
    fake.hold()
    await settle(50)
    fake.sound(tone(800))
    await settle(120_000)
    fake.sound(tone(200))
    expect(session).toEqual([tone(200).length])
  })
})
