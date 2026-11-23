import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Lifetime } from '../lifetime.js'
import { Router } from '../router.js'
import { fakeBridge } from './fake.js'
import { Glasses } from './glasses.js'
import type { HoldSource } from './input.js'
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

const TOUCHPADS: HoldSource[] = ['right', 'left', 'ring']
const SEEDS = Array.from({ length: 200 }, (_, seed) => seed + 1)

it.each(SEEDS)('whatever touchpads are pressed and let go, a listener hears a sound exactly when no hold is on (seed %i)', async seed => {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  const life = new Lifetime()
  const fake = fakeBridge()
  const glasses = new Glasses(life, fake.bridge)
  new Shell(life, glasses, new Router({ home: { id: 'home' } }), { voice: { transcribe: async () => '' } })
  let heard = 0
  glasses.listen(() => void heard++)
  await vi.advanceTimersByTimeAsync(400)
  const down = new Set<HoldSource>()
  let holding: HoldSource | null = null
  const log: string[] = []
  try {
    for (let at = 0; at < 80; at++) {
      const touchpad = pick(TOUCHPADS)
      const what = pick(['press', 'let go', 'sound', 'sound', 'wait'])
      log.push(what === 'press' || what === 'let go' ? `${what} ${touchpad}` : what)
      if (what === 'press' && !down.has(touchpad)) {
        down.add(touchpad)
        holding ??= touchpad
        fake.hold(touchpad)
      } else if (what === 'let go' && down.has(touchpad)) {
        down.delete(touchpad)
        if (holding === touchpad) holding = null
        fake.release(touchpad)
      } else if (what === 'sound') {
        const before = heard
        fake.sound(new Uint8Array(3_200).fill(60))
        expect(heard - before, holding ? `a sound during the hold of ${holding}` : 'a sound with no hold on').toBe(holding ? 0 : 1)
      } else if (what === 'wait') await vi.advanceTimersByTimeAsync(pick([50, 400, 2_000]))
      await vi.advanceTimersByTimeAsync(0)
    }
  } catch (error) {
    throw new Error(`After: ${log.join(', ')}\n${String(error)}`)
  }
})
