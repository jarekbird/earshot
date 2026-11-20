import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifetime, LifetimeEnded } from './lifetime.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('own', () => {
  it('runs each cleanup once when the lifetime ends, newest first', () => {
    const life = new Lifetime()
    const ran: string[] = []
    life.own(() => ran.push('first'))
    life.own(() => ran.push('second'))
    life.end()
    life.end()
    expect(ran).toEqual(['second', 'first'])
    expect(life.ended).toBe(true)
  })

  it('runs a cleanup at once when the lifetime has already ended', () => {
    const life = new Lifetime()
    life.end()
    const cleanup = vi.fn()
    life.own(cleanup)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('returns a release that runs the cleanup early, and only once', () => {
    const life = new Lifetime()
    const cleanup = vi.fn()
    const release = life.own(cleanup)
    release()
    release()
    life.end()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('runs every cleanup even when one throws, then reports all the errors', () => {
    const life = new Lifetime()
    const ran: string[] = []
    life.own(() => ran.push('first'))
    life.own(() => {
      throw new Error('second failed')
    })
    life.own(() => ran.push('third'))
    life.own(() => {
      throw new Error('fourth failed')
    })
    let thrown: unknown
    try {
      life.end()
    } catch (error) {
      thrown = error
    }
    expect(ran).toEqual(['third', 'first'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors.map(e => (e as Error).message)).toEqual(['fourth failed', 'second failed'])
    expect(life.ended).toBe(true)
  })
})

describe('signal', () => {
  it('aborts with LifetimeEnded when the lifetime ends', () => {
    const life = new Lifetime()
    expect(life.signal.aborted).toBe(false)
    life.end()
    expect(life.signal.aborted).toBe(true)
    expect(life.signal.reason).toBeInstanceOf(LifetimeEnded)
  })

  it('aborts even when a cleanup throws', () => {
    const life = new Lifetime()
    life.own(() => {
      throw new Error('failed')
    })
    expect(() => life.end()).toThrow(AggregateError)
    expect(life.signal.aborted).toBe(true)
  })
})

describe('timeout', () => {
  it('runs once after the delay and keeps nothing behind', () => {
    const life = new Lifetime()
    const run = vi.fn()
    life.timeout(run, 100)
    expect(life.owned).toBe(1)
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledOnce()
    expect(life.owned).toBe(0)
  })

  it('does not run after it is cancelled or the lifetime ends', () => {
    const life = new Lifetime()
    const cancelled = vi.fn()
    const ended = vi.fn()
    life.timeout(cancelled, 100).cancel()
    life.timeout(ended, 100)
    expect(life.owned).toBe(1)
    life.end()
    vi.advanceTimersByTime(1_000)
    expect(cancelled).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
  })

  it('never runs when the lifetime has already ended', () => {
    const life = new Lifetime()
    life.end()
    const run = vi.fn()
    life.timeout(run, 0).cancel()
    vi.advanceTimersByTime(1_000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('interval', () => {
  it('repeats until it is cancelled', () => {
    const life = new Lifetime()
    const run = vi.fn()
    const timer = life.interval(run, 100)
    vi.advanceTimersByTime(250)
    timer.cancel()
    vi.advanceTimersByTime(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(life.owned).toBe(0)
  })

  it('stops when the lifetime ends', () => {
    const life = new Lifetime()
    const run = vi.fn()
    life.interval(run, 100)
    life.end()
    vi.advanceTimersByTime(1_000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('guard', () => {
  it('gives the result of work that finishes first, and keeps nothing behind', async () => {
    const life = new Lifetime()
    await expect(life.guard(Promise.resolve('done'))).resolves.toBe('done')
    await expect(life.guard('plain')).resolves.toBe('plain')
    expect(life.owned).toBe(0)
  })

  it('passes on the failure of work that fails first', async () => {
    const life = new Lifetime()
    await expect(life.guard(Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    expect(life.owned).toBe(0)
  })

  it('rejects with LifetimeEnded when the lifetime ends first, whatever the work does later', async () => {
    const life = new Lifetime()
    let fail = (_: Error) => {}
    const guarded = life.guard(new Promise<string>((_, reject) => void (fail = reject)))
    life.end()
    fail(new Error('late failure'))
    await expect(guarded).rejects.toBeInstanceOf(LifetimeEnded)
  })

  it('rejects with LifetimeEnded when the lifetime has already ended', async () => {
    const life = new Lifetime()
    life.end()
    await expect(life.guard(Promise.reject(new Error('ignored')))).rejects.toBeInstanceOf(LifetimeEnded)
  })
})

describe('listen', () => {
  it('hears events until the lifetime ends', () => {
    const life = new Lifetime()
    const target = new EventTarget()
    const heard = vi.fn()
    life.listen(target, 'ping', heard)
    target.dispatchEvent(new Event('ping'))
    life.end()
    target.dispatchEvent(new Event('ping'))
    expect(heard).toHaveBeenCalledOnce()
  })

  it('returns a release that stops listening early', () => {
    const life = new Lifetime()
    const target = new EventTarget()
    const heard = vi.fn()
    life.listen(target, 'ping', heard)()
    target.dispatchEvent(new Event('ping'))
    expect(heard).not.toHaveBeenCalled()
    expect(life.owned).toBe(0)
  })

  it('never listens when the lifetime has already ended', () => {
    const life = new Lifetime()
    life.end()
    const target = new EventTarget()
    const add = vi.spyOn(target, 'addEventListener')
    life.listen(target, 'ping', () => {})
    expect(add).not.toHaveBeenCalled()
  })
})

describe('child', () => {
  it('ends with its parent', () => {
    const parent = new Lifetime()
    const child = parent.child()
    parent.end()
    expect(child.ended).toBe(true)
  })

  it('leaves its parent running, and nothing behind in it, when it ends first', () => {
    const parent = new Lifetime()
    const child = parent.child()
    child.end()
    expect(parent.ended).toBe(false)
    expect(parent.owned).toBe(0)
  })

  it('is already ended when its parent is', () => {
    const parent = new Lifetime()
    parent.end()
    expect(parent.child().ended).toBe(true)
  })
})
