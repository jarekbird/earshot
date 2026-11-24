import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fluxOver, type FluxSocket } from '../src/flux/flux.js'
import { Lifetime } from '../src/lifetime.js'
import { LIVE_PATH } from './limits.js'
import { DEFAULT_MODELS, relay, type Line, type Sockets } from './relay.js'

const PHRASE = 'what only this phone was told'
const PATHS = ['/api/v1/audio/transcriptions', '/api/alpha/decisions', '/api/v1/chat/completions']
const ELSEWHERE = ['https://elsewhere.example/', 'https://elsewhere.example/deep/er', 'http://127.0.0.1:1/']

const AWKWARD = [
  'S://good.example',
  'S://good.example/',
  'S://good.example/base',
  'S://good.example/base/',
  'S://GOOD.example',
  'S://good.example:8443/base',
  'S://good.example.',
  'S://good。example',
  ' S://good.example',
  'S://good.example ',
  'S://good.example\t',
  '\tS://good.example',
  'S://good.example/\t',
  'S://good.example/ ',
  'S://good.example\n/x',
  'S://good.ex\tample',
  'S://good.example\\@evil.example',
  'S://good.example@evil.example',
  'S://good.example:pass@evil.example',
  'S://good.example%2F@evil.example',
  'S://evil.example#@good.example',
  'S://evil.example?@good.example',
  'S://good.example/..//evil.example',
  'S://good.example//evil.example',
  'S://good.example/\\evil.example',
  'S://good.example/base/..',
  'S://good.example/%2e%2e/x',
  'S:/\\evil.example',
  'S:\\\\evil.example',
  'S:///evil.example',
  'S:evil.example',
  'S:/evil.example',
  '//evil.example',
  '/\\evil.example',
  '/base',
  'base',
  '',
  ' ',
  'S://',
  'S://?x',
  'S://[::1',
  'P://localhost:8787',
  'P://localhost:8787/base/',
  'P://localhost@evil.example',
  'P://localhost.evil.example',
  'P://127.0.0.1.evil.example',
  'P://127.0.0.1@evil.example',
  'P://[::1]@evil.example',
  'P://[::1]:8787',
  'P://127.0.0.1:8787\\@evil.example',
  'P://evil.example',
  'P://0x7f.1',
  'P://2130706433',
  'P://017700000001',
  'P://127.1',
  'P://localhost\t.evil.example',
]

const spelled = (address: string, secure: string, plain: string) =>
  address.replace(/^(\s*)S:/, `$1${secure}:`).replace(/^(\s*)P:/, `$1${plain}:`)

interface Outcome {
  refused: boolean
  reached: string[]
  read?: URL
}

const read = (address: string): URL | undefined => {
  try {
    return new URL(address)
  } catch {
    return undefined
  }
}

async function calls(address: string): Promise<Outcome> {
  const upstream = spelled(address, 'https', 'http')
  const reached: string[] = []
  let handle: ReturnType<typeof relay>
  try {
    handle = relay({
      key: 'sk-developer',
      upstream,
      fetch: async url => {
        reached.push(String(url))
        return new Response('{}')
      },
    })
  } catch {
    return { refused: true, reached }
  }
  for (const path of PATHS)
    await handle(new Request(`https://relay.example${path}`, { method: 'POST', body: JSON.stringify({ model: DEFAULT_MODELS[0] }) }))
  return { refused: false, reached, read: read(upstream) }
}

class Wire implements Line {
  binaryType = 'blob'
  heard: Array<(event: { data: unknown }) => void> = []
  send(): void {}
  close(): void {}
  addEventListener(type: 'message' | 'close', listener: never): void {
    if (type === 'message') this.heard.push(listener)
  }
}

async function live(address: string): Promise<Outcome> {
  const upstream = spelled(address, 'wss', 'ws')
  const reached: string[] = []
  const caller = new Wire()
  const sockets: Sockets = {
    accept: async () => ({ line: caller, response: new Response(null) }),
    dial: async url => void reached.push(url),
  }
  let handle: ReturnType<typeof relay>
  try {
    handle = relay({ live: { upstream, key: 'live-developer', secret: PHRASE } }, sockets)
  } catch {
    return { refused: true, reached }
  }
  await handle(new Request(`https://relay.example${LIVE_PATH}`, { headers: { upgrade: 'websocket' } }))
  for (const hear of caller.heard) hear({ data: JSON.stringify({ model: '@cf/deepgram/flux', secret: PHRASE }) })
  return { refused: false, reached, read: read(upstream) }
}

function transport(address: string): Outcome {
  const host = spelled(address, 'https', 'http')
  const reached: string[] = []
  const life = new Lifetime()
  try {
    const speech = fluxOver(
      { host, secret: PHRASE },
      {
        now: () => 0,
        open: url => {
          reached.push(url)
          return {
            binaryType: '',
            readyState: 0,
            bufferedAmount: 0,
            onopen: null,
            onmessage: null,
            onclose: null,
            send() {},
            close() {},
          } as FluxSocket
        },
      },
    )
    speech.start(life, () => {})({ pcm: new Uint8Array(320), speaker: 'unknown', gap: true })
  } catch {
    return { refused: true, reached }
  } finally {
    life.end()
  }
  return { refused: false, reached, read: read(host) }
}

const SOCKET: Record<string, string> = { 'https:': 'wss:', 'http:': 'ws:', 'wss:': 'wss:', 'ws:': 'ws:' }

function strays(outcome: Outcome, protocols: (read: URL) => string, after: (at: number) => string): string[] {
  if (outcome.refused) return outcome.reached
  if (!outcome.read || outcome.reached.length === 0) return ['taken, but never reached or never readable']
  const { read } = outcome
  const base = read.pathname.replace(/\/+$/, '')
  return outcome.reached.filter((reached, index) =>
    ELSEWHERE.some(from => {
      const at = new URL(reached, from)
      const sameHost = at.host === read.host && at.protocol === protocols(read)
      const sameName = at.username === read.username && at.password === read.password
      const asked = !read.search && !read.hash
      return !sameHost || !sameName || (asked && at.pathname.replace(/\/+$/, '') !== `${base}${after(index)}`)
    }),
  )
}

describe('E15: what carries a key, a secret or sound goes to the address that was checked', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const MESSAGE =
    'E15: this address was taken and then reached somewhere else than where the check read it. Read an address once, check that reading, and use that reading: never the text again.'

  it.each(AWKWARD)(
    "the relay's calls refuse %j or reach it where the check read it, wherever a host's fetch starts from",
    async address => {
      const outcome = await calls(address)
      expect(
        strays(
          outcome,
          read => read.protocol,
          at => PATHS[at],
        ),
        MESSAGE,
      ).toEqual([])
      if (!outcome.refused) expect(outcome.reached).toHaveLength(PATHS.length)
    },
  )

  it.each(AWKWARD)("the relay's live upstream refuses %j or dials it where the check read it", async address => {
    expect(
      strays(
        await live(address),
        read => read.protocol,
        () => '',
      ),
      MESSAGE,
    ).toEqual([])
  })

  it.each(AWKWARD)('the transport refuses %j as its relay or opens its line where the check read it', address => {
    expect(
      strays(
        transport(address),
        read => SOCKET[read.protocol],
        () => LIVE_PATH,
      ),
      MESSAGE,
    ).toEqual([])
  })

  it('the list is not all refusals: each of the three takes a plain good address, so the check above has something to hold', async () => {
    const taken = async (way: (address: string) => Outcome | Promise<Outcome>) =>
      (await Promise.all(AWKWARD.map(async address => ((await way(address)).refused ? [] : [address])))).flat()
    for (const way of [calls, live, transport]) {
      const addresses = await taken(way)
      expect(addresses).toContain('S://good.example')
      expect(addresses).toContain('P://localhost:8787')
      expect(addresses).not.toContain('P://evil.example')
    }
  })
})
