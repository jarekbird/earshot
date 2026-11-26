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
const TURN_END = 'Error: Earshot: a listener of the end of a voice turn threw.'
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
  it('draws the screen an app opened from a field of a box it was asked for, never that box over it', async () => {
    const places: { router?: Router } = {}
    let armed = false
    const status = {
      id: 'status',
      x: 0,
      y: 0,
      w: 576,
      h: 27,
      get text() {
        if (!armed) return 'Idle'
        armed = false
        places.router?.open({ id: 'other', view: () => text({ body: 'Other' }) })
        return 'Left behind'
      },
    }
    const { fake, router, shell } = world({ home: () => ({ id: 'home', view: () => boxes([status]) }) })
    places.router = router
    await settle()
    expect(fake.lines()).toEqual(['Idle'])
    armed = true
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(['Other'])
  })

  it('keeps the newer draw when the app, asked for a view, opens a screen and goes back before it answers', async () => {
    const places: { router?: Router } = {}
    let armed = false
    let body = 'Old'
    const { fake, router, shell } = world({
      home: () => ({
        id: 'home',
        view: () => {
          const then = body
          if (armed) {
            armed = false
            places.router?.open({ id: 'other', view: () => text({ body: 'Other' }) })
            body = 'New'
            places.router?.back()
          }
          return text({ body: then })
        },
      }),
    })
    places.router = router
    await settle()
    armed = true
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(['New'])
  })

  it('keeps the newer draw when the app, asked for a view, has the shell draw again before it answers', async () => {
    const places: { shell?: Shell } = {}
    let armed = false
    let body = 'Old'
    const { fake, shell } = world({
      home: () => ({
        id: 'home',
        view: () => {
          const then = body
          if (armed) {
            armed = false
            body = 'New'
            places.shell?.redraw()
          }
          return text({ body: then })
        },
      }),
    })
    places.shell = shell
    await settle()
    armed = true
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(['New'])
  })

  it('shows the page as bright and as whole as before once a notice is gone, though the router was closed with a redraw waiting', async () => {
    let body = Array.from({ length: 9 }, (_, at) => `Old ${at + 1}`).join('\n')
    const { fake, router, shell } = world({ home: () => ({ id: 'home', view: () => text({ body }) }) })
    const seen = () => fake.boxes().map(({ text: words, brightness }) => [words, brightness])
    await settle()
    const before = seen()
    shell.notice('Saved')
    await settle(100)
    expect(seen()).not.toEqual(before)
    body = 'New'
    shell.redraw()
    router.close()
    await settle()
    expect(fake.overlay()).toBe('Saved')
    await settle(4_000)
    expect([fake.overlay(), seen()]).toEqual(['', before])
  })

  it('runs nothing at a pick from the menu when finding its action replaces the screen', async () => {
    const places: { router?: Router } = {}
    let finding = false
    const { fake, ran, router } = world({
      home: ({ refresh }) => ({
        id: 'home',
        view: () => text({ body: 'Home' }),
        actions: () => {
          if (finding) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }), actions: () => [refresh] })
          finding = false
          return [refresh]
        },
      }),
    })
    places.router = router
    await settle()
    finding = true
    fake.pick('Refresh')
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it('runs nothing at a pick from the menu when finding its action opens another screen over this one', async () => {
    const places: { router?: Router } = {}
    let finding = false
    const { fake, ran, router } = world({
      home: ({ refresh }) => ({
        id: 'home',
        view: () => text({ body: 'Home' }),
        actions: () => {
          if (finding) places.router?.open({ id: 'other', view: () => text({ body: 'Other' }), actions: () => [refresh] })
          finding = false
          return [refresh]
        },
      }),
    })
    places.router = router
    await settle()
    finding = true
    fake.pick('Refresh')
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it('runs nothing when the app, asked whether an action jumps, closes the router', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let closing = false
    const shut = action({ id: 'shut', say: 'Shut', blocked: () => ((closing = true), null), run: () => void ran.push('shut') })
    const { fake, router } = world({
      home: () => ({
        id: 'home',
        view: () => text({ body: 'Home' }),
        actions: () => {
          if (closing) places.router?.close()
          closing = false
          return [shut]
        },
      }),
    })
    places.router = router
    await settle()
    fake.pick('Shut')
    await settle()
    expect(ran).toEqual([])
  })

  it('runs nothing at a tap when the app, asked what the tap is bound to, replaces the screen', async () => {
    const places: { router?: Router } = {}
    let armed = false
    const { fake, ran, router } = world({
      home: ({ refresh }) => {
        const view = boxes([{ id: 'status', x: 0, y: 0, w: 576, h: 27, text: 'Ready' }])
        Object.defineProperty(view, 'on', {
          get: () => {
            if (armed) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
            armed = false
            return { tap: refresh }
          },
        })
        return { id: 'home', view: () => view }
      },
    })
    places.router = router
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it('runs nothing when the app, asked for the rows of an action or whether it jumps, opens a screen and goes back', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let at = ''
    const leave = () => {
      places.router?.open({ id: 'child', view: () => text({ body: 'Child' }) })
      places.router?.back()
    }
    const rows = action({ id: 'rows', say: 'Rows', blocked: () => (at === 'rows' && leave(), null), run: () => void ran.push('rows') })
    const jump = action({
      id: 'jump',
      say: 'Jump',
      blocked: () => (at === 'jump' && (at = 'jumping'), null),
      run: () => void ran.push('jump'),
    })
    const { fake, router } = world({
      home: () => ({
        id: 'home',
        view: () => text({ body: 'Home' }),
        actions: () => {
          if (at === 'jumping') {
            at = ''
            leave()
          }
          return [rows, jump]
        },
      }),
    })
    places.router = router
    await settle()
    at = 'rows'
    fake.pick('Rows')
    await settle()
    at = 'jump'
    fake.pick('Jump')
    await settle()
    expect(ran).toEqual([])
    at = ''
    fake.pick('Rows')
    fake.pick('Jump')
    await settle()
    expect(ran).toEqual(['rows', 'jump'])
  })

  it('runs nothing when the app, asked once more whether an action is blocked just before it runs, replaces the screen', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let asked = 0
    const act = action({
      id: 'act',
      say: 'Act',
      blocked: () => {
        if (++asked === 2) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        return null
      },
      run: () => void ran.push('act'),
    })
    const { fake, router } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] }) })
    places.router = router
    await settle()
    asked = 0
    fake.pick('Act')
    await settle()
    expect([asked, router.current.id, ran, fake.overlay()]).toEqual([2, 'other', [], ''])
  })

  it('runs nothing when the app, asked once more for the rows of an action just before it runs, replaces the screen', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let asked = 0
    const pick = action({
      id: 'pick',
      say: 'Pick',
      targets: () => {
        if (++asked === 2) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        return [{ id: 'a', say: 'A', value: 'a' }]
      },
      run: row => void ran.push(row),
    })
    const { fake, router } = world({
      home: () => ({
        id: 'home',
        view: () => boxes([{ id: 'status', x: 0, y: 0, w: 576, h: 27, text: 'Ready' }], { on: { tap: { action: pick, target: 'a' } } }),
      }),
    })
    places.router = router
    await settle()
    asked = 0
    fake.tap()
    await settle()
    expect([asked, router.current.id, ran, fake.overlay()]).toEqual([2, 'other', [], ''])
  })

  it('runs what an app wrapped around an action, never the action under it', async () => {
    const ran: string[] = []
    const base = action({ id: 'act', say: 'Act', run: () => void ran.push('act') })
    const locked: Action = { ...base, run: async () => ({ done: false, why: 'blocked', say: 'Locked' }) }
    const { fake, front } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [locked] }) })
    await settle()
    fake.pick('Act')
    await settle(100)
    expect([ran, front()]).toEqual([[], 'Locked'])
  })

  it('runs nothing when the app, asked for the value of the row that was meant, replaces the screen', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let armed = false
    const row = {
      id: 'a',
      say: 'A',
      get value() {
        if (armed) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        armed = false
        return 'a'
      },
    }
    const pick = action({ id: 'pick', say: 'Pick', targets: () => [row], run: value => void ran.push(value) })
    const { fake, router } = world({
      home: () => ({
        id: 'home',
        view: () => boxes([{ id: 'status', x: 0, y: 0, w: 576, h: 27, text: 'Ready' }], { on: { tap: { action: pick, target: 'a' } } }),
      }),
    })
    places.router = router
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it("runs nothing when the app, asked for the work of an action, replaces the screen, and calls that work as the app's own", async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let armed = false
    const spec = {
      id: 'act',
      say: 'Act',
      name: 'own',
      get run() {
        if (armed) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        armed = false
        return function (this: { name: string }) {
          ran.push(this.name)
        }
      },
    }
    const act = action(spec)
    const { fake, router } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] }) })
    places.router = router
    await settle()
    fake.pick('Act')
    await settle()
    expect(ran).toEqual(['own'])
    armed = true
    fake.pick('Act')
    await settle()
    expect([router.current.id, ran]).toEqual(['other', ['own']])
  })

  it('draws nothing for a shell that the app ended as it was asked for a view', async () => {
    const life = new Lifetime()
    const mine = life.child()
    const fake = fakeBridge()
    let armed = false
    const router = new Router({
      home: {
        id: 'home',
        view: () => {
          if (armed) mine.end()
          return text({ body: armed ? 'After the end' : 'Home' })
        },
      },
    })
    const shell = new Shell(mine, new Glasses(life, fake.bridge), router)
    await settle()
    armed = true
    shell.redraw()
    await settle()
    expect(fake.lines()).toEqual(['Home'])
    life.end()
  })

  it("runs the work an app put in place of an action's own, on the very object the action was made as", async () => {
    const ran: string[] = []
    const act = action({ id: 'act', say: 'Act', run: () => void ran.push('first') })
    act.run = async () => (ran.push('put in its place'), { done: true })
    const { fake, router } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] }) })
    await settle()
    fake.pick('Act')
    await settle()
    await router.run('act')
    expect(ran).toEqual(['put in its place', 'put in its place'])
  })

  it('runs nothing when an action an app made by hand, asked how much care it needs, opens another screen', async () => {
    const places: { router?: Router } = {}
    const ran: string[] = []
    let armed = false
    const own: Action = {
      id: 'own',
      say: 'Own',
      get risk() {
        if (armed) places.router?.open({ id: 'other', view: () => text({ body: 'Other' }) })
        armed = false
        return 'safe' as const
      },
      blocked: () => null,
      targets: () => null,
      run: async () => (ran.push('own'), { done: true }),
    }
    const { fake, router } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [own] }) })
    places.router = router
    await settle()
    armed = true
    fake.pick('Own')
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it('runs nothing for a shell that the app ended as it was asked for the work of an action', async () => {
    const life = new Lifetime()
    const mine = life.child()
    const fake = fakeBridge()
    const ran: string[] = []
    const act = action({
      id: 'act',
      say: 'Act',
      get run() {
        mine.end()
        return () => void ran.push('act')
      },
    })
    new Shell(
      mine,
      new Glasses(life, fake.bridge),
      new Router({ home: { id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] } }),
    )
    await settle()
    fake.pick('Act')
    await settle()
    expect(ran).toEqual([])
    life.end()
  })

  it.each(['at once', 'as whoever watches hears of the draw'])('takes back the frame it asked for when the app ends it %s', async when => {
    const life = new Lifetime()
    const mine = life.child()
    const fake = fakeBridge()
    let armed = false
    const glasses = new Glasses(life, fake.bridge, { watch: event => void (armed && event.at === 'ask' && mine.end()) })
    let body = 'Home'
    const shell = new Shell(mine, glasses, new Router({ home: { id: 'home', view: () => text({ body }) } }))
    await settle()
    body = 'After the end'
    armed = when !== 'at once'
    shell.redraw()
    mine.end()
    await settle()
    expect(fake.lines()).toEqual(['Home'])
    life.end()
  })

  it('asks an action an app made by hand for its work once at a tap, and runs the work it got then', async () => {
    const ran: number[] = []
    let asked = 0
    const own: Action = {
      id: 'own',
      say: 'Own',
      risk: 'safe',
      blocked: () => null,
      targets: () => null,
      get run() {
        const at = ++asked
        return async () => (ran.push(at), { done: true as const })
      },
    }
    const { fake } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [own] }) })
    await settle()
    asked = 0
    fake.pick('Own')
    await settle()
    expect([asked, ran]).toEqual([1, [1]])
  })

  it('keeps the place of a text that follows its end, though the app let it not follow for one swipe', async () => {
    let end = true
    const body = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n')
    const { fake, shell } = world({ home: () => ({ id: 'home', view: () => text({ title: 'Log', body, end }) }) })
    const last = () => fake.lines().at(-1)
    await settle()
    expect(last()).toBe('Line 30')
    fake.up()
    await settle()
    end = false
    shell.redraw()
    await settle()
    fake.up()
    await settle()
    const read = last()
    expect(read).not.toBe('Line 30')
    end = true
    shell.redraw()
    await settle()
    expect(last()).toBe(read)
  })

  it('asks an action for its work once at a tap, also one made by `action()` whose work the app then gave through a getter', async () => {
    const ran: number[] = []
    let asked = 0
    const act = action({ id: 'act', say: 'Act', run: () => {} })
    Object.defineProperty(act, 'run', {
      get: () => {
        const at = ++asked
        return async () => (ran.push(at), { done: true as const })
      },
    })
    const { fake } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] }) })
    await settle()
    asked = 0
    fake.pick('Act')
    await settle()
    expect([asked, ran]).toEqual([1, [1]])
  })

  it('reads the work of an action before the value of the row it is for, as it always did', async () => {
    const order: string[] = []
    const act = action({
      id: 'act',
      say: 'Act',
      targets: () => [
        {
          id: 'a',
          say: 'A',
          get value() {
            order.push('value')
            return 'a'
          },
        },
      ],
      get run() {
        order.push('work')
        return () => {}
      },
    })
    await act.run('a')
    expect(order).toEqual(['work', 'value'])
  })

  it('leaves a card the app drew over a question of the shell when the router is closed', async () => {
    const ran: string[] = []
    const wipe = action({ id: 'wipe', say: 'Wipe', risk: 'confirm', run: () => void ran.push('wipe') })
    const { fake, front, glasses, router } = world({
      home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [wipe] }),
    })
    await settle()
    fake.pick('Wipe')
    await settle(100)
    expect(front()).toContain('Wipe?')
    glasses.overlay('Paused')
    await settle(100)
    router.close()
    await settle(100)
    fake.tap()
    await settle(100)
    expect([front(), ran]).toEqual(['Paused', []])
  })

  it('runs an action an app made by hand, as it always did', async () => {
    const ran: string[] = []
    const own: Action = {
      id: 'own',
      say: 'Own',
      risk: 'safe',
      blocked: () => null,
      targets: () => null,
      run: async () => (ran.push('own'), { done: true }),
    }
    const { fake } = world({ home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [own] }) })
    await settle()
    fake.pick('Own')
    await settle()
    expect(ran).toEqual(['own'])
  })

  it('keeps the row the cursor is on when a draw that was dropped had fewer rows', async () => {
    const places: { shell?: Shell } = {}
    const rows = ['One', 'Two', 'Three', 'Four', 'Five']
    let armed = false
    const open = action({
      id: 'open',
      say: 'Open',
      targets: () => {
        const few = armed
        if (armed) {
          armed = false
          places.shell?.redraw()
        }
        return (few ? rows.slice(0, 1) : rows).map(row => ({ id: row, say: row, value: row }))
      },
      run: () => {},
    })
    const { fake, shell, cursor } = world({ home: () => ({ id: 'home', view: () => list({ title: 'Rows', action: open }) }) })
    places.shell = shell
    await settle()
    for (let at = 0; at < 4; at++) fake.down()
    await settle()
    expect(cursor()).toBe('Five')
    armed = true
    shell.redraw()
    await settle()
    shell.redraw()
    await settle()
    expect(cursor()).toBe('Five')
  })

  it('keeps the place a text is read at when a draw that was dropped had a shorter text', async () => {
    const places: { shell?: Shell } = {}
    const long = Array.from({ length: 40 }, (_, at) => `Line ${at + 1}`).join('\n')
    let armed = false
    const view = () => {
      const page = text({ body: long })
      Object.defineProperty(page, 'body', {
        get: () => {
          if (!armed) return long
          armed = false
          places.shell?.redraw()
          return 'Short'
        },
      })
      return page
    }
    const { fake, shell } = world({ home: () => ({ id: 'home', view }) })
    places.shell = shell
    const top = () => fake.lines()[0]
    await settle()
    fake.down()
    await settle()
    fake.down()
    await settle()
    const before = top()
    expect(before).not.toBe('Line 1')
    armed = true
    shell.redraw()
    await settle()
    shell.redraw()
    await settle()
    expect(top()).toBe(before)
  })

  it('takes a swipe up on a text that follows its end, though the app has since changed the view it gave', async () => {
    const body = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n')
    const first = text({ body, end: true })
    let given = 0
    const { fake } = world({ home: () => ({ id: 'home', view: () => (given++ === 0 ? first : text({ body, end: true })) }) })
    await settle()
    const tail = fake.lines()
    expect(tail.at(-1)).toBe('Line 30')
    ;(first as { end?: boolean }).end = false
    fake.up()
    await settle()
    expect(fake.lines().at(-1)).not.toBe('Line 30')
  })

  it('draws a screen with what a listener the app set on the router before the shell made ready for it', async () => {
    const life = new Lifetime()
    const fake = fakeBridge()
    const router = new Router({ home: { id: 'home', view: () => text({ body: 'Home' }) } })
    let label = 'Placeholder'
    router.onChange(current => void (current.id === 'timer' && (label = 'Timer ready')))
    new Shell(life, new Glasses(life, fake.bridge), router)
    await settle()
    router.open({ id: 'timer', view: () => text({ body: label }) })
    await settle()
    expect(fake.lines()).toEqual(['Timer ready'])
    life.end()
  })

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
  type Step = 'up' | 'down' | 'elsewhere' | 'drawn' | { more: string[] } | { keep: number }
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
      if (pick < 0.84) return { keep: 1 + Math.floor(next() * 40) }
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
        if ('keep' in step) log.length = Math.min(log.length, step.keep)
        else log.push(...step.more)
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

  it('lays the texts that came in the meantime out in the order they were asked for, also when one was asked for from inside the telling of another', async () => {
    let lines = 30
    let end = true
    let again = false
    const places: { shell?: Shell } = {}
    const watch = (event: Drawing) => {
      if (!again || event.at !== 'ask') return
      again = false
      lines = 24
      end = true
      places.shell?.redraw()
    }
    const { fake, router, shell } = world({ watch })
    places.shell = shell
    router.open({
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: lines }, (_, at) => `Line ${at + 1}`).join('\n'), end }),
    })
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 30')
    const release = held(fake)
    lines = 15
    end = false
    again = true
    shell.redraw()
    fake.up()
    release()
    await settle()
    const nested = fake.lines()

    lines = 30
    end = true
    router.back()
    router.open({
      id: 'log',
      view: () => text({ title: 'Log', body: Array.from({ length: lines }, (_, at) => `Line ${at + 1}`).join('\n'), end }),
    })
    await settle()
    fake.up()
    await settle()
    lines = 15
    end = false
    shell.redraw()
    await settle()
    lines = 24
    end = true
    shell.redraw()
    await settle()
    expect(nested).toEqual(fake.lines())
  })

  it('takes swipes on a frame though the shell was asked something else while that frame was being asked for', async () => {
    let poke = false
    const places: { fake?: ReturnType<typeof fakeBridge> } = {}
    const watch = (event: Drawing) => {
      if (!poke || event.at !== 'ask') return
      poke = false
      places.fake?.menu(999)
    }
    const { fake, router, shell } = world({ watch })
    places.fake = fake
    router.open({ id: 'log', view: () => text({ title: 'Log', body: Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n') }) })
    await settle()
    poke = true
    shell.redraw()
    await settle(4_000)
    expect(fake.lines()[1]).toBe('Line 1')
    fake.down()
    await settle()
    expect(fake.lines()[1]).toBe('Line 3')
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

  it('E15: runs no control while a picture beside it is refused, and runs it once the glasses show the whole frame', async () => {
    const ran: string[] = []
    const { fake, router } = world()
    const pause = action({ id: 'pause', say: 'Pause', run: () => void ran.push('pause') })
    fake.refuse('picture', 3)
    router.open({
      id: 'player',
      view: () =>
        boxes([{ id: 'prompt', x: 0, y: 0, w: 200, h: 40, text: 'Tap to pause' }], {
          on: { tap: pause },
          pictures: [{ id: 'cover', x: 376, y: 54, w: 200, h: 100, key: 'v1', data: new Uint8Array([1, 2, 3]) }],
        }),
    })
    await settle()
    expect(fake.lines()).toEqual(['Tap to pause'])
    fake.tap()
    await settle(100)
    const early = [...ran]
    await settle(60_000)
    fake.tap()
    await settle(100)
    expect([early, ran]).toEqual([[], ['pause']])
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

  it('takes no swipe on a text before any of its words are on the glasses', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    let created = () => {}
    const creating = new Promise<void>(go => (created = go))
    const real = fake.bridge.createStartUpPageContainer
    fake.bridge.createStartUpPageContainer = async page => (await creating, real(page))
    const body = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n')
    new Shell(life, glasses, new Router({ home: { id: 'log', view: () => text({ title: 'Log', body }) } }))
    fake.down()
    created()
    await settle()
    expect(fake.lines()[1]).toBe('Line 1')
    life.end()
  })

  it('leaves a frame the app drew on the glasses itself when the router is closed, and takes back only its own', async () => {
    const { fake, glasses, router, shell } = world()
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Never to be shown'
    shell.redraw()
    glasses.draw({ boxes: [{ id: 'count', x: 0, y: 0, w: 200, h: 40, text: 'Countdown' }] })
    router.close()
    await settle()
    expect(fake.lines()).toEqual(['Countdown'])
  })

  it('sends the glasses no blank page when the router is closed before anything was shown', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const router = new Router({ home: { id: 'home', view: () => text({ body: 'Home' }) } })
    new Shell(life, new Glasses(life, fake.bridge), router)
    router.close()
    await settle()
    expect(fake.calls).toEqual([])
    life.end()
  })

  it('takes back its frames when the router is closed, also when what a turn left behind throws as it is called off', async () => {
    const { fake, life, router, shell } = world({
      voice: {
        transcribe: (_audio, turn) => {
          turn?.own(() => {
            throw new Error('cleanup failed')
          })
          return new Promise<string>(() => {})
        },
      },
    })
    let body = 'Before'
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    body = 'Never to be shown'
    shell.redraw()
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    expect(() => router.close()).not.toThrow()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
    await settle()
    expect(fake.lines().join(' ')).not.toContain('Never to be shown')
    life.end()
  })

  it('lets an app replace its home screen also when that screen redraws as it leaves', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    const made: { shell?: Shell } = {}
    const router = new Router({
      home: { id: 'home', enter: left => void left.own(() => made.shell?.redraw()), view: () => text({ body: 'Home' }) },
    })
    made.shell = new Shell(life, glasses, router)
    await settle()
    router.replace({ id: 'next', view: () => text({ body: 'Next home' }) })
    await settle()
    expect(fake.lines()).toEqual(['Next home'])
    life.end()
  })

  it('takes no swipe on its text while the glasses show a frame the app drew on them itself, in place of its first', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const glasses = new Glasses(life, fake.bridge)
    const body = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n')
    new Shell(life, glasses, new Router({ home: { id: 'log', view: () => text({ title: 'Log', body }) } }))
    glasses.draw({ boxes: [{ id: 'count', x: 0, y: 0, w: 200, h: 40, text: 'Countdown' }] })
    await settle()
    expect(fake.lines()).toEqual(['Countdown'])
    fake.down()
    await settle()
    expect(fake.lines()).toEqual(['Countdown'])
    life.end()
  })

  it('sends the glasses no empty page when the router is closed by the first screen as it is asked for its view', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    let closed = false
    const router: Router = new Router({
      home: {
        id: 'home',
        view: () => {
          if (!closed) {
            closed = true
            router.close()
          }
          return text({ body: 'Home' })
        },
      },
    })
    new Shell(life, new Glasses(life, fake.bridge), router)
    await settle()
    expect(fake.calls).toEqual([])
    life.end()
  })

  it('opens no list of rows for an action whose screen was replaced as the app was asked for those rows', async () => {
    const { fake, router } = world()
    let moved = false
    const rows = action({
      id: 'rows',
      say: 'Rows',
      targets: () => {
        if (!moved) {
          moved = true
          router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        }
        return [{ id: 'a', say: 'Row', value: 'a' }]
      },
      run: () => {},
    })
    router.open({ id: 'card', actions: () => [rows], view: () => text({ body: 'Card' }) })
    await settle()
    moved = false
    fake.pick('Rows')
    await settle()
    expect(router.current.id).toBe('other')
  })

  it('sends the glasses no frame that a draw asked for from inside another, when the router is closed right after', async () => {
    let nest = false
    let body = 'Before'
    const watch = (event: Drawing) => {
      if (!nest || event.at !== 'ask') return
      nest = false
      body = 'Nested'
      shell.redraw()
    }
    const { fake, router, shell } = world({ watch })
    router.open({ id: 'note', view: () => text({ body }) })
    await settle()
    body = 'Outer'
    nest = true
    shell.redraw()
    router.close()
    await settle()
    expect(fake.lines()).toEqual(['Before'])
  })

  it('keeps a notice a home screen gives as it is replaced, for as long as any notice stays', async () => {
    const fake = fakeBridge()
    const life = new Lifetime()
    const made: { shell?: Shell } = {}
    const router = new Router({
      home: { id: 'home', enter: left => void left.own(() => made.shell?.notice('Saved')), view: () => text({ body: 'Home' }) },
    })
    made.shell = new Shell(life, new Glasses(life, fake.bridge), router)
    await settle()
    router.replace({ id: 'next', view: () => text({ body: 'Next home' }) })
    await settle()
    expect(fake.overlay()).toBe('Saved')
    life.end()
  })

  it('counts a swipe from the very words it drew, also when the app gives them through a getter that later says more', async () => {
    const { fake, router } = world()
    let reads = 0
    const view = {
      kind: 'text' as const,
      end: true,
      get body() {
        return Array.from({ length: reads++ ? 40 : 30 }, (_, at) => `Line ${at + 1}`).join('\n')
      },
    }
    router.open({ id: 'log', view: () => view })
    await settle()
    const first = fake.lines()[0]
    fake.up()
    await settle()
    expect([first, fake.lines()[0]]).toEqual(['Line 21', 'Line 19'])
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

  it('lays out after a swipe every text that came in the meantime, a shorter one too, not only the newest', async () => {
    const { fake, router, shell } = world()
    let lines = 30
    const body = () => Array.from({ length: lines }, (_, at) => `Line ${at + 1}`).join('\n')
    router.open({ id: 'log', view: () => text({ title: 'Log', body: body(), end: true }) })
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 30')
    const release = held(fake)
    lines = 8
    shell.redraw()
    lines = 40
    shell.redraw()
    fake.up()
    release()
    await settle()
    expect(fake.lines().at(-1)).toBe('Line 40')
  })

  it('goes on drawing a screen, and taking its swipes, when the app itself ended the lifetime the screen was given', async () => {
    const lives: Lifetime[] = []
    let body = Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n')
    const { fake, router, shell } = world()
    router.open({ id: 'log', enter: life => void lives.push(life), view: () => text({ body }) })
    await settle()
    lives[0].end()
    body = body.replace('Line 1\n', 'First line\n')
    shell.redraw()
    await settle()
    expect(fake.lines()[0]).toBe('First line')
    fake.down()
    await settle()
    expect(fake.lines()[0]).toBe('Line 3')
    router.back()
    await settle()
    expect(fake.lines()[0]).toBe('People')
  })

  it('leaves a card an app drew on the glasses itself when the router is closed with nothing of the shell up', async () => {
    const { fake, glasses, router } = world()
    await settle()
    glasses.overlay('Paused')
    await settle()
    router.close()
    await settle()
    expect(fake.overlay()).toBe('Paused')
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
    await settle()
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
    await settle()
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

describe('a tap while a redraw is on its way to the glasses', () => {
  const held = (fake: ReturnType<typeof fakeBridge>) => {
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let answer: (() => void) | undefined
    fake.bridge.textContainerUpgrade = async upgrade => {
      if (!answer) await new Promise<void>(done => (answer = done))
      return send(upgrade)
    }
    return () => answer!()
  }

  it('E15: runs no row of a list but the one the glasses show the cursor on', async () => {
    const { fake, cursor, ran } = world()
    await settle()
    const answer = held(fake)
    fake.down()
    await settle(0)
    expect(cursor()).toBe(names[0])
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer()
    await settle()
    expect(cursor()).toBe(names[1])
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[1]}`])
  })

  it('E15: runs nothing while the glasses still show the list under the one just opened, whole, though both have the same row under the cursor', async () => {
    const { fake, open, ran, router } = world()
    await settle(0)
    const before = fake.calls.length
    router.open({ id: 'again', view: () => list({ title: 'Again', action: open }) })
    await settle(0)
    fake.tap()
    await settle(0)
    expect([ran, fake.calls.slice(before), fake.lines()[0]]).toEqual([[], [], 'People'])
    await settle()
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs no row of a list while the glasses show a page the app drew on them itself', async () => {
    const { fake, glasses, ran, shell } = world()
    await settle()
    glasses.draw({ boxes: [{ id: 'own', x: 0, y: 0, w: 576, h: 27, text: 'Drawn by the app' }] })
    await settle()
    fake.tap()
    await settle()
    const over = [...ran]
    shell.redraw()
    await settle()
    fake.tap()
    await settle()
    expect([fake.lines().length > 0, over, ran]).toEqual([true, [], [`open ${names[0]}`]])
  })

  it('E15: runs no row when a tap comes as the move of the cursor is asked for: the glasses show the old row, and the tap would run the new one', async () => {
    let armed = false
    const made: { world?: ReturnType<typeof world> } = {}
    made.world = world({
      watch: event => {
        if (event.at !== 'ask' || !armed) return
        armed = false
        made.world?.fake.tap()
      },
    })
    const { fake, cursor, ran } = made.world
    await settle()
    armed = true
    fake.down()
    await settle()
    expect([armed, ran, cursor()]).toEqual([false, [], names[1]])
  })

  it('E15: draws a screen of boxes that leaves a gesture unbound by naming it with nothing, and runs nothing on it', async () => {
    const paused: string[] = []
    const pause = action({ id: 'pause', say: 'Pause', run: () => void paused.push('pause') })
    const on: { tap?: Action; up?: Action } = { up: pause }
    Object.assign(on, { tap: undefined })
    const { fake } = world({
      home: () => ({ id: 'timer', view: () => boxes([{ id: 'time', x: 0, y: 0, w: 200, h: 40, text: '10:00' }], { on }) }),
    })
    await settle()
    fake.tap()
    fake.up()
    await settle()
    expect([fake.lines(), paused]).toEqual([['10:00'], ['pause']])
  })

  it('E15: runs nothing on a gesture of a screen of boxes while the glasses show, whole, the frame that tied it to something else', async () => {
    const did: string[] = []
    const pause = action({ id: 'pause', say: 'Pause', run: () => void did.push('pause') })
    const resume = action({ id: 'resume', say: 'Resume', run: () => void did.push('resume') })
    let running = true
    const { fake, shell } = world({
      home: () => ({
        id: 'timer',
        view: () =>
          boxes(
            [
              { id: 'time', x: 0, y: 0, w: 200, h: 40, text: '10:00' },
              ...(running ? [] : [{ id: 'note', x: 0, y: 40, w: 200, h: 40, text: 'Paused' }]),
            ],
            { on: { tap: running ? pause : resume } },
          ),
      }),
    })
    await settle(0)
    const before = fake.calls.length
    running = false
    shell.redraw()
    await settle(0)
    fake.tap()
    await settle(0)
    expect([did, fake.calls.slice(before), fake.lines()]).toEqual([[], [], ['10:00']])
    await settle()
    fake.tap()
    await settle()
    expect(did).toEqual(['resume'])
  })

  it('E15: runs a gesture on the very target it was checked for, though the binding would name another when read again', async () => {
    const went: string[] = []
    const go = action({
      id: 'go',
      say: 'Go',
      targets: () => ['north', 'south'].map(id => ({ id, say: id, value: id })),
      run: to => void went.push(to),
    })
    let reads: string[] = ['north']
    const tap = {
      action: go,
      get target() {
        return reads.length > 1 ? (reads.shift() as string) : reads[0]
      },
    }
    const { fake } = world({
      home: () => ({ id: 'trail', view: () => boxes([{ id: 'to', x: 0, y: 0, w: 200, h: 40, text: 'North' }], { on: { tap } }) }),
    })
    await settle()
    reads = ['north', 'south']
    fake.tap()
    await settle()
    expect(went).toEqual(['north'])
  })

  it('E15: draws a screen of boxes whose gesture is given through a getter that later gives nothing: each draw reads it once', async () => {
    const pause = action({ id: 'pause', say: 'Pause', run: () => {} })
    let reads = 0
    const on = {
      get tap() {
        return ++reads > 2 ? undefined : pause
      },
    }
    const { fake } = world({
      home: () => ({ id: 'timer', view: () => boxes([{ id: 'time', x: 0, y: 0, w: 200, h: 40, text: '10:00' }], { on }) }),
    })
    await settle()
    expect([fake.lines(), reads]).toEqual([['10:00'], 1])
  })

  it('E15: runs a tap on a list on the very row it was checked for, though the row would name another when read again', async () => {
    const went: string[] = []
    let armed = false
    const northern = () => {
      let reads = 0
      return {
        get id() {
          return armed && reads++ === 1 ? 'south' : 'north'
        },
        say: 'North',
        value: 'north',
      }
    }
    const go: Action = action({
      id: 'go',
      say: 'Go',
      targets: () => ['north', 'south'].map(id => ({ id, say: id, value: id })),
      run: to => void went.push(to),
    })
    Object.defineProperty(go, 'targets', { value: () => [northern(), { id: 'south', say: 'South' }] })
    const { fake } = world({ home: () => ({ id: 'trail', view: () => list({ title: 'Trail', action: go }) }) })
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect(went).toEqual(['north'])
  })

  it('E15: runs a tap on a list with the very action it was checked for, though the list would name another when read again', async () => {
    const did: string[] = []
    const targets = () => [{ id: 'note', say: 'Note', value: 'note' }]
    const open = action({ id: 'open', say: 'Open', targets, run: () => void did.push('open') })
    const remove = action({ id: 'remove', say: 'Remove', targets, run: () => void did.push('remove') })
    let armed = false
    let reads = 0
    const view = list({ title: 'Notes', action: open })
    Object.defineProperty(view, 'action', { get: () => (armed && reads++ === 1 ? remove : open) })
    const { fake } = world({ home: () => ({ id: 'notes', actions: () => [remove], view: () => view }) })
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect(did).toEqual(['open'])
  })

  it('E15: reads nothing of a list on a tap when it has no row: there is nothing the tap could run', async () => {
    const made: { router?: Router } = {}
    let armed = false
    const open = action({ id: 'open', say: 'Open', targets: () => [], run: () => {} })
    const view = list({ title: 'Stock', action: open, empty: 'Nothing here' })
    Object.defineProperty(view, 'action', {
      get: () => {
        if (armed) made.router?.open({ id: 'details', view: () => text({ body: 'Details' }) })
        return open
      },
    })
    const { fake, router } = world({ home: () => ({ id: 'stock', view: () => view }) })
    made.router = router
    await settle()
    armed = true
    fake.tap()
    armed = false
    await settle()
    expect(fake.lines().join(' ')).not.toContain('Details')
  })

  it('E15: reads nothing of a binding for a touch it drops because the glasses show no whole frame', async () => {
    let reads = 0
    let label = 'Pause'
    const pause = action({ id: 'pause', say: 'Pause', targets: () => [{ id: 'now', say: 'Now', value: 'now' }], run: () => {} })
    const tap = {
      action: pause,
      get target() {
        reads++
        return 'now'
      },
    }
    const { fake, shell } = world({
      home: () => ({ id: 'timer', view: () => boxes([{ id: 'time', x: 0, y: 0, w: 200, h: 40, text: label }], { on: { tap } }) }),
    })
    await settle()
    const answer = held(fake)
    label = 'Paused'
    shell.redraw()
    await settle(0)
    const before = reads
    fake.tap()
    await settle(0)
    const during = reads
    answer()
    await settle()
    expect(during - before).toBe(0)
  })

  it('E15: reads nothing of a row for a tap it drops because the glasses show no whole frame', async () => {
    let reads = 0
    let title = 'Trail'
    const go = action({ id: 'go', say: 'Go', targets: () => [{ id: 'north', say: 'North', value: 'north' }], run: () => {} })
    Object.defineProperty(go, 'targets', {
      value: () => [
        {
          get id() {
            reads++
            return 'north'
          },
          say: 'North',
        },
      ],
    })
    const { fake, shell } = world({ home: () => ({ id: 'trail', view: () => list({ title, action: go }) }) })
    await settle()
    const answer = held(fake)
    title = 'Trail north'
    shell.redraw()
    await settle(0)
    const before = reads
    fake.tap()
    await settle(0)
    const during = reads
    answer()
    await settle()
    expect(during - before).toBe(0)
  })

  it('E15: reads the action of a list once at a draw, for its rows, its menu and what a tap runs, so a tap runs the action whose rows are shown', async () => {
    const did: string[] = []
    const targets = () => [{ id: 'note', say: 'Note', value: 'note' }]
    const open = action({ id: 'open', say: 'Open', targets, run: () => void did.push('open') })
    const remove = action({ id: 'remove', say: 'Remove', targets, run: () => void did.push('remove') })
    let reads = 0
    const view = list({ title: 'Notes', action: open })
    Object.defineProperty(view, 'action', { get: () => (++reads === 3 ? remove : open) })
    const { fake } = world({ home: () => ({ id: 'notes', view: () => view }) })
    await settle()
    const atDraw = reads
    fake.tap()
    await settle()
    expect([atDraw, did]).toEqual([1, ['open']])
  })

  it('E15: asks the action a list has now, when the app put another of the same name in its place without a redraw: a blocked one says why and nothing runs', async () => {
    const went: string[] = []
    const rows = () => [{ id: 'north', say: 'North', value: 'north' }]
    const open = action({ id: 'go', say: 'Go', targets: rows, run: to => void went.push(to) })
    const closed = action({ id: 'go', say: 'Go', targets: rows, blocked: () => 'Route closed', run: to => void went.push(`closed ${to}`) })
    const view = list({ title: 'Trail', action: open })
    const { fake, front } = world({ home: () => ({ id: 'trail', view: () => view }) })
    await settle()
    Object.assign(view, { action: closed })
    fake.tap()
    await settle(100)
    expect([went, front()]).toEqual([[], 'Route closed'])
  })

  it('E15: runs no row of a list when reading what its tap is tied to moved the screen on', async () => {
    const sent: string[] = []
    const made: { router?: Router } = {}
    let armed = false
    const send = action({
      id: 'send',
      say: 'Send',
      targets: () => [{ id: 'ana', say: 'Ana', value: 'Ana' }],
      run: to => void sent.push(to),
    })
    Object.defineProperty(send, 'id', {
      get: () => {
        if (armed) {
          armed = false
          made.router?.open({ id: 'child', view: () => text({ body: 'Child' }) })
        }
        return 'send'
      },
    })
    const { fake, router } = world({ home: () => ({ id: 'mail', view: () => list({ title: 'To', action: send }) }) })
    made.router = router
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect([sent, fake.lines()]).toEqual([[], ['Child']])
  })

  it('E15: runs no gesture of a screen of boxes when reading what it is tied to moved the screen on', async () => {
    const sent: string[] = []
    const made: { router?: Router } = {}
    let armed = false
    const send = action({ id: 'send', say: 'Send', run: () => void sent.push('send') })
    Object.defineProperty(send, 'id', {
      get: () => {
        if (armed) {
          armed = false
          made.router?.open({ id: 'child', view: () => text({ body: 'Child' }) })
        }
        return 'send'
      },
    })
    const { fake, router } = world({
      home: () => ({ id: 'mail', view: () => boxes([{ id: 'go', x: 0, y: 0, w: 200, h: 40, text: 'Send' }], { on: { tap: send } }) }),
    })
    made.router = router
    await settle()
    armed = true
    fake.tap()
    await settle()
    expect([sent, fake.lines()]).toEqual([[], ['Child']])
  })

  it('E15: runs the gesture a screen of boxes gives through a getter, once the glasses show its frame whole', async () => {
    const paused: string[] = []
    const pause = action({ id: 'pause', say: 'Pause', run: () => void paused.push('pause') })
    class Controls {
      get tap() {
        return pause
      }
    }
    const { fake } = world({
      home: () => ({ id: 'timer', view: () => boxes([{ id: 'time', x: 0, y: 0, w: 200, h: 40, text: '10:00' }], { on: new Controls() }) }),
    })
    await settle()
    fake.tap()
    await settle()
    expect(paused).toEqual(['pause'])
  })

  it('E15: runs the row the glasses show also when its frame was asked for from inside the telling of an older one', async () => {
    let once = false
    const made: { world?: ReturnType<typeof world> } = {}
    made.world = world({
      watch: event => {
        if (event.at !== 'ask' || !once || !made.world) return
        once = false
        made.world.people.unshift('Zed')
        made.world.shell.redraw()
      },
    })
    const { fake, ran, shell } = made.world
    await settle()
    once = true
    shell.redraw()
    await settle()
    fake.tap()
    await settle()
    expect(ran).toEqual(['open Zed'])
  })

  it('E15: runs nothing while a redraw is being written, even one that leaves the row as it is: the glasses show a mix of two frames', async () => {
    const { fake, ran, people, shell } = world()
    await settle()
    const answer = held(fake)
    people.push('Dee')
    shell.redraw()
    await settle(0)
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer()
    await settle()
    expect(fake.lines().join(' ')).toContain('Dee')
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs nothing while the marker of a list has moved and its rows have not: the same row is under the cursor in both frames, not in the mix', async () => {
    const { fake, ran, people } = world()
    await settle()
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let writes = 0
    let answer: (() => void) | undefined
    fake.bridge.textContainerUpgrade = async upgrade => {
      if (++writes === 2) await new Promise<void>(done => (answer = done))
      return send(upgrade)
    }
    people.splice(0, 2, names[1], names[0])
    fake.down()
    await settle(0)
    expect(answer).toBeDefined()
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer!()
    await settle()
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs nothing on a gesture of a screen of boxes that the screen on show ties to something else', async () => {
    let playing = false
    const { fake, ran, shell } = world({
      home: ({ ran }) => {
        const play = action({ id: 'play', say: 'Play', run: () => void ran.push('play') })
        const pause = action({ id: 'pause', say: 'Pause', run: () => void ran.push('pause') })
        return {
          id: 'player',
          actions: () => [],
          view: () =>
            boxes([{ id: 'only', x: 0, y: 0, w: 576, h: 27, text: playing ? 'Playing' : 'Stopped' }], {
              on: { tap: playing ? pause : play },
            }),
        }
      },
    })
    await settle()
    const answer = held(fake)
    playing = true
    shell.redraw()
    await settle(0)
    expect(fake.lines()).toEqual(['Stopped'])
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer()
    await settle()
    expect(fake.lines()).toEqual(['Playing'])
    fake.tap()
    await settle()
    expect(ran).toEqual(['pause'])
  })

  it('E15: runs nothing while a frame between the one answered and the newest may be partly on show', async () => {
    let playing = false
    const { fake, ran, shell } = world({
      home: ({ ran }) => {
        const play = action({ id: 'play', say: 'Play', run: () => void ran.push('play') })
        const pause = action({ id: 'pause', say: 'Pause', run: () => void ran.push('pause') })
        return {
          id: 'player',
          actions: () => [],
          view: () =>
            boxes(
              [
                { id: 'label', x: 0, y: 0, w: 576, h: 27, text: playing ? 'Pause' : 'Play' },
                { id: 'state', x: 0, y: 27, w: 576, h: 27, text: playing ? 'Playing' : 'Stopped' },
              ],
              { on: { tap: playing ? pause : play } },
            ),
        }
      },
    })
    await settle()
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let writes = 0
    let answer: (() => void) | undefined
    fake.bridge.textContainerUpgrade = async upgrade => {
      if (++writes === 2) await new Promise<void>(done => (answer = done))
      return send(upgrade)
    }
    playing = true
    shell.redraw()
    await settle(0)
    expect(fake.lines()).toEqual(['Pause', 'Stopped'])
    playing = false
    shell.redraw()
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer!()
    await settle()
    expect(fake.lines()).toEqual(['Play', 'Stopped'])
    fake.tap()
    await settle()
    expect(ran).toEqual(['play'])
  })

  const player = (shows: () => { text: string; picture: string; playing: boolean }) =>
    world({
      home: ({ ran }) => {
        const play = action({ id: 'play', say: 'Play', run: () => void ran.push('play') })
        const pause = action({ id: 'pause', say: 'Pause', run: () => void ran.push('pause') })
        return {
          id: 'player',
          actions: () => [],
          view: () =>
            boxes([{ id: 'status', x: 0, y: 0, w: 576, h: 27, text: shows().text }], {
              on: { tap: shows().playing ? pause : play },
              pictures: [
                { id: 'button', x: 300, y: 54, w: 200, h: 100, key: shows().picture, data: new Uint8Array([shows().picture.length]) },
              ],
            }),
        }
      },
    })

  it('E15: runs nothing while a picture of a frame between the one answered and the newest may be on show', async () => {
    let now = { text: 'Song', picture: 'play', playing: false }
    const { fake, ran, shell } = player(() => now)
    await settle()
    const hang = fake.bridge.updateImageRawData.bind(fake.bridge)
    let answer: (() => void) | undefined
    fake.bridge.updateImageRawData = async update => {
      const result = await hang(update)
      if (!answer) await new Promise<void>(done => (answer = done))
      return result
    }
    now = { text: 'Song', picture: 'pause', playing: true }
    shell.redraw()
    await settle(0)
    expect(answer).toBeDefined()
    now = { text: 'Song', picture: 'play', playing: false }
    shell.redraw()
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer!()
    await settle()
    fake.tap()
    await settle()
    expect(ran).toEqual(['play'])
  })

  it('still runs what a tap is tied to while newer frames are asked for and none of them is sent yet: the glasses show the old one whole', async () => {
    let now = { text: 'One', picture: 'play', playing: false }
    const { fake, ran, shell } = player(() => now)
    await settle()
    now = { text: 'One', picture: 'play', playing: true }
    shell.redraw()
    now = { text: 'Two', picture: 'play', playing: false }
    shell.redraw()
    fake.tap()
    await settle()
    expect(ran).toEqual(['play'])
    expect(fake.lines()).toEqual(['Two'])
  })

  it('E15: runs nothing on a tap of an empty list, also when the screen is on its way to tying a tap to that action', async () => {
    let listed = true
    const { fake, ran, shell } = world({
      home: ({ refresh }) => ({
        id: 'home',
        actions: () => [],
        view: () =>
          listed
            ? list({ title: 'Home', action: refresh })
            : boxes([{ id: 'only', x: 0, y: 0, w: 576, h: 27, text: 'Refresh' }], { on: { tap: refresh } }),
      }),
    })
    await settle()
    fake.refuse('rebuild', 100)
    listed = false
    shell.redraw()
    await settle(0)
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
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
    await settle()
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

  it('E15: runs nothing on a tap or a swipe that takes a notice away: the notice covered the rows it would have chosen from', async () => {
    const { fake, front, cursor, ran, shell } = world()
    await settle()
    shell.notice('Saved')
    await settle()
    fake.tap()
    await settle()
    expect(front()).toBe('')
    expect(ran).toEqual([])
    shell.notice('Saved')
    await settle()
    fake.down()
    await settle()
    expect(front()).toBe('')
    expect(cursor()).toBe(names[0])
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs nothing on a tap while the glasses still show a notice they have not taken away yet', async () => {
    const { fake, front, ran, shell } = world()
    await settle()
    shell.notice('Saved')
    await settle()
    fake.refuse('update', 100)
    await settle(3_000)
    expect(front()).toBe('Saved')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
    fake.refuse('update', 0)
    await settle(10_000)
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs nothing on a tap under a notice the glasses took only part of, also when an older draw was answered meanwhile', async () => {
    const { fake, front, ran, shell } = world()
    await settle()
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let answer: (() => void) | undefined
    let refusing = false
    fake.bridge.textContainerUpgrade = async upgrade => {
      if (!answer) await new Promise<void>(done => (answer = done))
      if (refusing) return false
      refusing = String(upgrade.content).includes('Saved')
      return send(upgrade)
    }
    fake.down()
    await settle(0)
    shell.notice('Saved')
    answer!()
    await settle(3_500)
    expect(front()).toBe('Saved')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
    refusing = false
    await settle(10_000)
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[1]}`])
  })

  it('E15: runs nothing on a second tap while the notice is still on its way to the glasses, which have not answered yet', async () => {
    const { fake, front, ran, shell } = world()
    await settle()
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let answer: (() => void) | undefined
    fake.bridge.textContainerUpgrade = async upgrade => {
      const accepted = await send(upgrade)
      if (!answer) await new Promise<void>(done => (answer = done))
      return accepted
    }
    shell.notice('Saved')
    await settle(0)
    expect(front()).toBe('Saved')
    fake.tap()
    fake.tap()
    await settle(0)
    expect(ran).toEqual([])
    answer!()
    await settle()
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('takes taps again after a notice the glasses refused: what they may have shown of it is written over', async () => {
    const { fake, front, ran, shell } = world()
    await settle()
    fake.refuse('update', 1)
    shell.notice('Saved')
    await settle(0)
    fake.tap()
    await settle(1_000)
    expect(front()).toBe('')
    expect(ran).toEqual([])
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: runs nothing on a tap after the card of a notice is gone but before the rows it cut are back', async () => {
    const { fake, front, ran, shell } = world()
    await settle()
    shell.notice('Saved')
    await settle()
    const send = fake.bridge.textContainerUpgrade.bind(fake.bridge)
    let cardOnly = true
    fake.bridge.textContainerUpgrade = async upgrade => (cardOnly && upgrade.containerID !== 1 ? false : send(upgrade))
    fake.tap()
    await settle()
    expect(front()).toBe('')
    fake.tap()
    await settle()
    expect(ran).toEqual([])
    cardOnly = false
    await settle(10_000)
    fake.tap()
    await settle()
    expect(ran).toEqual([`open ${names[0]}`])
  })

  it('E15: takes no tap for a yes to a question the glasses do not show yet: an older notice is still there', async () => {
    const sent: string[] = []
    const { fake, front, shell } = world({
      home: () => ({
        id: 'home',
        actions: () => [action({ id: 'send', say: 'Send', risk: 'confirm', run: () => void sent.push('sent') })],
        view: () => text({ title: 'Home', body: 'Hello' }),
      }),
    })
    await settle()
    shell.notice('Saved')
    await settle()
    fake.refuse('update', 100)
    fake.pick('Send')
    await settle()
    expect(front()).toBe('Saved')
    fake.tap()
    await settle()
    expect(sent).toEqual([])
    fake.refuse('update', 0)
    await settle(10_000)
    expect(front()).toContain('Send?')
    fake.tap()
    await settle()
    expect(sent).toEqual(['sent'])
  })

  it('still goes up at a double tap, and still runs a pick from the menu, while a notice shows: neither chooses from what it covers', async () => {
    const { fake, front, ran, shell, router } = world()
    await settle()
    fake.tap()
    await settle()
    expect(router.depth).toBe(2)
    shell.notice('Saved')
    await settle()
    fake.double()
    await settle()
    expect(front()).toBe('')
    expect(router.depth).toBe(1)
    shell.notice('Saved')
    await settle()
    fake.pick('Refresh')
    await settle()
    expect(ran).toEqual([`open ${names[0]}`, 'refresh'])
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
    await settle()
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

  it('asks nothing for an action that replaced its own screen as it was asked whether it may run', async () => {
    const ran: string[] = []
    const { fake, front, router } = world()
    let moved = false
    const risky = action({
      id: 'risky',
      say: 'Risky',
      risk: 'confirm',
      blocked: () => {
        if (!moved) {
          moved = true
          router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
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

  it('takes the question off the glasses when the router is closed', async () => {
    const { fake, front, router } = await asked()
    expect(front()).toBe('Delete: Ben?\nTap to confirm')
    router.close()
    await settle()
    expect(front()).toBe('')
    expect(fake.lines()).toContain('Hello')
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

  it('asks the model nothing when the screen moved on as the app was asked for the rows of an action', async () => {
    const asked: string[] = []
    const { voice } = hearing('open ben')
    voice.model = {
      choose: async question => {
        asked.push(question.screen ?? 'asked')
        return matchWords.choose(question)
      },
    }
    const { fake, router } = world({ voice })
    let moved = false
    const rows = action({
      id: 'rows',
      say: 'Rows',
      targets: () => {
        if (!moved) {
          moved = true
          router.open({ id: 'child', view: () => text({ body: 'Child' }) })
        }
        return [{ id: 'a', say: 'Row', value: 'a' }]
      },
      run: () => {},
    })
    router.open({ id: 'card', actions: () => [rows], view: () => text({ body: 'Card' }) })
    await settle()
    moved = false
    await say(fake)
    await settle()
    expect(asked).toEqual([])
  })

  it('keeps a notice that a screen gives as it leaves, after a turn said on that screen is over', async () => {
    const { voice } = hearing('go back')
    const { fake, front, router, shell } = world({ voice })
    router.open({ id: 'child', enter: life => void life.own(() => shell.notice('Saved')), view: () => text({ body: 'Child' }) })
    await settle()
    await say(fake)
    await settle(100)
    expect(router.current.id).toBe('people')
    expect(front()).toBe('Saved')
  })

  it('puts up no question, and hands the words to no agent, when the screen moved on as the app was asked what to offer instead', async () => {
    const heard: string[] = []
    const ran: string[] = []
    const { voice } = hearing('erase')
    voice.agents = [said => (heard.push(said.words), { kind: 'notMine' })]
    let moved = false
    const { fake, front, router } = world({ voice })
    Object.defineProperty(voice, 'instead', {
      get: () => {
        if (!moved) {
          moved = true
          router.open({ id: 'child', view: () => text({ body: 'Child' }) })
        }
        return 'Keep as a note'
      },
    })
    const erase = action({ id: 'erase', say: 'Erase', risk: 'confirm', run: () => void ran.push('erase') })
    router.open({ id: 'card', actions: () => [erase], view: () => text({ body: 'Card' }) })
    await settle()
    moved = false
    await say(fake)
    await settle()
    expect(front()).not.toContain('Tap to confirm')
    fake.up()
    fake.tap()
    await settle()
    expect([ran, heard]).toEqual([[], []])
  })

  it('puts up no question when a screen was opened and left as the app was asked what to offer instead', async () => {
    const ran: string[] = []
    const { voice } = hearing('erase')
    voice.agents = [() => ({ kind: 'notMine' })]
    let armed = false
    const { fake, front, router } = world({ voice })
    Object.defineProperty(voice, 'instead', {
      get: () => {
        if (armed) {
          armed = false
          router.open({ id: 'child', view: () => text({ body: 'Child' }) })
          router.back()
        }
        return 'Keep as a note'
      },
    })
    const erase = action({ id: 'erase', say: 'Erase', risk: 'confirm', run: () => void ran.push('erase') })
    router.open({ id: 'card', actions: () => [erase], view: () => text({ body: 'Card' }) })
    await settle()
    armed = true
    await say(fake)
    await settle()
    expect([front(), router.current.id]).toEqual(['"erase"', 'card'])
    fake.tap()
    await settle()
    expect(ran).toEqual([])
  })

  it('opens no list of candidates when a screen was opened and left as the app was asked what to offer instead', async () => {
    const { voice } = hearing('open')
    voice.agents = [() => ({ kind: 'notMine' })]
    voice.model = { choose: async ({ options }) => Object.fromEntries(options.slice(0, 2).map(option => [option.id, 0.5])) }
    let armed = true
    const { fake, router } = world({ voice })
    Object.defineProperty(voice, 'instead', {
      get: () => {
        if (armed) {
          armed = false
          router.open({ id: 'child', view: () => text({ body: 'Child' }) })
          router.back()
        }
        return 'Keep as a note'
      },
    })
    await settle()
    await say(fake)
    await settle()
    expect([router.current.id, fake.lines().includes('Which one?')]).toEqual(['people', false])
  })

  it('opens no list of candidates, and hands the words to no agent, when the screen moved on as the app was asked what to offer instead', async () => {
    const heard: string[] = []
    const { voice } = hearing('open')
    voice.agents = [said => (heard.push(said.words), { kind: 'notMine' })]
    voice.model = { choose: async ({ options }) => Object.fromEntries(options.slice(0, 2).map(option => [option.id, 0.5])) }
    let moved = false
    const { fake, router } = world({ voice })
    Object.defineProperty(voice, 'instead', {
      get: () => {
        if (!moved) {
          moved = true
          router.open({ id: 'child', view: () => text({ body: 'Child' }) })
        }
        return 'Keep as a note'
      },
    })
    await settle()
    await say(fake)
    await settle()
    expect(router.current.id).toBe('child')
    expect(fake.lines()).not.toContain('Which one?')
    expect(heard).toEqual([])
  })

  it('keeps what is said in a hold from other listeners also once the router is closed, and records nothing of it', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, glasses, life, router } = world({ voice })
    await settle()
    const heard: number[] = []
    life.own(glasses.listen(sound => void heard.push(sound.pcm.length)))
    await settle()
    router.close()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    expect(heard).toEqual([])
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
    fake.sound(tone(100))
    expect(heard).toHaveLength(1)
  })

  it('sends nothing to the transcriber when another screen was opened and left during the hold', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    fake.sound(tone(400))
    fake.sound(tone(400))
    router.back()
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
  })

  it('sends nothing to the transcriber when the screen was replaced as the app was asked how long a turn may take', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router } = world({ voice })
    router.open({ id: 'card', view: () => text({ body: 'Card' }) })
    await settle()
    let moved = false
    Object.defineProperty(voice, 'timeoutMs', {
      get: () => {
        if (!moved) {
          moved = true
          router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        }
        return 5_000
      },
    })
    await say(fake)
    await settle()
    expect(asked).toEqual([])
  })

  it('is no longer busy, and shows nothing over the next screen, when what a turn left behind throws as it is called off', async () => {
    const { fake, front, life, router, shell } = world({
      voice: {
        transcribe: (_audio, turn) => {
          turn?.own(() => {
            throw new Error('cleanup failed')
          })
          return new Promise<string>(() => {})
        },
      },
    })
    router.open({ id: 'card', view: () => text({ body: 'Card' }) })
    await settle()
    await say(fake)
    expect(shell.busy).toBe(true)
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    expect(() => router.replace({ id: 'other', view: () => text({ body: 'Other' }) })).not.toThrow()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
    await settle()
    expect(shell.busy).toBe(false)
    expect(front()).toBe('')
    life.end()
  })

  it('ends a hold when the screen changes, also when a listener the app set on the router before it throws', async () => {
    const { voice, asked } = hearing('open ben')
    const life = new Lifetime()
    const fake = fakeBridge()
    const router = new Router({ home: { id: 'home', view: () => text({ body: 'Home' }) } })
    router.onChange(current => {
      if (current.id === 'child') throw new Error('the listener of the app failed')
    })
    new Shell(life, new Glasses(life, fake.bridge), router, { voice })
    await settle()
    fake.hold()
    await settle(50)
    expect(() => router.open({ id: 'child', view: () => text({ body: 'Child' }) })).toThrow()
    fake.sound(tone(400))
    fake.sound(tone(400))
    router.back()
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
    life.end()
  })

  it('ends a hold when the screen changes, also when a listener the app set before it goes straight back', async () => {
    const { voice, asked } = hearing('open ben')
    const life = new Lifetime()
    const fake = fakeBridge()
    const router: Router = new Router({ home: { id: 'home', view: () => text({ body: 'Home' }) } })
    router.onChange(current => void (current.id === 'child' && router.back()))
    const shell = new Shell(life, new Glasses(life, fake.bridge), router, { voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    expect(shell.busy).toBe(false)
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
    life.end()
  })

  it('starts no second recording for a press whose hold a change of screen ended, until the touchpad is let go', async () => {
    const { voice, asked } = hearing('refresh', 'refresh')
    const { fake, router } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    fake.hold()
    await settle(50)
    expect(fake.mic).toBeNull()
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    expect(asked).toEqual([])
    await say(fake)
    expect(asked).toHaveLength(1)
  })

  it('takes a press again after a hold was ended by leaving the app, though no release came', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    fake.background()
    fake.foreground()
    await say(fake)
    expect(asked).toHaveLength(1)
  })

  it('takes a press again after a hold that a change of screen ended, once the wearer left the app and came back', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, router } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    fake.background()
    fake.foreground()
    await say(fake)
    expect(asked).toHaveLength(1)
  })

  it("calls the transcriber and the model as the app's own, so that one written as a class still reads its own fields", async () => {
    class Heard {
      words = 'something else entirely'
      async transcribe() {
        return this.words
      }
    }
    class Chooser {
      asked: string[] = []
      async choose(question: { words: string }) {
        this.asked.push(question.words)
        return {}
      }
    }
    const model = new Chooser()
    const voice: VoiceOptions = new Heard()
    voice.model = model
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    await settle()
    expect(model.asked).toEqual(['something else entirely'])
  })

  it('records nothing for a hold when a screen was opened and left as the app was asked how long a hold may be', async () => {
    const { voice, asked } = hearing('refresh')
    const onListen = vi.fn()
    voice.onListen = onListen
    const { fake, router } = world({ voice })
    await settle()
    Object.defineProperty(voice, 'maxHoldMs', {
      get: () => {
        router.open({ id: 'child', view: () => text({ body: 'Child' }) })
        router.back()
        return 5_000
      },
    })
    await say(fake)
    await settle()
    expect([asked, onListen.mock.calls.length]).toEqual([[], 0])
  })

  it('records nothing at a second event of a press that was turned away because the screen changed under it', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, router } = world({ voice })
    await settle()
    let once = true
    Object.defineProperty(voice, 'maxHoldMs', {
      get: () => {
        if (once) router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        once = false
        return 5_000
      },
    })
    fake.hold()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle()
    expect(asked).toEqual([])
    await say(fake)
    expect(asked).toHaveLength(1)
  })

  it('lets nothing of what a turn left behind throw reach whoever changed the screen, only a sentence of its own', async () => {
    const { fake, router } = world({
      voice: {
        transcribe: (_audio, turn) => {
          turn?.own(() => {
            throw new Error('what was said in the turn')
          })
          return new Promise<string>(() => {})
        },
      },
    })
    await settle()
    await say(fake)
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let thrown: unknown
    try {
      router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    } catch (error) {
      thrown = error
    }
    await settle()
    expect(thrown).toBeUndefined()
    expect(logged).not.toHaveBeenCalled()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
    expect(reported.mock.calls.map(([error]) => (error as Error).cause)).toEqual([undefined])
    expect(fake.lines()).toContain('Other')
  })

  it('runs what was said, and lets only a sentence of its own out, when what the turn left behind throws as the turn ends', async () => {
    const { fake, ran } = world({
      voice: {
        transcribe: async (_audio, turn) => {
          turn?.own(() => {
            throw new Error('what was said in the turn')
          })
          return 'refresh'
        },
      },
    })
    await settle()
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await say(fake)
    await settle()
    expect(ran).toEqual(['refresh'])
    expect(logged).not.toHaveBeenCalled()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
  })

  it('runs nothing that was said when finding the action that was meant replaces the screen', async () => {
    const places: { router?: Router } = {}
    let finding = false
    const { fake, ran, router } = world({
      voice: { transcribe: async () => null, agents: [() => ((finding = true), { kind: 'sure', action: 'refresh' })] },
      home: ({ refresh }) => ({
        id: 'home',
        view: () => text({ body: 'Home' }),
        actions: () => {
          if (finding) places.router?.replace({ id: 'other', view: () => text({ body: 'Other' }) })
          finding = false
          return [refresh]
        },
      }),
    })
    places.router = router
    await settle()
    await say(fake)
    await settle()
    expect([router.current.id, ran]).toEqual(['other', []])
  })

  it('records nothing for a hold when what the turn before it left behind opens a screen and goes back', async () => {
    const places: { router?: Router } = {}
    const asked: number[] = []
    let turns = 0
    const { fake, router } = world({
      voice: {
        transcribe: (audio, turn) => {
          if (turns++ > 0) return Promise.resolve((asked.push(audio.seconds), 'refresh'))
          turn?.own(() => {
            places.router?.open({ id: 'child', view: () => text({ body: 'Child' }) })
            places.router?.back()
          })
          return new Promise<string>(() => {})
        },
      },
    })
    places.router = router
    await settle()
    await say(fake)
    await say(fake)
    await settle()
    expect([turns, asked]).toEqual([1, []])
    await say(fake)
    expect(asked).toHaveLength(1)
  })

  it('lets nothing of what a turn left behind throw reach whoever ends the app, only a sentence of its own', async () => {
    const { fake, life } = world({
      voice: {
        transcribe: (_audio, turn) => {
          turn?.own(() => {
            throw new Error('what was said in the turn')
          })
          return new Promise<string>(() => {})
        },
      },
    })
    await settle()
    await say(fake)
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    expect(() => life.end()).not.toThrow()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
  })

  it('ends what a turn left behind when the app ends, also when the turn was still being decided', async () => {
    let ended = 0
    const { fake, life } = world({
      voice: { transcribe: (_audio, turn) => (turn?.own(() => void ended++), new Promise<string>(() => {})) },
    })
    await settle()
    await say(fake)
    life.end()
    expect(ended).toBe(1)
  })

  it('says that voice did not work, and is busy no longer, when the app throws as it is asked how long a turn may take', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, front, shell } = world({ voice })
    await settle()
    Object.defineProperty(voice, 'timeoutMs', {
      get: () => {
        throw new Error('what the app would not have in a log')
      },
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    await say(fake)
    await settle(100)
    expect([shell.busy, front(), asked, logged.mock.calls.length]).toEqual([false, 'Voice did not work', [], 0])
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([
      'Error: Earshot: a listener of the settings of a voice turn threw.',
    ])
  })

  it('records once for one press: no second recording after the first ran its full length and its turn was called off', async () => {
    const asked: number[] = []
    const { fake, router } = world({
      voice: { maxHoldMs: 1_000, transcribe: audio => (asked.push(audio.seconds), new Promise<string>(() => {})) },
    })
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    await settle(1_000)
    expect(asked).toHaveLength(1)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle(50)
    expect(asked).toHaveLength(1)
    await say(fake)
    expect(asked).toHaveLength(2)
  })

  it('takes no microphone for a shell that the app ended as it was asked how long a hold may be', async () => {
    const life = new Lifetime()
    const mine = life.child()
    const fake = fakeBridge()
    const glasses = new Glasses(life, fake.bridge)
    const { voice } = hearing('refresh')
    Object.defineProperty(voice, 'maxHoldMs', { get: () => (mine.end(), 5_000) })
    new Shell(mine, glasses, new Router({ home: { id: 'home', view: () => text({ body: 'Home' }) } }), { voice })
    const heard: number[] = []
    life.own(glasses.listen(sound => void heard.push(sound.pcm.length)))
    await settle()
    fake.hold()
    await settle(50)
    fake.release()
    fake.sound(tone(200))
    expect(heard).toEqual([tone(200).length])
    life.end()
  })

  it('keeps what is said in a press from other listeners for as long as hold events of that press keep coming, and records it once', async () => {
    const asked: number[] = []
    const { fake, glasses, life } = world({
      voice: { maxHoldMs: 1_000, transcribe: async audio => (asked.push(audio.seconds), '') },
    })
    const heard: number[] = []
    life.own(glasses.listen(sound => void heard.push(sound.pcm.length)))
    await settle()
    fake.hold()
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    await settle(700)
    fake.hold()
    await settle(1_500)
    fake.sound(tone(200))
    expect([heard, asked.length]).toEqual([[], 1])
    await settle(600)
    fake.sound(tone(200))
    expect(heard).toEqual([tone(200).length])
  })

  it('shows the notice a screen gave as it left, though a turn that was being decided on it is called off with it', async () => {
    const { fake, front, router, shell } = world({ voice: { transcribe: () => new Promise<string>(() => {}) } })
    router.open({
      id: 'child',
      view: () => text({ body: 'Child' }),
      enter: left => void left.own(() => shell.notice('Saved')),
    })
    await settle()
    await say(fake)
    expect(shell.busy).toBe(true)
    router.back()
    await settle()
    expect([shell.busy, front()]).toEqual([false, 'Saved'])
  })

  it('takes a notice away with the turn when a touch calls the turn off, as it always did', async () => {
    const { fake, front, shell } = world({ voice: { transcribe: () => new Promise<string>(() => {}) } })
    await settle()
    await say(fake)
    shell.notice('In between')
    await settle(100)
    expect(front()).toBe('In between')
    fake.tap()
    await settle(100)
    expect([shell.busy, front()]).toEqual([false, ''])
  })

  it('says that no answer came in time, and is busy no longer, when the app itself ended the lifetime it was given for the turn', async () => {
    const turns: Lifetime[] = []
    const { fake, front, shell } = world({
      voice: { timeoutMs: 5_000, transcribe: (_audio, turn) => (turn && turns.push(turn), new Promise<string>(() => {})) },
    })
    await settle()
    await say(fake)
    turns[0].end()
    await settle(5_000)
    expect([shell.busy, front()]).toEqual([false, 'No answer in time'])
  })

  it('leaves no wait behind when a turn is called off: nothing is said of a late answer after it', async () => {
    const { fake, front, router } = world({ voice: { timeoutMs: 5_000, transcribe: () => new Promise<string>(() => {}) } })
    await settle()
    await say(fake)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    const waiting = vi.getTimerCount()
    await settle(6_000)
    expect(front()).toBe('')
    router.back()
    await settle()
    await say(fake)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(waiting + 2)
  })

  it('keeps a press from other listeners for as long as the app now says a hold may be, asked anew at each event of the press', async () => {
    const { voice } = hearing('')
    voice.maxHoldMs = 1_000
    const { fake, glasses, life } = world({ voice })
    const heard: number[] = []
    life.own(glasses.listen(sound => void heard.push(sound.pcm.length)))
    await settle()
    fake.hold()
    await settle(500)
    voice.maxHoldMs = 5_000
    fake.hold()
    await settle(2_500)
    fake.sound(tone(200))
    expect(heard).toEqual([])
  })

  it('calls what an app gave as a transcriber, and as the work of an action, though it has a call of its own that is none', async () => {
    const said: string[] = []
    const ran: string[] = []
    const strange = <Given extends (...given: never[]) => unknown>(given: Given): Given => Object.assign(given, { call: undefined })
    const act = action({ id: 'refresh', say: 'Refresh', run: strange(() => void ran.push('refresh')) })
    const { fake } = world({
      voice: { transcribe: strange(async () => (said.push('heard'), 'refresh')) },
      home: () => ({ id: 'home', view: () => text({ body: 'Home' }), actions: () => [act] }),
    })
    await settle()
    await say(fake)
    await settle()
    expect([said, ran]).toEqual([['heard'], ['refresh']])
    expect((await act.run()).done).toBe(true)
  })

  it('takes a notice away at the release of a press whose hold a change of screen had ended, as it always did', async () => {
    const { voice } = hearing('refresh')
    const { fake, front, router, shell } = world({ voice })
    await settle()
    fake.hold()
    await settle(50)
    shell.notice('Of the screen before')
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    await settle(100)
    expect(front()).toBe('Of the screen before')
    fake.release()
    await settle(100)
    expect(front()).toBe('')
  })

  it('records nothing for a hold when the screen was replaced as the app was asked how long a hold may be', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, router, front } = world({ voice })
    await settle()
    let once = true
    Object.defineProperty(voice, 'maxHoldMs', {
      get: () => {
        if (once) router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        once = false
        return 5_000
      },
    })
    fake.hold()
    await settle(50)
    expect([fake.mic, front()]).toEqual([null, ''])
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release()
    await settle()
    expect(asked).toEqual([])
  })

  it('takes a press again once that touchpad is let go after its hold was called off, though the other one is still down', async () => {
    const { voice, asked } = hearing('refresh')
    const { fake, router } = world({ voice })
    await settle()
    fake.hold('right')
    fake.hold('left')
    await settle(50)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    fake.release('right')
    fake.hold('right')
    await settle(50)
    fake.sound(tone(400))
    fake.sound(tone(400))
    fake.release('right')
    await settle(50)
    expect(asked).toHaveLength(1)
  })

  it('runs nothing that was said when what a turn left behind opens a screen and goes back as the turn ends', async () => {
    const places: { router?: Router } = {}
    const { fake, ran, router } = world({
      voice: {
        transcribe: async (_audio, turn) => {
          turn?.own(() => {
            places.router?.open({ id: 'child', view: () => text({ body: 'Child' }) })
            places.router?.back()
          })
          return 'refresh'
        },
      },
    })
    places.router = router
    await settle()
    await say(fake)
    await settle()
    expect(ran).toEqual([])
  })

  it('hands no sound to a transcriber that the app gave only as the screen was replaced', async () => {
    const asked: number[] = []
    const { voice } = hearing()
    const { fake, router } = world({ voice })
    await settle()
    Object.defineProperty(voice, 'transcribe', {
      get: () => {
        router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        return async (audio: { seconds: number }) => (asked.push(audio.seconds), 'refresh')
      },
    })
    await say(fake)
    await settle()
    expect(asked).toEqual([])
  })

  it('asks no model that the app gave only as the screen was replaced', async () => {
    const questions: string[] = []
    const { voice } = hearing('something else entirely')
    const { fake, router } = world({ voice })
    await settle()
    voice.model = {
      get choose() {
        router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
        return async (question: { words: string }) => (questions.push(question.words), {})
      },
    }
    await say(fake)
    await settle()
    expect(questions).toEqual([])
  })

  it('hands what was not transcribed to an agent without reading the model of the app, which only navigation needs', async () => {
    const got: string[] = []
    const voice: VoiceOptions = {
      transcribe: async () => null,
      agents: [async heard => (got.push(heard.words), { kind: 'handled' })],
    }
    Object.defineProperty(voice, 'model', {
      get: () => {
        throw new Error('no model without the network')
      },
    })
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    await settle()
    expect(got).toEqual([''])
  })

  it('sends nothing to the transcriber when a screen was opened and left as the app was asked how long a turn may take', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, router } = world({ voice })
    await settle()
    Object.defineProperty(voice, 'timeoutMs', {
      get: () => {
        router.open({ id: 'child', view: () => text({ body: 'Child' }) })
        router.back()
        return 5_000
      },
    })
    await say(fake)
    await settle()
    expect(asked).toEqual([])
  })

  it('hands the words to no agent when the screen changed while they were being heard: the turn ends there, as it always did', async () => {
    let heard: (words: string) => void = () => {}
    const took: string[] = []
    const { fake, front, router, shell } = world({
      voice: {
        transcribe: () => new Promise<string>(done => (heard = done)),
        agents: [({ words }) => (took.push(words), { kind: 'handled', say: 'Lap recorded' })],
      },
    })
    await settle()
    await say(fake)
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    heard('record lap')
    await settle()
    expect([took, shell.busy, front()]).toEqual([[], false, ''])
  })

  it('takes its own card down at once when the screen changes while an agent of the app is at work, and still says what the agent then says', async () => {
    let answer: (verdict: { kind: 'handled'; say: string }) => void = () => {}
    const { voice } = hearing('remember the milk')
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake, front, router, shell } = world({ voice })
    await settle()
    await say(fake)
    const before = front()
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    await settle()
    const atTheChange = [shell.busy, front()]
    answer({ kind: 'handled', say: 'Saved' })
    await settle()
    expect([before, atTheChange, [shell.busy, front()]]).toEqual(['"remember the milk"', [true, ''], [false, 'Saved']])
  })

  it('leaves a card the screen that came drew itself, at the change and when an agent that was at work then ends with nothing to say', async () => {
    let answer: (verdict: { kind: 'handled' }) => void = () => {}
    const { voice } = hearing('remember the milk')
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake, front, glasses, router } = world({ voice })
    await settle()
    await say(fake)
    router.open({ id: 'trail', view: () => text({ body: 'Trail' }), enter: () => glasses.overlay('GPS unavailable') })
    await settle()
    const atTheChange = front()
    answer({ kind: 'handled' })
    await settle()
    expect([atTheChange, front()]).toEqual(['GPS unavailable', 'GPS unavailable'])
  })

  it('writes no card of its own over a card the next screen drew, when that screen was opened as the app was asked how long a turn may take', async () => {
    const { voice, asked } = hearing('open ben')
    const { fake, front, glasses, router } = world({ voice })
    await settle()
    let moved = false
    Object.defineProperty(voice, 'timeoutMs', {
      get: () => {
        if (!moved) {
          moved = true
          router.open({ id: 'trail', view: () => text({ body: 'Trail' }), enter: () => glasses.overlay('GPS unavailable') })
        }
        return 5_000
      },
    })
    await say(fake)
    await settle()
    expect([asked, front()]).toEqual([[], 'GPS unavailable'])
  })

  it('leaves a notice the app gave while an agent of the app was at work, at the change of screen and when the agent ends with nothing to say', async () => {
    let answer: (verdict: { kind: 'handled' }) => void = () => {}
    const { voice } = hearing('remember the milk')
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake, front, router, shell } = world({ voice })
    await settle()
    await say(fake)
    shell.notice('Saved')
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    await settle(100)
    const atTheChange = front()
    answer({ kind: 'handled' })
    await settle(100)
    expect([atTheChange, front()]).toEqual(['Saved', 'Saved'])
  })

  it('asks no further agent once the screen was left and come back to while an agent of the app was at work', async () => {
    let answer: (verdict: { kind: 'notMine' }) => void = () => {}
    const took: string[] = []
    const { voice } = hearing('tell the team')
    voice.agents = [() => new Promise(done => (answer = done)), ({ words }) => (took.push(words), { kind: 'handled', say: 'Told' })]
    const { fake, front, router, shell } = world({ voice })
    await settle()
    await say(fake)
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    router.back()
    answer({ kind: 'notMine' })
    await settle()
    expect([took, shell.busy, front()]).toEqual([[], false, ''])
  })

  it('ends the lifetime a transcriber was given when the screen changes while it is still hearing, so it sends nothing more', async () => {
    const lives: Lifetime[] = []
    const { fake, router, shell } = world({
      voice: { transcribe: (_audio, life) => (life && lives.push(life), new Promise<string>(() => {})) },
    })
    await settle()
    await say(fake)
    const during = lives.map(life => life.ended)
    router.replace({ id: 'other', view: () => text({ body: 'Other' }) })
    expect([during, lives.map(life => life.ended), shell.busy]).toEqual([[false], [true], false])
  })

  it('calls the next turn off at a change of screen while it is still hearing, though the agent of a turn that ran out of time never answered', async () => {
    const { voice } = hearing('remember the milk')
    voice.timeoutMs = 2_000
    voice.agents = [() => new Promise(() => {})]
    const { fake, router, shell } = world({ voice })
    await settle()
    await say(fake)
    await settle(3_000)
    voice.transcribe = () => new Promise<string>(() => {})
    await say(fake)
    const before = shell.busy
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    expect([before, shell.busy]).toEqual([true, false])
  })

  it('leaves a turn that began as the one before ran out of time its own time, its own answer and its own end', async () => {
    let turns = 0
    const made: { world?: ReturnType<typeof world> } = {}
    const again = () => {
      const fake = made.world?.fake
      fake?.hold()
      fake?.sound(tone(400))
      fake?.sound(tone(400))
      fake?.release()
    }
    made.world = world({
      voice: {
        timeoutMs: 2_000,
        transcribe: (_audio, life) => {
          if (++turns > 1) return Promise.resolve('refresh')
          life?.own(again)
          return new Promise<string>(() => {})
        },
      },
    })
    const { fake, ran, shell } = made.world
    await settle()
    await say(fake)
    await settle(2_500)
    expect([turns, ran, shell.busy]).toEqual([2, ['refresh'], false])
  })

  it('ends a turn an agent of the app is at work on when the only screen was replaced by one that could not be entered: no screen is left for what it says', async () => {
    let answer: (verdict: { kind: 'handled'; say: string }) => void = () => {}
    const lives: Lifetime[] = []
    const { voice } = hearing('remember the milk')
    voice.agents = [({ life }) => (life && lives.push(life), new Promise(done => (answer = done)))]
    const { fake, front, router, shell } = world({ voice })
    await settle()
    await say(fake)
    let thrown: unknown
    try {
      router.replace({
        id: 'broken',
        view: () => text({ body: 'Broken' }),
        enter: () => {
          throw new Error('could not be entered')
        },
      })
    } catch (error) {
      thrown = error
    }
    const ended = lives.map(life => life.ended)
    answer({ kind: 'handled', say: 'Saved' })
    await settle()
    expect([String(thrown), ended, shell.busy, front()]).toEqual(['Error: could not be entered', [true], false, ''])
  })

  it('takes its own card down when the screen a turn was said on is replaced by one that could not be entered, and still says what the agent then says', async () => {
    let answer: (verdict: { kind: 'handled'; say: string }) => void = () => {}
    const { voice } = hearing('save waypoint')
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake, front, router, shell } = world({ voice })
    router.open({ id: 'child', view: () => text({ body: 'Child' }) })
    await settle()
    await say(fake)
    const before = front()
    expect(() =>
      router.replace({
        id: 'broken',
        view: () => text({ body: 'Broken' }),
        enter: () => {
          throw new Error('could not be entered')
        },
      }),
    ).toThrow('could not be entered')
    await settle()
    const after = [shell.busy, front()]
    answer({ kind: 'handled', say: 'Saved' })
    await settle()
    expect([before, after, front()]).toEqual(['"save waypoint"', [true, ''], 'Saved'])
  })

  it('reads nothing of what an agent answers after its turn ran out of time', async () => {
    let answer: (verdict: { kind: 'handled'; say: string }) => void = () => {}
    let read = 0
    const { voice } = hearing('remember the milk')
    voice.timeoutMs = 2_000
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    await settle(3_000)
    answer({
      kind: 'handled',
      get say() {
        read++
        return 'Saved'
      },
    })
    await settle()
    expect(read).toBe(0)
  })

  it('says nothing of what an agent answered on another screen when reading what it says closed the router', async () => {
    let answer: (verdict: { kind: 'handled'; say: string }) => void = () => {}
    const { voice } = hearing('remember the milk')
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake, front, router } = world({ voice })
    await settle()
    await say(fake)
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    await settle()
    answer({
      kind: 'handled',
      get say() {
        router.close()
        return 'Saved'
      },
    })
    await settle()
    expect(front()).toBe('')
  })

  it('runs what an agent chose when the agent tried to go to a screen that could not be entered and none was left: the screen it was said on is still the one', async () => {
    const { voice } = hearing('refresh it')
    const made: { router?: Router } = {}
    voice.transcribe = async () => null
    voice.agents = [
      () => {
        try {
          made.router?.jump({
            id: 'broken',
            view: () => text({ body: 'Broken' }),
            enter: () => {
              throw new Error('could not be entered')
            },
          })
        } catch {
          return { kind: 'sure', action: 'refresh' }
        }
        return { kind: 'notMine' }
      },
    ]
    const { fake, ran, router } = world({ voice })
    made.router = router
    await settle()
    await say(fake)
    await settle()
    expect(ran).toEqual(['refresh'])
  })

  it('reads nothing at all of what an agent answers after its turn ran out of time, not what kind of answer it is either', async () => {
    let answer: (verdict: { kind: 'handled' }) => void = () => {}
    let read = 0
    const { voice } = hearing('remember the milk')
    voice.timeoutMs = 2_000
    voice.agents = [() => new Promise(done => (answer = done))]
    const { fake } = world({ voice })
    await settle()
    await say(fake)
    await settle(3_000)
    answer({
      get kind() {
        read++
        return 'handled' as const
      },
    })
    await settle()
    expect(read).toBe(0)
  })

  it.each([false, true])(
    'says what an agent did though the agent itself ended the lifetime it was given, done with it (having opened another screen: %s)',
    async elsewhere => {
      const { voice } = hearing('remember the milk')
      const made: { router?: Router } = {}
      voice.agents = [
        ({ life }) => {
          if (elsewhere) made.router?.open({ id: 'saved', view: () => text({ body: 'The milk' }) })
          life?.end()
          return { kind: 'handled', say: 'Saved' }
        },
      ]
      const { fake, front, router } = world({ voice })
      made.router = router
      await settle()
      await say(fake)
      await settle(100)
      expect(front()).toBe('Saved')
    },
  )

  it('says what an agent answered on another screen though what the agent left behind takes the words away again as the turn ends', async () => {
    const { voice } = hearing('remember the milk')
    const made: { router?: Router } = {}
    voice.agents = [
      ({ life }) => {
        const verdict: { kind: 'handled'; say?: string } = { kind: 'handled', say: 'Saved' }
        life?.own(() => void delete verdict.say)
        made.router?.open({ id: 'saved', view: () => text({ body: 'The milk' }) })
        return verdict
      },
    ]
    const { fake, front, router } = world({ voice })
    made.router = router
    await settle()
    await say(fake)
    await settle(100)
    expect(front()).toBe('Saved')
  })

  it('calls a turn off at a change of screen while only the model is at work on it', async () => {
    const { voice } = hearing('something else entirely')
    voice.model = { choose: () => new Promise(() => {}) }
    const { fake, front, router, shell } = world({ voice })
    await settle()
    await say(fake)
    const before = shell.busy
    router.open({ id: 'other', view: () => text({ body: 'Other' }) })
    await settle()
    expect([before, shell.busy, front()]).toEqual([true, false, ''])
  })

  it('draws the screen that was opened, and tells the listeners after it, also when what a turn left behind throws as it is called off', async () => {
    const { fake, life, router } = world({
      voice: {
        transcribe: (_audio, turn) => {
          turn?.own(() => {
            throw new Error('cleanup failed')
          })
          return new Promise<string>(() => {})
        },
      },
    })
    const told: string[] = []
    router.onChange(current => void told.push(current.id))
    await settle()
    await say(fake)
    const reported = vi.fn()
    vi.stubGlobal('reportError', reported)
    expect(() => router.open({ id: 'other', view: () => text({ body: 'Other' }) })).not.toThrow()
    expect(reported.mock.calls.map(([error]) => String(error))).toEqual([TURN_END])
    await settle()
    expect(told).toEqual(['other'])
    expect(fake.lines()).toContain('Other')
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
    await settle()
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

  it('still asks before a spoken choice of a row runs, though reading the row ran another action by touch meanwhile', async () => {
    const made: { fake?: ReturnType<typeof fakeBridge> } = {}
    let armed = false
    const did: string[] = []
    const allow = action({
      id: 'allow',
      say: 'Allow',
      risk: 'voice',
      targets: () => [{ id: 'r1', say: 'Run the migration', value: 'r1' }],
      run: id => void did.push(`allow ${id}`),
    })
    Object.defineProperty(allow, 'targets', {
      value: () => [
        {
          get id() {
            if (armed) {
              armed = false
              made.fake?.pick('Refresh')
            }
            return 'r1'
          },
          say: 'Run the migration',
        },
      ],
    })
    const refresh = action({ id: 'refresh', say: 'Refresh', run: () => void did.push('refresh') })
    const { fake, front } = world({
      voice: { transcribe: async () => ((armed = true), 'choose this one') },
      home: () => ({ id: 'home', actions: () => [refresh], view: () => list({ title: 'Allow', action: allow }) }),
    })
    made.fake = fake
    await settle()
    await say(fake)
    await settle(100)
    expect([armed, did, front()]).toEqual([false, ['refresh'], 'Allow: Run the migration?\nTap to confirm'])
  })

  it('still asks before a spoken choice runs the action the list was drawn with, though reading the row put another action in its place', async () => {
    const did: string[] = []
    let armed = false
    const rows = () => [{ id: 'note', say: 'Note', value: 'note' }]
    const archive = action({ id: 'archive', say: 'Archive', risk: 'voice', targets: rows, run: () => void did.push('archive') })
    const remove = action({ id: 'remove', say: 'Remove', targets: rows, run: () => void did.push('remove') })
    let current = archive
    Object.defineProperty(archive, 'targets', {
      value: () => [
        {
          get id() {
            if (armed) current = remove
            return 'note'
          },
          say: 'Note',
        },
      ],
    })
    const view = list({ title: 'Archive', action: archive })
    Object.defineProperty(view, 'action', { get: () => current })
    const { fake, front } = world({
      voice: { transcribe: async () => ((armed = true), 'choose this one') },
      home: () => ({ id: 'home', view: () => view }),
    })
    await settle()
    await say(fake)
    await settle(100)
    expect([did, front()]).toEqual([[], 'Archive: Note?\nTap to confirm'])
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

  it('says what an agent did also when the agent itself went to another screen: the work is done, wherever the user now is', async () => {
    const { voice } = hearing('remember the milk')
    const made = world({ voice })
    voice.agents = [
      () => {
        made.router.open({ id: 'saved', view: () => text({ title: 'Notes', body: 'The milk' }) })
        return { kind: 'handled', say: 'Saved' }
      },
    ]
    await settle()
    await say(made.fake)
    expect(made.fake.lines()).toContain('Notes')
    expect(made.front()).toBe('Saved')
  })

  it('says nothing of an agent that answers after its turn ran out of time, on whichever screen', async () => {
    const { voice } = hearing('remember the milk')
    voice.timeoutMs = 2_000
    const made = world({ voice })
    let answer: ((verdict: { kind: 'handled'; say: string }) => void) | undefined
    voice.agents = [
      () => {
        made.router.open({ id: 'saved', view: () => text({ title: 'Notes', body: 'The milk' }) })
        return new Promise(done => (answer = done))
      },
    ]
    await settle()
    await say(made.fake)
    await settle(3_000)
    answer!({ kind: 'handled', say: 'Saved' })
    await settle()
    expect(made.fake.lines()).toContain('Notes')
    expect(made.front()).toBe('')
  })

  it('says nothing after an agent that went to another screen and has nothing to say', async () => {
    const { voice } = hearing('remember the milk')
    const made = world({ voice })
    voice.agents = [
      () => {
        made.router.open({ id: 'saved', view: () => text({ title: 'Notes', body: 'The milk' }) })
        return { kind: 'handled' }
      },
    ]
    await settle()
    await say(made.fake)
    expect(made.fake.lines()).toContain('Notes')
    expect(made.front()).toBe('')
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

    it('asks the app for its transcriber once a turn, not again when the words it gave are handed on', async () => {
      const { voice, got } = noting('allow run the migration')
      const { transcribe } = voice
      let fetched = 0
      Object.defineProperty(voice, 'transcribe', { get: () => (fetched++, transcribe) })
      const { fake } = world({ voice, home: allowing })
      await settle()
      await say(fake)
      fake.down()
      await settle()
      expect([got.length, fetched]).toEqual([1, 1])
    })

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
      await settle()
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
