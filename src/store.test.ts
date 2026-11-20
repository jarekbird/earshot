import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore, evenPlace, memoryPlace, StoreError, webPlace, type Place } from './store.js'

function fragile() {
  const inner = memoryPlace()
  const held: (() => void)[] = []
  let arrived = () => {}
  const place = {
    down: false,
    slow: false,
    failing: 0,
    writes: 0,
    holding: () => (held.length ? Promise.resolve() : new Promise<void>(go => (arrived = go))),
    release: () => held.splice(0).forEach(go => go()),
    read: async (key: string) => {
      if (place.down) throw new Error('down')
      return inner.read(key)
    },
    write: async (key: string, text: string) => {
      if (place.down || place.failing-- > 0) throw new Error('down')
      place.writes++
      if (place.slow) {
        await new Promise<void>(go => {
          held.push(go)
          arrived()
        })
      }
      await inner.write(key, text)
    },
  }
  return place satisfies Place
}

describe('a store', () => {
  it('gives nothing for a key never saved', async () => {
    expect(await createStore([memoryPlace()]).get('pairing')).toBeNull()
  })

  it('gives back what was saved, an empty text included', async () => {
    const store = createStore([memoryPlace()])
    await store.set('pairing', 'abc')
    await store.set('note', '')
    expect(await store.get('pairing')).toBe('abc')
    expect(await store.get('note')).toBe('')
  })

  it('gives nothing after a remove', async () => {
    const store = createStore([memoryPlace()])
    await store.set('pairing', 'abc')
    await store.remove('pairing')
    expect(await store.get('pairing')).toBeNull()
  })

  it('keeps keys apart', async () => {
    const store = createStore([memoryPlace()])
    await store.set('one', '1')
    await store.set('two', '2')
    await store.remove('one')
    expect(await store.get('two')).toBe('2')
  })
})

describe('two places', () => {
  it('saves to both, so either can lose its copy', async () => {
    const [first, second] = [memoryPlace(), memoryPlace()]
    await createStore([first, second]).set('pairing', 'abc')
    expect(await createStore([first, memoryPlace()]).get('pairing')).toBe('abc')
    expect(await createStore([memoryPlace(), second]).get('pairing')).toBe('abc')
  })

  it('reads the newer copy when a save reached only one place', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'old')
    first.down = true
    await store.set('pairing', 'new')
    first.down = false
    expect(await createStore([first, second]).get('pairing')).toBe('new')
  })

  it('does not bring back a value whose remove reached only one place', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'abc')
    first.down = true
    await store.remove('pairing')
    first.down = false
    expect(await createStore([first, second]).get('pairing')).toBeNull()
  })

  it('repairs the place that fell behind when it reads', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'old')
    first.down = true
    await store.set('pairing', 'new')
    first.down = false
    await createStore([first, second]).get('pairing')
    expect(await createStore([first, memoryPlace()]).get('pairing')).toBe('new')
  })

  it('writes nothing on a read when the places agree', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'abc')
    await store.get('pairing')
    await store.get('missing')
    expect([first.writes, second.writes]).toEqual([1, 1])
  })

  it('keeps a newer save newer when the clock goes back', async () => {
    const [first, second] = [fragile(), fragile()]
    let time = 5_000
    const store = createStore([first, second], { now: () => time })
    await store.set('pairing', 'old')
    time = 1_000
    first.down = true
    await store.set('pairing', 'new')
    first.down = false
    expect(await store.get('pairing')).toBe('new')
  })

  it('keeps a newer save newer when the clock went back before this launch', async () => {
    const [first, second] = [fragile(), fragile()]
    await createStore([first, second], { now: () => 5_000 }).set('pairing', 'old')
    second.failing = 1
    await createStore([first, second], { now: () => 1_000 }).set('pairing', 'new')
    expect(await createStore([first, second]).get('pairing')).toBe('new')
  })
})

describe('failures', () => {
  it('saves when one place is down', async () => {
    const [first, second] = [fragile(), fragile()]
    first.down = true
    const store = createStore([first, second])
    await store.set('pairing', 'abc')
    expect(await store.get('pairing')).toBe('abc')
  })

  it('reports a save or a remove that no place stored', async () => {
    const [first, second] = [fragile(), fragile()]
    first.down = second.down = true
    const store = createStore([first, second])
    await expect(store.set('pairing', 'abc')).rejects.toBeInstanceOf(StoreError)
    await expect(store.remove('pairing')).rejects.toBeInstanceOf(StoreError)
  })

  it('reports a read that no place answered, and does not call it nothing', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'abc')
    first.down = second.down = true
    await expect(store.get('pairing')).rejects.toBeInstanceOf(StoreError)
  })

  it('reads from the place that answers', async () => {
    const [first, second] = [fragile(), fragile()]
    const store = createStore([first, second])
    await store.set('pairing', 'abc')
    first.down = true
    expect(await store.get('pairing')).toBe('abc')
    expect(await store.get('missing')).toBeNull()
  })
})

describe('order', () => {
  it('lands saves to one key in the order they were made', async () => {
    const place = fragile()
    const store = createStore([place])
    place.slow = true
    const first = store.set('pairing', 'first')
    await place.holding()
    place.slow = false
    const second = store.set('pairing', 'second')
    place.release()
    await Promise.all([first, second])
    expect(await store.get('pairing')).toBe('second')
  })

  it('reads after the saves made before it', async () => {
    const place = fragile()
    const store = createStore([place])
    place.slow = true
    void store.set('pairing', 'abc')
    const read = store.get('pairing')
    await place.holding()
    place.release()
    expect(await read).toBe('abc')
  })

  it('carries on after a failed save', async () => {
    const place = fragile()
    const store = createStore([place])
    place.failing = 1
    const failed = store.set('pairing', 'lost')
    const kept = store.set('pairing', 'kept')
    await expect(failed).rejects.toBeInstanceOf(StoreError)
    await kept
    expect(await store.get('pairing')).toBe('kept')
  })

  it('does not hold one key up behind another', async () => {
    const place = fragile()
    const store = createStore([place])
    place.slow = true
    const held = store.set('slow', '1')
    await place.holding()
    place.slow = false
    await store.set('quick', '2')
    expect(await store.get('quick')).toBe('2')
    place.release()
    await held
  })
})

describe('text saved before Earshot', () => {
  it('reads it as it is', async () => {
    const place = memoryPlace()
    await place.write('pairing', '{"token":"abc"}')
    expect(await createStore([place]).get('pairing')).toBe('{"token":"abc"}')
  })

  it('takes the first place when both hold it', async () => {
    const [first, second] = [memoryPlace(), memoryPlace()]
    await first.write('pairing', 'from even')
    await second.write('pairing', 'from the web view')
    expect(await createStore([first, second]).get('pairing')).toBe('from even')
  })

  it('copies it to the place that lacks it', async () => {
    const [first, second] = [memoryPlace(), memoryPlace()]
    await second.write('pairing', 'abc')
    await createStore([first, second]).get('pairing')
    expect(await createStore([first]).get('pairing')).toBe('abc')
  })

  it('gives way to anything saved since', async () => {
    const [first, second] = [fragile(), fragile()]
    await first.write('pairing', 'before')
    await second.write('pairing', 'before')
    first.down = true
    await createStore([first, second]).set('pairing', 'since')
    first.down = false
    expect(await createStore([first, second]).get('pairing')).toBe('since')
  })
})

describe('evenPlace', () => {
  const bridge = (accept = true) => {
    const items = new Map<string, string>()
    return {
      items,
      getLocalStorage: async (key: string) => items.get(key) ?? '',
      setLocalStorage: async (key: string, value: string) => {
        if (accept) items.set(key, value)
        return accept
      },
    }
  }

  it('keeps text in the Even app, and reads an empty answer as nothing', async () => {
    const even = bridge()
    const place = evenPlace(even)
    expect(await place.read('pairing')).toBeNull()
    await place.write('pairing', 'abc')
    expect(even.items.get('pairing')).toBe('abc')
    expect(await place.read('pairing')).toBe('abc')
  })

  it('fails a write the Even app refused', async () => {
    await expect(evenPlace(bridge(false)).write('pairing', 'abc')).rejects.toThrow()
  })
})

describe('webPlace', () => {
  afterEach(() => void vi.unstubAllGlobals())

  const storage = () => {
    const items = new Map<string, string>()
    return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
  }

  it('keeps text in the web view', async () => {
    const web = storage()
    const place = webPlace(web)
    expect(await place.read('pairing')).toBeNull()
    await place.write('pairing', 'abc')
    expect(web.items.get('pairing')).toBe('abc')
    expect(await place.read('pairing')).toBe('abc')
  })

  it('fails, not throws, when the web view refuses', async () => {
    const full = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    await expect(webPlace(full).read('pairing')).rejects.toThrow('blocked')
    await expect(webPlace(full).write('pairing', 'abc')).rejects.toThrow('full')
  })

  it('uses the web view storage of the page when given none', async () => {
    const web = storage()
    vi.stubGlobal('localStorage', web)
    await webPlace().write('pairing', 'abc')
    expect(web.items.get('pairing')).toBe('abc')
    expect(await webPlace().read('pairing')).toBe('abc')
  })

  it('fails where there is no web view storage at all', async () => {
    vi.stubGlobal('localStorage', undefined)
    await expect(webPlace().read('pairing')).rejects.toThrow()
    await expect(webPlace().write('pairing', 'abc')).rejects.toThrow()
  })
})
