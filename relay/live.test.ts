import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocket as Caller, WebSocketServer } from 'ws'
import { fluxLive, FLUX, LIVE_PATH as APP_PATH, REFUSALS } from '../src/flux/flux.js'
import { Lifetime } from '../src/lifetime.js'
import type { LiveState, Turn } from '../src/live.js'
import { serve, settings } from './node.js'
import { CLOSES, HELLO_MS, LIVE_PATH, MAX_FRAME, MIN_SECRET, relayOptions } from './relay.js'

const ROOT = join(import.meta.dirname, '..')
const RECORDED = readFileSync(join(ROOT, 'src/flux/recorded.jsonl'), 'utf8').trim().split('\n')
const DEVELOPER = 'sk-developer'
const LIVE_KEY = 'live-developer'
const PHRASE = 'what only this phone was told'
const HELLO = { model: FLUX, encoding: 'linear16', sample_rate: '16000' }
const WAIT = { timeout: 8_000, interval: 10 }
const SLOW_MS = 300

interface Setup {
  live?: boolean
  key?: string
  models?: string
  script?: readonly string[]
  slowMs?: number
}

async function gateway({ script, slowMs = 0 }: Setup = {}) {
  const seen = { urls: [] as string[], sound: 0, text: [] as string[], closed: 0, refused: 0 }
  const callers = new Set<Caller>()
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: ({ req }: { req: { headers: Record<string, unknown> } }, answer: (known: boolean, status?: number) => void) => {
      const known = req.headers['cf-aig-authorization'] === `Bearer ${LIVE_KEY}`
      if (!known) seen.refused++
      setTimeout(() => answer(known, 401), slowMs)
    },
  })
  await new Promise<void>(listening => server.once('listening', listening))
  server.on('connection', (caller, request) => {
    callers.add(caller)
    seen.urls.push(request.url ?? '')
    caller.send(script?.[0] ?? JSON.stringify({ type: 'Connected' }))
    caller.send(new Uint8Array(8))
    caller.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) return void seen.text.push(String(data))
      const first = seen.sound === 0
      seen.sound += data.length
      if (!script)
        return caller.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: `heard ${seen.sound}` }))
      if (first) for (const message of script.slice(1)) caller.send(message)
    })
    caller.on('close', () => seen.closed++)
  })
  const stop = () => {
    for (const caller of callers) caller.terminate()
    server.close()
  }
  onTestFinished(stop)
  return {
    seen,
    at: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/account/gateway/workers-ai`,
    hangUp: () => callers.forEach(caller => caller.close(1000)),
    stop,
  }
}

type Host = { at: string; up: Awaited<ReturnType<typeof gateway>> }

let worker = ''
beforeAll(async () => {
  const built = await build({
    entryPoints: [join(ROOT, 'example/worker.ts')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  worker = built.outputFiles[0].text
})

const HOSTS: Record<string, (setup: Setup) => Promise<Host>> = {
  async 'the Node server'({ live = true, key = LIVE_KEY, models, ...rest }) {
    const up = await gateway(rest)
    const server = await serve({
      ...settings({
        EARSHOT_RELAY_KEY: DEVELOPER,
        EARSHOT_RELAY_UPSTREAM: 'http://127.0.0.1:9',
        ...(live ? { EARSHOT_RELAY_LIVE_UPSTREAM: up.at, EARSHOT_RELAY_LIVE_KEY: key, EARSHOT_RELAY_SECRET: PHRASE } : {}),
        ...(models ? { EARSHOT_RELAY_LIVE_MODELS: models } : {}),
      }),
      port: 0,
      hostname: '127.0.0.1',
    })
    onTestFinished(() => void server.closeAllConnections())
    onTestFinished(() => void server.close())
    return { at: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, up }
  },
  async 'the Worker'({ live = true, key = LIVE_KEY, models, ...rest }) {
    const up = await gateway(rest)
    const runtime = new Miniflare({
      modules: true,
      script: worker,
      compatibilityDate: '2026-07-01',
      bindings: {
        OPENROUTER_KEY: DEVELOPER,
        UPSTREAM: 'http://127.0.0.1:9',
        ...(live ? { LIVE_UPSTREAM: up.at, LIVE_KEY: key, SECRET: PHRASE } : {}),
        ...(models ? { LIVE_MODELS: models } : {}),
      },
    })
    onTestFinished(() => runtime.dispose())
    return { at: (await runtime.ready).href.replace(/\/$/, ''), up }
  },
}

async function both<T>(setup: Setup, run: (host: Host) => Promise<T>): Promise<T> {
  const [node, edge] = await Promise.all(Object.values(HOSTS).map(async start => run(await start(setup))))
  expect(edge, 'the Worker answers as the Node server does').toEqual(node)
  return node
}

function call(at: string) {
  const line = new Caller(`${at.replace(/^http/, 'ws')}${LIVE_PATH}`)
  const got: string[] = []
  line.on('message', (data: Buffer, binary: boolean) => got.push(binary ? 'binary' : String(data)))
  line.on('error', () => {})
  const ended = new Promise<number>(done => {
    line.on('close', code => done(code))
    line.on('unexpected-response', (_request, response) => {
      response.resume()
      done(response.statusCode ?? 0)
    })
  })
  const opened = new Promise<void>(done => line.once('open', done))
  onTestFinished(() => line.terminate())
  const say = async (...messages: Array<object | string | Uint8Array>) => {
    await opened
    for (const message of messages)
      line.send(typeof message === 'object' && !(message instanceof Uint8Array) ? JSON.stringify(message) : message)
  }
  return { line, got, ended, say }
}

const greeting = (more: object = {}) => ({ ...HELLO, secret: PHRASE, ...more })

describe('E13: live speech through the relay, on the Node server and on the Worker', () => {
  it('both carry sound up and words back once the caller has greeted with the secret', async () => {
    const answer = await both({}, async ({ at, up }) => {
      const { got, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      await say(new Uint8Array(3_200))
      await vi.waitFor(() => expect(got).toHaveLength(2), WAIT)
      return { got, urls: up.seen.urls, sound: up.seen.sound }
    })
    expect(answer.got.map(text => JSON.parse(text))).toEqual([
      { type: 'Connected' },
      { type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: 'heard 3200' },
    ])
    expect(answer.urls).toEqual(['/v1/account/gateway/workers-ai?model=%40cf%2Fdeepgram%2Fflux&encoding=linear16&sample_rate=16000'])
  })

  it('both ask the upstream only for what the relay lists, and never pass the secret on', async () => {
    const urls = await both({}, async ({ at, up }) => {
      const { got, say } = call(at)
      await say(greeting({ eot_timeout_ms: '3000', eot_threshold: 0.8, mip_opt_out: 'false', tag: 'x' }))
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      return up.seen.urls
    })
    expect(urls).toEqual([
      '/v1/account/gateway/workers-ai?model=%40cf%2Fdeepgram%2Fflux&encoding=linear16&sample_rate=16000&eot_timeout_ms=3000',
    ])
  })

  it.each([
    { name: 'a wrong secret', hello: { ...HELLO, secret: `${PHRASE}!` }, code: CLOSES.secret },
    { name: 'the start of the secret', hello: { ...HELLO, secret: PHRASE.slice(0, -1) }, code: CLOSES.secret },
    {
      name: 'a secret of the right length and one wrong letter',
      hello: { ...HELLO, secret: PHRASE.replace('told', 'sold') },
      code: CLOSES.secret,
    },
    { name: 'no secret', hello: HELLO, code: CLOSES.secret },
    { name: 'a secret that is not text', hello: { ...HELLO, secret: 1 }, code: CLOSES.secret },
    { name: 'a model nobody listed', hello: greeting({ model: 'other/model' }), code: CLOSES.model },
    { name: 'no model', hello: { secret: PHRASE }, code: CLOSES.model },
    { name: 'a greeting that is not JSON', hello: 'hello', code: CLOSES.hello },
    { name: 'a greeting that is a list', hello: '[1]', code: CLOSES.hello },
    { name: 'sound before any greeting', hello: new Uint8Array(3_200), code: CLOSES.hello },
    { name: 'a greeting too long to be one', hello: greeting({ pad: 'a'.repeat(4_096) }), code: CLOSES.hello },
  ])('both refuse $name, and reach for no upstream', async ({ hello, code }) => {
    const answer = await both({}, async ({ at, up }) => {
      const { got, ended, say } = call(at)
      await say(hello)
      return { code: await ended, got, reached: up.seen.urls.length + up.seen.refused }
    })
    expect(answer).toEqual({ code, got: [], reached: 0 })
  })

  it('both take the model the developer listed, and then not their own', async () => {
    const answer = await both({ models: 'a/one, b/two' }, async ({ at, up }) => {
      const listed = call(at)
      await listed.say(greeting({ model: 'b/two' }))
      await vi.waitFor(() => expect(listed.got).toHaveLength(1), WAIT)
      const own = call(at)
      await own.say(greeting())
      return { own: await own.ended, urls: up.seen.urls }
    })
    expect(answer).toEqual({
      own: CLOSES.model,
      urls: ['/v1/account/gateway/workers-ai?model=b%2Ftwo&encoding=linear16&sample_rate=16000'],
    })
  })

  it('both hang up on a caller who does not greet in time, and keep the one who did', async () => {
    const started = Date.now()
    const answer = await both({}, async ({ at, up }) => {
      const greeted = call(at)
      await greeted.say(greeting())
      const code = await call(at).ended
      await greeted.say(new Uint8Array(320))
      await vi.waitFor(() => expect(up.seen.sound).toBe(320), WAIT)
      return { code, open: greeted.line.readyState === Caller.OPEN }
    })
    expect(answer).toEqual({ code: CLOSES.hello, open: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(HELLO_MS - 50)
  })

  // Fact: a Worker drops what it was reaching for when its caller leaves, and the Node server lets it open. Neither may keep it.
  it('both leave no upstream open when the caller goes while it is being reached', async () => {
    await both({ slowMs: SLOW_MS }, async ({ at, up }) => {
      const { line, say } = call(at)
      await say(greeting())
      line.close(1000)
      await new Promise(answered => setTimeout(answered, SLOW_MS * 2))
      await vi.waitFor(() => expect(up.seen.closed).toBe(up.seen.urls.length), WAIT)
    })
  })

  it('both say so when the upstream refuses the key', async () => {
    const answer = await both({ key: 'not-the-key' }, async ({ at, up }) => {
      const { got, ended, say } = call(at)
      await say(greeting())
      return { code: await ended, got, refused: up.seen.refused > 0, opened: up.seen.urls.length }
    })
    expect(answer).toEqual({ code: CLOSES.upstream, got: [], refused: true, opened: 0 })
  })

  it('both say so when the upstream cannot be reached', async () => {
    const code = await both({}, async ({ at, up }) => {
      up.stop()
      const { ended, say } = call(at)
      await say(greeting())
      return ended
    })
    expect(code).toBe(CLOSES.upstream)
  })

  it('both hang up on the caller when the upstream goes', async () => {
    const code = await both({}, async ({ at, up }) => {
      const { got, ended, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      up.hangUp()
      return ended
    })
    expect(code).toBe(CLOSES.upstream)
  })

  it('both close the upstream when the caller leaves', async () => {
    await both({}, async ({ at, up }) => {
      const { line, got, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      line.close(1000)
      await vi.waitFor(() => expect(up.seen.closed).toBe(1), WAIT)
    })
  })

  it('both pass on sound only: what the caller says in text after the greeting goes nowhere', async () => {
    const answer = await both({}, async ({ at, up }) => {
      const { got, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      await say(JSON.stringify({ type: 'Configure' }), new Uint8Array(320))
      await vi.waitFor(() => expect(up.seen.sound).toBe(320), WAIT)
      return up.seen.text
    })
    expect(answer).toEqual([])
  })

  it('both hang up on a caller who sends more sound in one piece than a second holds', async () => {
    const answer = await both({}, async ({ at, up }) => {
      const { got, ended, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      await say(new Uint8Array(MAX_FRAME + 1))
      return { code: await ended, sound: up.seen.sound }
    })
    expect(answer).toEqual({ code: CLOSES.hello, sound: 0 })
  })

  it('both answer a plain request for the live path without taking it', async () => {
    const answer = await both({}, async ({ at }) => {
      const response = await fetch(`${at}${LIVE_PATH}`)
      return { status: response.status, body: await response.json() }
    })
    expect(answer).toEqual({ status: 426, body: { error: 'Only a WebSocket.' } })
  })

  it('both know no live path when the developer set no upstream for it', async () => {
    const status = await both({ live: false }, async ({ at }) => call(at).ended)
    expect(status).toBe(404)
  })

  it("both give the app's own transport the turns of a recorded stream", async () => {
    const answer = await both({ script: RECORDED }, async ({ at }) => {
      const life = new Lifetime()
      onTestFinished(() => life.end())
      const turns: Turn[] = []
      const states: LiveState[] = []
      const hear = fluxLive({ host: at, secret: PHRASE }).start(
        life,
        turn => turns.push(turn),
        state => states.push(state),
      )
      hear({ pcm: new Uint8Array(3_200), speaker: 'other', gap: false })
      await vi.waitFor(() => expect(turns.filter(turn => turn.final)).toHaveLength(3), WAIT)
      return { final: turns.filter(turn => turn.final), states }
    })
    expect(answer.states).toEqual([])
    expect(answer.final.map(turn => turn.words)).toEqual([
      'Good morning. Did you get a chance to look at the quarterly numbers I sent on Friday?',
      'I did, yes. Revenue is up eleven percent, but support costs worry me.',
      "Let's put that on the agenda for Thursday.",
    ])
  })

  it("both tell the app's own transport that it is refused when its secret is wrong", async () => {
    const states = await both({}, async ({ at }) => {
      const life = new Lifetime()
      onTestFinished(() => life.end())
      const told: LiveState[] = []
      const hear = fluxLive({ host: at, secret: `${PHRASE}?` }).start(
        life,
        () => {},
        state => told.push(state),
      )
      hear({ pcm: new Uint8Array(3_200), speaker: 'other', gap: false })
      await vi.waitFor(() => expect(told).toHaveLength(1), WAIT)
      return told
    })
    expect(states).toEqual(['refused'])
  })
})

describe('the settings of live speech', () => {
  const base = { key: DEVELOPER, upstream: 'https://upstream.example', models: undefined, liveModels: undefined }

  it('the app and the relay agree on the path and on what is refused for good', () => {
    expect(APP_PATH).toBe(LIVE_PATH)
    expect(REFUSALS).toEqual({ hello: CLOSES.hello, secret: CLOSES.secret, model: CLOSES.model })
    expect(Object.values(REFUSALS)).not.toContain(CLOSES.upstream)
  })

  it('a relay with no live upstream has no live path, whatever else is set', () => {
    expect(relayOptions({ ...base, liveUpstream: undefined, liveKey: LIVE_KEY, secret: PHRASE }).live).toBeUndefined()
  })

  it('a live upstream is refused without its key', () => {
    expect(() => relayOptions({ ...base, liveUpstream: 'wss://speech.example', liveKey: undefined, secret: PHRASE })).toThrow(
      'needs the key',
    )
  })

  it.each([undefined, '', 'a'.repeat(MIN_SECRET - 1)])(
    'a live upstream is refused with the secret %j: anyone could run up the bill',
    secret => {
      expect(() => relayOptions({ ...base, liveUpstream: 'wss://speech.example', liveKey: LIVE_KEY, secret })).toThrow('needs a secret')
    },
  )

  it('a live upstream with its key and a secret gives the live path, with the models the developer listed', () => {
    expect(
      relayOptions({ ...base, liveUpstream: 'wss://speech.example', liveKey: LIVE_KEY, secret: PHRASE, liveModels: ' a/one ,b/two' }).live,
    ).toEqual({
      upstream: 'wss://speech.example',
      key: LIVE_KEY,
      secret: PHRASE,
      models: ['a/one', 'b/two'],
    })
  })
})
