import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { action, type Action, type Risk } from '../action.js'
import { Lifetime } from '../lifetime.js'
import { Router, type Screen } from '../router.js'
import { boxes, list, text, type Bound, type Gestures } from '../view.js'
import { fakeBridge } from './fake.js'
import { Glasses } from './glasses.js'
import { Shell } from './shell.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Aim {
  id: string
  say: string
  risk?: Risk
}

interface Made {
  action: Action
  aims: Aim[] | null
  why: string | null
  chooses: boolean
}

const SEEDS = Array.from({ length: 150 }, (_, seed) => seed + 1)
const GESTURES = ['tap', 'up', 'down'] as const
const LONGEST_LIST = 24

it.each(SEEDS)(
  'E3: on any screen, touch alone runs every action, on each target the screen has not kept to itself (seed %i)',
  async seed => {
    const next = random(seed)
    const upTo = (most: number) => Math.floor(next() * (most + 1))
    const pick = <T>(items: readonly T[]): T => items[upTo(items.length - 1)]
    const ran: string[] = []

    const made: Made[] = Array.from({ length: 1 + upTo(15) }, (_, n) => {
      const id = `a${n}`
      const common = { id, say: `Action ${n}`, risk: pick<Risk>(['safe', 'safe', 'confirm', 'voice']) }
      const why = next() < 0.15 ? `Not ${id} now` : null
      if (next() < 0.55)
        return { action: action({ ...common, blocked: () => why, run: () => void ran.push(id) }), aims: null, why, chooses: false }
      const aims: Aim[] = Array.from({ length: 1 + upTo(4) }, (_, t) => ({
        id: `t${t}`,
        say: `${id} aim ${t}`,
        ...(next() < 0.2 ? { risk: pick<Risk>(['confirm', 'voice', 'safe']) } : {}),
      }))
      const chooses = next() < 0.15
      const spec = {
        ...common,
        blocked: () => why,
        targets: () => aims.map(aim => ({ ...aim, value: aim.id, private: next() < 0.3 })),
        run: (aim: string) => void ran.push(`${id} ${aim}`),
        ...(chooses ? { choose: () => void ran.push(`${id} is chosen on the app's own screen`) } : {}),
      }
      return { action: action(spec), aims, why, chooses }
    })

    const ofScreen = made.slice(0, 1 + upTo(made.length - 1))
    const ofApp = made.slice(ofScreen.length)
    const aimed = ofScreen.filter(one => one.aims)
    const kind = pick(['none', 'text', 'boxes', ...(aimed.length ? (['list'] as const) : [])] as const)
    const listed = kind === 'list' ? pick(aimed) : undefined
    const on: Gestures = {}
    if (kind === 'boxes')
      for (const gesture of GESTURES) {
        if (next() < 0.5) continue
        const one = pick(made)
        on[gesture] = one.aims && next() < 0.6 ? { action: one.action, target: pick(one.aims).id } : one.action
      }
    const home: Screen = {
      id: 'home',
      actions: () => ofScreen.map(one => one.action),
      ...(kind === 'none'
        ? {}
        : {
            view: () =>
              kind === 'list'
                ? list({ title: 'Home', action: listed!.action })
                : kind === 'text'
                  ? text({ title: 'Home', body: 'Hello' })
                  : boxes([{ id: 'body', x: 0, y: 0, w: 200, h: 40, text: 'Hello' }], { on }),
          }),
    }

    const life = new Lifetime()
    const fake = fakeBridge()
    const router: Router = new Router({ home, actions: () => ofApp.map(one => one.action) })
    new Shell(life, new Glasses(life, fake.bridge), router)
    const settle = async (ms = 400) => void (await vi.advanceTimersByTimeAsync(ms))
    const cursor = () =>
      fake
        .boxes()
        .find(box => box.name === 'cursor')
        ?.text.trim()
    const toRow = async (say: string) => {
      for (let n = 0; n < LONGEST_LIST; n++) fake.up()
      await settle()
      for (let n = 0; n < LONGEST_LIST && cursor() !== say; n++) {
        fake.down()
        await settle()
      }
      expect(cursor(), `the row "${say}"`).toBe(say)
    }
    const keptByTheScreen = (one: Made, aim?: Aim) =>
      kind === 'boxes' &&
      !bound(one, aim) &&
      GESTURES.some(gesture => {
        const held: Bound | undefined = on[gesture]
        return held !== undefined && 'action' in held && held.action === one.action
      })
    const bound = (one: Made, aim?: Aim) =>
      GESTURES.find(gesture => {
        const held: Bound | undefined = on[gesture]
        if (!held) return false
        return 'action' in held ? held.action === one.action && held.target === aim?.id : held === one.action
      })

    const touch = async (one: Made, aim?: Aim) => {
      const menu = fake.menuItems().map(item => item.name)
      const gesture = kind === 'boxes' ? bound(one, aim) : undefined
      let aimedAt = false
      if (kind === 'none') {
        await toRow(one.action.say)
        fake.tap()
      } else if (one === listed && aim) {
        await toRow(aim.say)
        fake.tap()
        aimedAt = true
      } else if (gesture) {
        fake[gesture]()
        aimedAt = typeof on[gesture] === 'object' && 'action' in on[gesture]
      } else if (menu.includes(one.action.say)) fake.pick(one.action.say)
      else if (menu.includes('More…')) {
        fake.pick('More…')
        await settle()
        await toRow(one.action.say)
        fake.tap()
      } else
        throw new Error(`Nothing to touch for ${one.action.say}${aim ? `, ${aim.say}` : ''}: the menu is ${menu.join(', ') || 'empty'}`)
      await settle()
      return aimedAt
    }

    await settle()
    for (const one of made) {
      for (const aim of one.aims ?? [undefined]) {
        if (keptByTheScreen(one, aim)) continue
        const before = ran.length
        const what = `${one.action.say}${aim ? `, ${aim.say}` : ''} on a screen with ${kind === 'none' ? 'no view' : `a ${kind} view`}`
        const aimedAt = await touch(one, aim)
        if (one.why !== null) {
          expect(fake.overlay(), what).toBe(one.why)
          await settle(4_000)
          expect(ran.length, what).toBe(before)
          continue
        }
        if (aim && !aimedAt) {
          if (one.chooses) {
            expect(ran.slice(before), what).toEqual([`${one.action.id} is chosen on the app's own screen`])
            continue
          }
          await toRow(aim.say)
          fake.tap()
          await settle()
        }
        if ((aim?.risk ?? one.action.risk) === 'confirm') {
          expect(ran.length, `${what}: asked before it runs`).toBe(before)
          fake.tap()
          await settle()
        }
        expect(ran.slice(before), what).toEqual([aim ? `${one.action.id} ${aim.id}` : one.action.id])
        expect(router.depth, `${what}: back on the screen it was run from`).toBe(1)
      }
    }
  },
)
