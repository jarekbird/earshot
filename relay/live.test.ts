import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { join } from 'node:path'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocket as Caller, WebSocketServer } from 'ws'
import { fluxLive, FLUX, LIVE_PATH as APP_PATH, REFUSALS } from '../src/flux/flux.js'
import { Lifetime } from '../src/lifetime.js'
import type { LiveState, Turn } from '../src/live.js'
import { Miniflare } from '../workerd/runtime.js'
import { serve, settings } from './node.js'
import { CLOSES, GOODBYE_MS, HELLO_MS, LIVE_PATH, MAX_FRAME, MAX_QUEUED, MAX_SECRET, MIN_SECRET } from './limits.js'
import { relay, relayOptions } from './relay.js'

const ROOT = join(import.meta.dirname, '..')
const RECORDED = readFileSync(join(ROOT, 'src/flux/recorded.jsonl'), 'utf8').trim().split('\n')
const DEVELOPER = 'sk-developer'
const LIVE_KEY = 'live-developer'
const PHRASE = 'what only this phone was told'
const HELLO = { model: FLUX, encoding: 'linear16', sample_rate: '16000' }
const WAIT = { timeout: 8_000, interval: 10 }

interface Setup {
  live?: boolean
  key?: string
  models?: string
  script?: readonly string[]
  slowMs?: number
  silent?: boolean
  calls?: boolean
  door?: boolean
  deaf?: boolean
  long?: 'text' | 'sound'
}

async function gateway({ script, slowMs = 0, silent = false, door = false, deaf = false, long }: Setup = {}) {
  const seen = {
    urls: [] as string[],
    sound: 0,
    text: [] as string[],
    closed: 0,
    codes: [] as number[],
    refused: 0,
    asked: 0,
    abandoned: 0,
  }
  const callers = new Set<Caller>()
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (
      { req }: { req: { headers: Record<string, unknown>; socket: Socket } },
      answer: (known: boolean, status?: number) => void,
    ) => {
      const known = req.headers['cf-aig-authorization'] === `Bearer ${LIVE_KEY}`
      seen.asked++
      if (!known) seen.refused++
      if (silent)
        return void req.socket
          .once('close', () => seen.abandoned++)
          .once('end', () => req.socket.destroy())
          .resume()
      setTimeout(() => answer(known, 401), slowMs)
    },
  })
  await new Promise<void>(listening => server.once('listening', listening))
  server.on('connection', (caller, request) => {
    callers.add(caller)
    seen.urls.push(request.url ?? '')
    caller.send(script?.[0] ?? JSON.stringify({ type: 'Connected' }))
    caller.send(new Uint8Array(8))
    if (long === 'text') caller.send(JSON.stringify({ type: 'TurnInfo', transcript: 'a'.repeat(MAX_FRAME) }))
    if (long === 'sound') caller.send(new Uint8Array(MAX_FRAME + 1))
    if (long) caller.send(JSON.stringify({ type: 'TurnInfo', transcript: 'after' }))
    if (deaf) (caller as unknown as { _socket: Socket })._socket.pause()
    caller.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) return void seen.text.push(String(data))
      const first = seen.sound === 0
      seen.sound += data.length
      if (!script)
        return caller.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: `heard ${seen.sound}` }))
      if (first) for (const message of script.slice(1)) caller.send(message)
    })
    caller.on('close', code => {
      seen.closed++
      seen.codes.push(code)
    })
  })
  const stop = () => {
    for (const caller of callers) caller.terminate()
    server.close()
  }
  onTestFinished(stop)
  const path = '/v1/account/gateway/workers-ai'
  const behind = `127.0.0.1:${(server.address() as AddressInfo).port}${path}`
  const moved = createServer()
  moved.on('upgrade', (_request, socket) =>
    socket.end(`HTTP/1.1 302 Found\r\nlocation: http://${behind}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`),
  )
  if (door) await new Promise<void>(listening => moved.listen(0, '127.0.0.1', listening))
  onTestFinished(() => void moved.close())
  return {
    seen,
    at: door ? `ws://127.0.0.1:${(moved.address() as AddressInfo).port}${path}` : `ws://${behind}`,
    hangUp: () => callers.forEach(caller => caller.close(1000)),
    stop,
  }
}

type Host = { at: string; up: Awaited<ReturnType<typeof gateway>> }

let worker = ''
beforeAll(async () => {
  const built = await build({
    entryPoints: [join(ROOT, 'example/worker.ts')],
    tsconfig: join(ROOT, 'tsconfig.json'),
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  worker = built.outputFiles[0].text
})

const HOSTS: Record<string, (setup: Setup) => Promise<Host>> = {
  async 'the Node server'({ live = true, calls = true, key = LIVE_KEY, models, ...rest }) {
    const up = await gateway(rest)
    const server = await serve({
      ...settings({
        ...(calls ? { EARSHOT_RELAY_KEY: DEVELOPER, EARSHOT_RELAY_UPSTREAM: 'http://127.0.0.1:9' } : {}),
        ...(live ? { EARSHOT_RELAY_LIVE_UPSTREAM: up.at, EARSHOT_RELAY_LIVE_KEY: key, EARSHOT_RELAY_SECRET: PHRASE } : {}),
        ...(models ? { EARSHOT_RELAY_LIVE_MODELS: models } : {}),
      }),
      port: 0,
      hostname: '127.0.0.1',
    })
    onTestFinished(() => void server.close())
    return { at: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, up }
  },
  async 'the Worker'({ live = true, calls = true, key = LIVE_KEY, models, ...rest }) {
    const up = await gateway(rest)
    const runtime = new Miniflare({
      modules: true,
      script: worker,
      compatibilityDate: '2026-07-01',
      bindings: {
        ...(calls ? { OPENROUTER_KEY: DEVELOPER, UPSTREAM: 'http://127.0.0.1:9' } : {}),
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

function call(at: string, protocols: string[] = []) {
  const line = new Caller(`${at.replace(/^http/, 'ws')}${LIVE_PATH}`, protocols)
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
    expect(answer.urls).toEqual([
      '/v1/account/gateway/workers-ai?model=%40cf%2Fdeepgram%2Fflux&encoding=linear16&sample_rate=16000&mip_opt_out=true',
    ])
  })

  it('both ask the upstream only for what the relay lists, never pass the secret on, and keep the sound out of training whatever the caller asks', async () => {
    const urls = await both({}, async ({ at, up }) => {
      const { got, say } = call(at)
      await say(greeting({ eot_timeout_ms: '3000', eot_threshold: 0.8, mip_opt_out: 'false', keyterm: 'x', tag: 'x' }))
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      return up.seen.urls
    })
    expect(urls).toEqual([
      '/v1/account/gateway/workers-ai?model=%40cf%2Fdeepgram%2Fflux&encoding=linear16&sample_rate=16000&eot_timeout_ms=3000&mip_opt_out=true',
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
      urls: ['/v1/account/gateway/workers-ai?model=b%2Ftwo&encoding=linear16&sample_rate=16000&mip_opt_out=true'],
    })
  })

  it('both choose no subprotocol, so a caller that asks for one is answered alike by the two', async () => {
    const answer = await both({}, async ({ at, up }) => {
      const { line, ended } = call(at, ['earshot-test'])
      const failed = new Promise<string>(told => line.once('error', error => told(error.message)))
      return { failed: await failed, code: await ended, chosen: line.protocol, reached: up.seen.asked }
    })
    expect(answer).toEqual({ failed: 'Server sent no subprotocol', code: 1006, chosen: '', reached: 0 })
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

  it('both stop reaching for an upstream when the caller leaves before it has answered', async () => {
    await both({ silent: true }, async ({ at, up }) => {
      const { line, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(up.seen.asked).toBe(1), WAIT)
      line.close(1000)
      await vi.waitFor(() => expect(up.seen.abandoned).toBe(1), WAIT)
    })
  })

  it('both follow the upstream nowhere else: a redirect gets no key and no caller', async () => {
    const answer = await both({ door: true }, async ({ at, up }) => {
      const { ended, say } = call(at)
      await say(greeting())
      return { code: await ended, behind: up.seen.asked }
    })
    expect(answer).toEqual({ code: CLOSES.upstream, behind: 0 })
  })

  it('both have live speech alone when the developer set no upstream for the calls', async () => {
    const answer = await both({ calls: false }, async ({ at }) => {
      const { got, say } = call(at)
      await say(greeting())
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      const response = await fetch(`${at}/api/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'mistralai/mistral-nemo' }),
      })
      return { call: response.status, body: await response.json() }
    })
    expect(answer).toEqual({ call: 404, body: { error: 'Not a call this relay forwards.' } })
  })

  it('both say so when the upstream refuses the key', async () => {
    const answer = await both({ key: 'not-the-key' }, async ({ at, up }) => {
      const { got, ended, say } = call(at)
      await say(greeting())
      return { code: await ended, got, refused: up.seen.refused, opened: up.seen.urls.length }
    })
    expect(answer).toEqual({ code: CLOSES.upstream, got: [], refused: 1, opened: 0 })
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

  it.each([
    { name: 'text after the greeting', first: () => greeting(), then: 'a'.repeat(MAX_FRAME + 1) },
    { name: 'text of few letters and many bytes', first: () => greeting(), then: '\u00e9'.repeat(MAX_FRAME / 2 + 1) },
    { name: 'a greeting', first: () => greeting({ pad: 'a'.repeat(MAX_FRAME) }), then: undefined },
  ])('both hang up the same way on $name over the size the relay takes', async ({ first, then }) => {
    const code = await both({}, async ({ at }) => {
      const { got, ended, say } = call(at)
      await say(first())
      if (then === undefined) return ended
      await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
      await say(then)
      return ended
    })
    expect(code).toBe(CLOSES.big)
  })

  it('both hang up on the caller at once when the upstream sends too much and then answers no goodbye', async () => {
    const code = await both({ long: 'sound', deaf: true }, async ({ at }) => {
      const { ended, say } = call(at)
      await say(greeting())
      return Promise.race([ended, new Promise<string>(late => setTimeout(() => late('still open after two seconds'), 2_000))])
    })
    expect(code).toBe(CLOSES.upstream)
  })

  it.each(['text', 'sound'] as const)(
    'both hang up on the caller when the upstream sends more %s in one message than the relay takes',
    async long => {
      const answer = await both({ long }, async ({ at }) => {
        const { got, ended, say } = call(at)
        await say(greeting())
        return { code: await ended, got }
      })
      expect(answer).toEqual({ code: CLOSES.upstream, got: ['{"type":"Connected"}'] })
    },
  )

  it('the Node server stops passing sound to an upstream that has stopped taking it, before it holds much of it', async () => {
    const up = await gateway({ deaf: true })
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const { line, got, ended, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
    const piece = new Uint8Array(MAX_FRAME)
    const pieces = (MAX_QUEUED / MAX_FRAME) * 40
    for (let sent = 0; sent < pieces && line.readyState === Caller.OPEN; sent++) {
      line.send(piece)
      if (sent % 16 === 15) await new Promise(soon => setTimeout(soon, 5))
    }
    expect(await ended).toBe(CLOSES.stalled)
  })

  it('the Node server, when it is closed, tells its callers it is going and lets go of their upstreams at once', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    const { got, ended, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
    const closed = new Promise<void>(done => server.close(() => done()))
    expect(await ended).toBe(CLOSES.going)
    await vi.waitFor(() => expect(up.seen.closed).toBe(1), WAIT)
    await closed
  })

  it('the Node server, when it is closed, drops an open upstream outright, with no goodbye queued behind its sound', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    const { got, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
    server.close()
    await vi.waitFor(() => expect(up.seen.codes).toEqual([1006]), { timeout: 2_000, interval: 10 })
  })

  it('the Node server takes live callers again after it was closed and set listening again', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>(closed => server.close(() => closed()))
    await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening))
    onTestFinished(() => void server.close())
    const { got, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
  })

  it('the Node server with no live speech leaves a WebSocket on that very path to the app', async () => {
    const server = await serve({ key: DEVELOPER, upstream: 'http://127.0.0.1:9', port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const own = new WebSocketServer({ noServer: true })
    server.on('upgrade', (incoming, socket, head) => own.handleUpgrade(incoming, socket, head, line => line.send('the app has it')))
    const mine = new Caller(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${LIVE_PATH}`)
    onTestFinished(() => mine.terminate())
    const said = await new Promise<string>(heard => mine.on('message', data => heard(String(data))))
    expect(said).toBe('the app has it')
    expect(mine.readyState).toBe(Caller.OPEN)
  })

  it('the Node server, when it is closed, lets go of an upstream whose caller does not answer the goodbye', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    const { line, got, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
    ;(line as unknown as { _socket: Socket })._socket.pause()
    server.close()
    await vi.waitFor(() => expect(up.seen.closed).toBe(1), { timeout: 2_000, interval: 10 })
  })

  it('the Node server, when it is closed, stops reaching for an upstream that has not answered yet', async () => {
    const up = await gateway({ silent: true })
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    const { say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(up.seen.asked).toBe(1), WAIT)
    server.close()
    await vi.waitFor(() => expect(up.seen.abandoned).toBe(1), { timeout: 2_000, interval: 10 })
  })

  it('the Node server outlives an upgrade it cannot even read as a request, and goes on serving', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const { port } = server.address() as AddressInfo
    const ended = await new Promise<boolean>(done => {
      const raw = connect(port, '127.0.0.1', () =>
        raw.write(`TRACE ${LIVE_PATH} HTTP/1.1\r\nhost: relay\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`),
      )
      raw.on('close', () => done(true))
      raw.on('error', () => done(true))
      raw.resume()
    })
    expect(ended).toBe(true)
    const { got, say } = call(`http://127.0.0.1:${port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
  })

  it('the Node server lets go of a socket whose upgrade it refused, also when the caller keeps its side open', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const { port } = server.address() as AddressInfo
    const answer = await new Promise<string>(heard => {
      const raw = connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () =>
        raw.write('GET /elsewhere HTTP/1.1\r\nhost: relay\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n'),
      )
      onTestFinished(() => void raw.destroy())
      raw.on('error', () => {})
      raw.once('data', data => heard(String(data).split('\r\n')[0]))
    })
    expect(answer).toBe('HTTP/1.1 404 Not Found')
    const connections = () => new Promise<number>(count => server.getConnections((_error, open) => count(open)))
    await vi.waitFor(async () => expect(await connections()).toBe(0), { timeout: 2_000, interval: 20 })
  })

  it('the Node server outlives a socket that fails while its upgrade is being refused, and goes on serving', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const failing = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done(new Error('the caller reset the connection'))
      },
    })
    server.emit('upgrade', { url: '/elsewhere', method: 'GET', headers: { host: 'relay', upgrade: 'websocket' } }, failing, Buffer.alloc(0))
    await vi.waitFor(() => expect(failing.destroyed).toBe(true), WAIT)
    const { got, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
  })

  it("the Node server leaves a WebSocket on a path of the app's own to the app", async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const own = new WebSocketServer({ noServer: true })
    server.on('upgrade', (incoming, socket, head) => {
      if (incoming.url === '/sync') own.handleUpgrade(incoming, socket, head, line => line.send('the app has it'))
    })
    const at = `127.0.0.1:${(server.address() as AddressInfo).port}`
    const mine = new Caller(`ws://${at}/sync`)
    onTestFinished(() => mine.terminate())
    const said = await new Promise<string>(heard => mine.on('message', data => heard(String(data))))
    expect(said).toBe('the app has it')
    const { got, say } = call(`http://${at}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
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

  it('both hang up on a caller who sends more sound in one piece than the relay takes, and go on serving', async () => {
    const answer = await both({}, async ({ at, up }) => {
      const big = call(at)
      await big.say(greeting())
      await vi.waitFor(() => expect(big.got).toHaveLength(1), WAIT)
      await big.say(new Uint8Array(MAX_FRAME + 1))
      const code = await big.ended
      const next = call(at)
      await next.say(greeting())
      await vi.waitFor(() => expect(next.got).toHaveLength(1), WAIT)
      await next.say(new Uint8Array(MAX_FRAME))
      await vi.waitFor(() => expect(up.seen.sound).toBe(MAX_FRAME), WAIT)
      return { code, sound: up.seen.sound }
    })
    expect(answer).toEqual({ code: CLOSES.big, sound: MAX_FRAME })
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

  it("both take a long piece of sound from the app's own transport, which sends it a second at a time", async () => {
    const sound = await both({}, async ({ at, up }) => {
      const life = new Lifetime()
      onTestFinished(() => life.end())
      const told: LiveState[] = []
      const hear = fluxLive({ host: at, secret: PHRASE }).start(
        life,
        () => {},
        state => told.push(state),
      )
      hear({ pcm: new Uint8Array(96_000), speaker: 'other', gap: false })
      await vi.waitFor(() => expect(up.seen.sound).toBe(96_000), WAIT)
      return { sound: up.seen.sound, told }
    })
    expect(sound).toEqual({ sound: 96_000, told: [] })
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
  const calls = { key: DEVELOPER, upstream: 'https://upstream.example' }
  const live = { upstream: 'wss://speech.example/v1', key: LIVE_KEY, secret: PHRASE }

  it('the app and the relay agree on the path and on what is refused for good', () => {
    expect(APP_PATH).toBe(LIVE_PATH)
    expect(REFUSALS).toEqual({ hello: CLOSES.hello, secret: CLOSES.secret, model: CLOSES.model })
    expect(Object.values(REFUSALS)).not.toContain(CLOSES.upstream)
  })

  it('a host with no live upstream asks for no live speech, whatever else is set, and its secret is then for its calls', () => {
    const settings = {
      ...calls,
      models: undefined,
      liveUpstream: undefined,
      liveKey: LIVE_KEY,
      liveModels: 'a/one',
      secret: PHRASE,
      calls: undefined,
    }
    expect(relayOptions(settings)).toEqual({ ...calls, secret: PHRASE })
  })

  it('a host with a live upstream passes on what it has, with the models the developer listed', () => {
    const settings = {
      key: undefined,
      upstream: undefined,
      models: undefined,
      liveUpstream: live.upstream,
      liveKey: undefined,
      secret: undefined,
      calls: undefined,
    }
    expect(relayOptions({ ...settings, liveModels: ' a/one ,b/two' })).toEqual({
      live: { upstream: live.upstream, key: '', secret: '', models: ['a/one', 'b/two'] },
    })
  })

  it.each([undefined, '', 'a'.repeat(MIN_SECRET - 1), 0])(
    'no relay is made with the live secret %j, by any way in: anyone could run up the bill',
    secret => {
      expect(() => relay({ ...calls, live: { ...live, secret: secret as string } })).toThrow('needs a secret')
      expect(() =>
        relay(
          relayOptions({
            ...calls,
            models: undefined,
            liveUpstream: live.upstream,
            liveKey: LIVE_KEY,
            liveModels: undefined,
            secret: secret as string,
            calls: undefined,
          }),
        ),
      ).toThrow('needs a secret')
      expect(() => serve({ ...calls, live: { ...live, secret: secret as string }, port: 0 })).toThrow('needs a secret')
    },
  )

  it('no relay is made with a secret too long to fit in a greeting: no caller could ever say it', () => {
    expect(() => relay({ ...calls, live: { ...live, secret: 'a'.repeat(MAX_SECRET + 1) } })).toThrow('needs a secret')
    expect(() => relay({ ...calls, live: { ...live, secret: 'a'.repeat(MAX_SECRET) } })).not.toThrow()
  })

  it('counts a secret as long as a greeting must write it, so one of signs that take six letters each is refused too', () => {
    expect(() => relay({ ...calls, live: { ...live, secret: '\u0001'.repeat(MAX_SECRET / 6 + 1) } })).toThrow('needs a secret')
  })

  it('reaches the live upstream at the address that was checked, not at the text that was typed', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: `${up.at} `, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const { got, say } = call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    await say(greeting())
    await vi.waitFor(() => expect(got).toHaveLength(1), WAIT)
    expect(up.seen.urls[0]).toMatch(/^\/v1\/account\/gateway\/workers-ai\?model=/)
  })

  it('the Node server lets go of a caller who neither greets nor answers its goodbye, a second after the goodbye', async () => {
    const up = await gateway()
    const server = await serve({ live: { upstream: up.at, key: LIVE_KEY, secret: PHRASE }, port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const { port } = server.address() as AddressInfo
    const silent = connect(port, '127.0.0.1', () =>
      silent.write(
        `GET ${LIVE_PATH} HTTP/1.1\r\nhost: relay\r\nconnection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    )
    onTestFinished(() => void silent.destroy())
    silent.on('error', () => {})
    const connections = () => new Promise<number>(count => server.getConnections((_error, open) => count(open)))
    await vi.waitFor(async () => expect(await connections()).toBe(1), WAIT)
    await vi.waitFor(async () => expect(await connections()).toBe(0), { timeout: HELLO_MS + GOODBYE_MS + 1_500, interval: 50 })
  }, 15_000)

  it('no relay is made with a live upstream and no key for it', () => {
    expect(() => relay({ ...calls, live: { ...live, key: '' } })).toThrow('needs the key')
  })

  it.each([
    'ws://speech.example/v1',
    'https://speech.example/v1',
    'speech.example',
    '',
    'ws+unix://localhost/v1',
    'http://localhost:9/v1',
    'wss:speech.example',
  ])('no relay is made with the live upstream %j: the key and the sound would be readable, or go nowhere', upstream => {
    expect(() => relay({ ...calls, live: { ...live, upstream } })).toThrow(/wss|address/)
  })

  it('no relay is made with a live upstream that carries a query of its own', () => {
    expect(() => relay({ ...calls, live: { ...live, upstream: `${live.upstream}?model=x` } })).toThrow('no query')
  })

  it('a relay is made with a plain upstream on this machine, for a test or a tunnel', () => {
    expect(() =>
      relay({ key: DEVELOPER, upstream: 'http://127.0.0.1:9', live: { ...live, upstream: 'ws://localhost:9/v1' } }),
    ).not.toThrow()
  })

  it("no relay is made with a plain upstream for its calls: the developer's key would be readable", () => {
    expect(() => relay({ key: DEVELOPER, upstream: 'http://upstream.example' })).toThrow('https')
  })
})
