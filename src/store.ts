export class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

export interface Place {
  read(key: string): Promise<string | null>
  write(key: string, text: string): Promise<void>
}

export interface Store {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface StoreOptions {
  now?: () => number
}

export interface EvenStorage {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}

export type WebStorage = Pick<Storage, 'getItem' | 'setItem'>

export function evenPlace(bridge: EvenStorage): Place {
  return {
    read: async key => (await bridge.getLocalStorage(key)) || null,
    write: async (key, text) => {
      if (!(await bridge.setLocalStorage(key, text))) throw new StoreError('The Even app did not store it.')
    },
  }
}

export function webPlace(storage?: WebStorage): Place {
  return {
    read: async key => (storage ?? localStorage).getItem(key),
    write: async (key, text) => (storage ?? localStorage).setItem(key, text),
  }
}

export function memoryPlace(): Place {
  const items = new Map<string, string>()
  return {
    read: async key => items.get(key) ?? null,
    write: async (key, text) => void items.set(key, text),
  }
}

interface Copy {
  at: number
  value: string | null
  text: string | null
}

const MISSING: Copy = { at: -1, value: null, text: null }

const seal = (at: number, value: string | null) => JSON.stringify(value === null ? { earshot: 1, at } : { earshot: 1, at, value })

function open(text: string | null): Copy {
  if (!text) return MISSING
  try {
    const sealed: unknown = JSON.parse(text)
    if (
      sealed &&
      typeof sealed === 'object' &&
      'earshot' in sealed &&
      sealed.earshot === 1 &&
      'at' in sealed &&
      typeof sealed.at === 'number'
    ) {
      return { at: sealed.at, value: 'value' in sealed && typeof sealed.value === 'string' ? sealed.value : null, text }
    }
  } catch {}
  return { at: 0, value: text, text }
}

export function createStore(places: Place[], options: StoreOptions = {}): Store {
  const now = options.now ?? Date.now
  const newest = new Map<string, number>()
  const tails = new Map<string, Promise<void>>()

  function inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(work)
    const tail = result.then(
      () => {},
      () => {},
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }

  async function copiesOf(key: string): Promise<(Copy | null)[]> {
    const reads = await Promise.allSettled(places.map(place => place.read(key)))
    const copies = reads.map(read => (read.status === 'fulfilled' ? open(read.value) : null))
    if (copies.some(copy => copy)) newest.set(key, Math.max(newest.get(key) ?? 0, ...copies.map(copy => copy?.at ?? 0)))
    return copies
  }

  async function save(key: string, value: string | null): Promise<void> {
    if (!newest.has(key)) await copiesOf(key)
    const at = Math.max(now(), (newest.get(key) ?? 0) + 1)
    newest.set(key, at)
    const text = seal(at, value)
    const stored = await Promise.allSettled(places.map(place => place.write(key, text)))
    if (!stored.some(write => write.status === 'fulfilled')) throw new StoreError('No place stored it.')
  }

  async function load(key: string): Promise<string | null> {
    const copies = await copiesOf(key)
    const answered = copies.filter(copy => copy !== null)
    if (!answered.length) throw new StoreError('No place could be read.')
    const latest = answered.reduce((best, copy) => (copy.at > best.at ? copy : best))
    const text = latest.text
    if (text !== null) {
      await Promise.allSettled(
        places.map((place, index) => (copies[index] && copies[index].at < latest.at ? place.write(key, text) : undefined)),
      )
    }
    return latest.value
  }

  return {
    get: key => inOrder(key, () => load(key)),
    set: (key, value) => inOrder(key, () => save(key, value)),
    remove: key => inOrder(key, () => save(key, null)),
  }
}
