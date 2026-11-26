import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { LIST_ROW_WIDTH, textWidth } from '../src/index.js'
import { serve } from '../relay/node.js'
import { Simulator } from './simulator.js'

const RECORDED = readFileSync('src/flux/recorded.jsonl', 'utf8').trim().split('\n')
const LIVE_KEY = 'live-developer'
const PHRASE = 'what only this phone was told'

describe('the example app in the real Even Hub simulator', () => {
  let server: Server
  let relay: Server
  let flux: WebSocketServer
  let url: string
  const forwarded: string[] = []
  beforeAll(async () => {
    flux = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: ({ req }: { req: { headers: Record<string, unknown> } }) =>
        req.headers['cf-aig-authorization'] === `Bearer ${LIVE_KEY}`,
    })
    await new Promise<void>(listening => flux.once('listening', listening))
    flux.on('connection', caller => {
      caller.send(RECORDED[0])
      caller.once('message', () => RECORDED.slice(1).forEach(message => caller.send(message)))
    })
    relay = await serve({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      live: {
        upstream: `ws://127.0.0.1:${(flux.address() as AddressInfo).port}/v1/account/gateway/workers-ai`,
        key: LIVE_KEY,
        secret: PHRASE,
      },
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (address, init) => {
        const { pathname } = new URL(String(address))
        forwarded.push(pathname)
        if (pathname.endsWith('/transcriptions')) return Response.json({ text: 'open voice' })
        const criteria: Record<string, string> = JSON.parse(String(init?.body)).questions.pick.criteria
        const wanted = Object.keys(criteria).find(id => criteria[id].startsWith('Open note: Voice')) ?? 'none'
        return Response.json({ answers: { pick: { type: 'choice', choice: wanted, probabilities: { [wanted]: 0.95 } } } })
      },
    })
    const bundle = await build({
      entryPoints: ['example/main.ts'],
      tsconfig: 'tsconfig.json',
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
      define: { EARSHOT_RELAY: JSON.stringify(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`), EARSHOT_TRACE: 'true' },
    })
    const script = bundle.outputFiles[0].text
    const page = readFileSync('example/index.html', 'utf8')
    const typed = (secret: string) => page.replace('id="secret"', `id="secret" value="${secret}"`)
    const pages: Record<string, string> = { [TYPED]: typed(PHRASE), [MISTYPED]: typed(`${PHRASE}, nearly`) }
    server = createServer((request, response) => {
      const wanted = request.url === '/main.js'
      response.setHeader('content-type', wanted ? 'text/javascript' : 'text/html')
      response.end(wanted ? script : (pages[request.url ?? ''] ?? page))
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.close()
    relay.closeAllConnections()
    relay.close()
    for (const caller of flux.clients) caller.terminate()
    flux.close()
  })

  const TYPED = '/with-the-secret-typed'
  const MISTYPED = '/with-the-secret-mistyped'
  const start = async (more = '', mic = false, path = '/') => {
    const sim = await Simulator.start({ url: `${url}${path}#${more}`, limitSeconds: 300, mic })
    onTestFinished(() => sim.stop())
    await sim.shows('Earshot example', 60_000)
    return sim
  }

  it('draws a list, moves the cursor, opens an item and comes back to it', async () => {
    const sim = await start()
    expect(sim.shown()).toEqual(['Earshot example', '> Welcome', 'Voice', 'A long note'])
    expect(sim.menu()).toEqual(['Delete note', 'Tap counter', 'Listen', 'Send', 'Go back', 'Go home'])
    await sim.input('down')
    await sim.shows('> Voice')
    await sim.input('tap')
    await sim.shows('Hold the touchpad and say')
    await sim.input('double')
    expect(await sim.shows('> Voice')).toEqual(['Earshot example', 'Welcome', '> Voice', 'A long note'])
  })

  it("runs actions from Even's menu: says why one cannot run, and asks before one that needs it", async () => {
    const sim = await start()
    await sim.pick('Send')
    await sim.shows('Nothing to send')
    await sim.pick('Delete note')
    expect(await sim.shows('Delete note')).toEqual(['Delete note', '> Welcome', 'Voice', 'A long note'])
    await sim.input('tap')
    await sim.shows('Tap to confirm')
    await sim.input('tap')
    expect(await sim.shows('> Voice')).toEqual(['Earshot example', '> Voice', 'A long note'])
  })

  it('scrolls a long text, and hands taps to a screen of boxes', async () => {
    const sim = await start()
    await sim.input('down')
    await sim.input('down')
    await sim.shows('> A long note')
    await sim.input('tap')
    await sim.shows('Line 9 of a long note.')
    await sim.input('down')
    await sim.shows('Line 11 of a long note.')
    await sim.input('double')
    await sim.shows('Earshot example')
    await sim.pick('Tap counter')
    await sim.shows('Taps: 0')
    await sim.input('tap')
    await sim.shows('Taps: 1')
  })

  it.runIf(process.platform === 'linux')("hears a hold: runs what the words ask for, and hands the rest to the app's agent", async () => {
    const sim = await start('&say=open%20voice|remember%20buy%20milk', true)
    await sim.hold(1_200)
    await sim.shows('Hold the touchpad and say')
    await sim.input('double')
    await sim.shows('Earshot example')
    await sim.hold(1_200)
    const lines = await sim.shows('Saved')
    expect(lines.slice(0, 5)).toEqual(['Earshot example', '> Welcome', 'Voice', 'A long note', 'buy milk'])
    expect(lines.slice(5).map(line => line.replace(/[╭╮╰╯─│]/g, '').trim())).toEqual(['', 'Saved', ''])
  })

  it.runIf(process.platform === 'linux')('names a long note that was said by the words that fit a row of the list', async () => {
    const words = 'the quarterly numbers for every region before the board meets on the first Thursday of next month'.split(' ')
    const sim = await start(`&say=${encodeURIComponent(`remember ${words.join(' ')}`)}`, true)
    await sim.hold(1_200)
    const row = (await sim.shows('Saved'))[4]
    const shown = row.split(' ')
    expect(shown).toEqual(words.slice(0, shown.length))
    expect(textWidth(row)).toBeLessThanOrEqual(LIST_ROW_WIDTH)
    expect(textWidth(words.slice(0, shown.length + 1).join(' '))).toBeGreaterThan(LIST_ROW_WIDTH)
  })

  it.runIf(process.platform === 'linux')("turns the navigator's choice down at a swipe: the words go to the app's agent", async () => {
    const sim = await start('&say=remember%20to%20delete%20welcome', true)
    await sim.hold(1_200)
    await sim.shows('Swipe: Keep as a note')
    await sim.input('down')
    const lines = await sim.shows('Saved')
    expect(lines.slice(0, 5)).toEqual(['Earshot example', '> Welcome', 'Voice', 'A long note', 'to delete welcome'])
  })

  it.runIf(process.platform === 'linux')('listens for as long as a screen is open, and still takes a hold meanwhile', async () => {
    const sim = await start('&say=go%20back', true)
    await sim.pick('Listen')
    await sim.shows('Listening')
    const heardSome = () => (sim.shown().some(line => /: [1-9]\d* s$/.test(line)) ? true : undefined)
    await sim.until('a second of sound to be counted', heardSome, 30_000)
    await sim.hold(1_200)
    await sim.shows('Earshot example')
  })

  it.runIf(process.platform === 'linux')('shows live speech turn by turn while a screen listens', async () => {
    const sim = await start('&live=hello%20there|how%20are%20you', true)
    await sim.pick('Listen')
    await sim.shows('Listening')
    await sim.logged(/Someone: hello \.\.\./, 30_000)
    await sim.shows('Someone: how are you', 30_000)
    await sim.until(
      'both turns to be shown as finished',
      () => (sim.shown().some(line => line.endsWith('how are you')) ? true : undefined),
      30_000,
    )
    expect(sim.shown().filter(line => line.startsWith('Someone:'))).toEqual(['Someone: hello there', 'Someone: how are you'])
  })

  it.runIf(process.platform === 'linux')("says that words are off when the secret typed on the phone is not the relay's", async () => {
    const sim = await start('', true, MISTYPED)
    await sim.pick('Listen')
    await sim.shows('Listening')
    await sim.shows('Words are off', 30_000)
  })

  it.runIf(process.platform === 'linux')('keeps the newest words on the glasses when what was said no longer fits', async () => {
    const long = Array.from({ length: 22 }, (_, at) => `word${at}`).join('%20')
    const sim = await start(`&live=${long}|${long}|${long}|and%20the%20last`, true)
    await sim.pick('Listen')
    await sim.shows('Listening')
    await sim.shows('Someone: and the last', 60_000)
  })

  it.runIf(process.platform === 'linux')('marks a turn that a hold cut off', async () => {
    const words = Array.from({ length: 80 }, (_, at) => `w${at}`).join('%20')
    const sim = await start(`&say=zzz%20qqq&live=${words}`, true)
    await sim.pick('Listen')
    await sim.shows('Listening')
    await sim.shows('Someone: w0', 30_000)
    await sim.hold(1_200)
    await sim.shows('(cut)', 30_000)
  })

  it.runIf(process.platform === 'linux')(
    "shows what Flux says through the developer's relay, once the secret is typed on the phone",
    async () => {
      const sim = await start('', true, TYPED)
      await sim.pick('Listen')
      await sim.shows('Listening')
      await sim.shows('Someone: Good morning.', 30_000)
    },
  )

  it.runIf(process.platform === 'linux')("sends a hold through the developer's relay: speech to words, then Jev's pick", async () => {
    const sim = await start('', true)
    forwarded.length = 0
    await sim.hold(1_200)
    await sim.shows('Hold the touchpad and say')
    expect(forwarded).toEqual(['/api/v1/audio/transcriptions', '/api/alpha/decisions'])
  })
})

describe('the example app while its relay cannot reach the speech service', () => {
  const STALE_BYTES = 3 * 32_000
  const HELD_BYTES = 10 * 32_000

  async function site(gate: { down: boolean; firsts: number[] }) {
    const flux = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: ({ req }: { req: { headers: Record<string, unknown> } }) =>
        !gate.down && req.headers['cf-aig-authorization'] === `Bearer ${LIVE_KEY}`,
    })
    await new Promise<void>(listening => flux.once('listening', listening))
    flux.on('connection', caller => {
      let heard = 0
      caller.send(RECORDED[0])
      caller.on('message', (data: Buffer) => {
        if (heard === 0) RECORDED.slice(1).forEach(message => caller.send(message))
        heard += data.length
      })
      setTimeout(() => gate.firsts.push(heard), 300)
    })
    const relay = await serve({
      live: {
        upstream: `ws://127.0.0.1:${(flux.address() as AddressInfo).port}/v1/account/gateway/workers-ai`,
        key: LIVE_KEY,
        secret: PHRASE,
      },
      port: 0,
      hostname: '127.0.0.1',
    })
    const bundle = await build({
      entryPoints: ['example/main.ts'],
      tsconfig: 'tsconfig.json',
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
      define: { EARSHOT_RELAY: JSON.stringify(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`), EARSHOT_TRACE: 'true' },
    })
    const page = readFileSync('example/index.html', 'utf8').replace('id="secret"', `id="secret" value="${PHRASE}"`)
    const server = createServer((request, response) => {
      const wanted = request.url === '/main.js'
      response.setHeader('content-type', wanted ? 'text/javascript' : 'text/html')
      response.end(wanted ? bundle.outputFiles[0].text : page)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    onTestFinished(() => {
      server.close()
      relay.close()
      for (const caller of flux.clients) caller.terminate()
      flux.close()
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/#`
  }

  it.runIf(process.platform === 'linux')(
    'says no words are coming, takes them up again when it can, and sends only the last seconds it held',
    async () => {
      const gate = { down: true, firsts: [] as number[] }
      const sim = await Simulator.start({ url: await site(gate), limitSeconds: 300, mic: true })
      onTestFinished(() => sim.stop())
      await sim.shows('Earshot example', 60_000)
      await sim.pick('Listen')
      await sim.shows('Listening')
      await sim.shows('No words for now', 30_000)
      await new Promise(longer => setTimeout(longer, 12_000))
      gate.down = false
      await sim.shows('Someone: Good morning.', 40_000)
      expect(sim.shown().join(' ')).not.toContain('No words for now')
      await vi.waitFor(() => expect(gate.firsts).toHaveLength(1), { timeout: 5_000 })
      expect(gate.firsts[0]).toBeGreaterThan(0)
      expect(gate.firsts[0]).toBeLessThan((STALE_BYTES + HELD_BYTES) / 2)
    },
    120_000,
  )
})
