import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Lifetime } from '../lifetime.js'
import { Mic, MIC_SILENT_MS } from './mic.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('reportError', () => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Call {
  open: boolean
  answer: (done: boolean) => void
}

const MOST_CALLS = 400
const STEPS = 60

function world(seed: number) {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  const log: string[] = []
  const calls: Call[] = []
  const life = new Lifetime()
  let on = false
  let asked = 0
  const ask = (open: boolean) =>
    new Promise<boolean>(done => {
      if (++asked > MOST_CALLS) throw new Error('The microphone was asked for without end.')
      calls.push({ open, answer: done })
    })
  const mic = new Mic(life, { open: () => ask(true), close: () => ask(false) }, Date.now)
  const listeners = new Map<number, () => void>()
  const got = new Map<number, number[]>()
  let hold: (() => void) | null = null
  let ids = 0
  let sounds = 0
  const news: boolean[] = []
  const meddlers = new Set<() => void>()
  mic.onChange(open => news.push(open))

  const answer = (how: 'yes' | 'no' | 'no, but it is on') => {
    const call = calls.shift()
    if (!call) return
    if (how === 'yes') on = call.open
    if (how === 'no, but it is on' && call.open) on = true
    call.answer(how === 'yes')
  }
  let ended = false
  const sound = () => {
    if (!on || ended) return
    const id = ++sounds
    const expected = hold ? [0] : [...listeners.keys()]
    got.clear()
    mic.heard({ pcm: new Uint8Array([id & 255]), speaker: 'unknown' })
    expect([...got.keys()].sort(), `who heard sound ${id}`).toEqual(expected.sort())
  }
  const hear =
    (id: number, throws = false) =>
    (heard: { pcm: Uint8Array }) => {
      got.set(id, [...heard.pcm])
      if (throws) throw new Error('a listener failed')
    }

  const steps: Record<string, () => void | Promise<void>> = {
    listen: () => {
      const id = ++ids
      listeners.set(id, mic.listen(hear(id), { reopenAfterMs: pick([undefined, 500, 10_000, false] as const) }))
    },
    leave: () => {
      const id = pick([...listeners.keys()])
      listeners.get(id)?.()
      listeners.delete(id)
    },
    'listen and throw': () => {
      const id = ++ids
      listeners.set(id, mic.listen(hear(id, true)))
    },
    meddle: () => {
      const stop = mic.onChange(() => {
        stop()
        meddlers.delete(stop)
        if (!ended) void steps[pick(['listen', 'leave', 'hold', 'release'])]()
      })
      meddlers.add(stop)
    },
    hold: () => {
      steps.release()
      hold = mic.hold(hear(0))
    },
    release: () => {
      const stop = hold
      hold = null
      stop?.()
    },
    yes: () => answer('yes'),
    no: () => answer('no'),
    'no, but it is on': () => answer('no, but it is on'),
    sound,
    wait: () => void vi.advanceTimersByTimeAsync(pick([100, 500, 1_000, MIC_SILENT_MS, 5_000])),
  }
  const step = async (name: string) => {
    log.push(name)
    await steps[name]()
    await vi.advanceTimersByTimeAsync(0)
    if (news.length) expect(news.at(-1), 'the last news is how it stands').toBe(mic.open)
    if (mic.open && listeners.size === 0 && hold === null)
      expect(on || calls.length > 0, 'taken for open with nothing listening only until the close is answered').toBe(true)
  }
  const settleDown = async () => {
    for (let round = 0; round < 40; round++) {
      while (calls.length) {
        answer('yes')
        await vi.advanceTimersByTimeAsync(0)
      }
      sound()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    while (calls.length) {
      answer('yes')
      await vi.advanceTimersByTimeAsync(0)
    }
    sound()
    await vi.advanceTimersByTimeAsync(0)
  }
  return {
    log,
    life,
    mic,
    step,
    settleDown,
    names: Object.keys(steps),
    pick,
    isOn: () => on,
    leaveAll: () => {
      for (const stop of meddlers) stop()
      meddlers.clear()
      while (listeners.size || hold) {
        for (const id of [...listeners.keys()]) {
          listeners.get(id)?.()
          listeners.delete(id)
        }
        steps.release()
      }
    },
    end: () => {
      ended = true
      life.end()
      listeners.clear()
      hold = null
    },
    wanted: () => listeners.size > 0 || hold !== null,
  }
}

const SEEDS = Array.from({ length: 300 }, (_, seed) => seed + 1)

it.each(SEEDS)('any order of events, then calm: open if something listens, and closed once nothing does (seed %i)', async seed => {
  const run = world(seed)
  try {
    for (let at = 0; at < STEPS; at++) await run.step(run.pick(run.names))
    await run.settleDown()
    expect(run.isOn(), 'capture is on exactly when something listens').toBe(run.wanted())
    expect(run.mic.open, 'and it is taken for what it is').toBe(run.wanted())
    run.leaveAll()
    await run.settleDown()
    expect(run.isOn(), 'capture is off once nothing listens').toBe(false)
    expect(run.mic.open).toBe(false)
  } catch (error) {
    throw new Error(`After: ${run.log.join(', ')}\n${String(error)}`)
  }
})

it.each(SEEDS)('any order of events, then the end with fewer than five refused closes: the microphone is closed (seed %i)', async seed => {
  const run = world(seed)
  try {
    for (let at = 0; at < STEPS; at++) await run.step(run.pick(run.names))
    run.end()
    await vi.advanceTimersByTimeAsync(0)
    for (let at = 0; at < 10; at++) await run.step(run.pick(at < 4 ? ['yes', 'no', 'no, but it is on', 'wait'] : ['yes', 'wait']))
    await run.settleDown()
    expect(run.isOn(), 'capture is off after the end').toBe(false)
    expect(run.mic.open).toBe(false)
  } catch (error) {
    throw new Error(`After: ${run.log.join(', ')}\n${String(error)}`)
  }
})
