import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { Simulator } from './simulator.js'

describe('the example app in the real Even Hub simulator', () => {
  let server: Server
  let url: string
  beforeAll(async () => {
    const bundle = await build({ entryPoints: ['example/main.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent' })
    const script = bundle.outputFiles[0].text
    const page = readFileSync('example/index.html')
    server = createServer((request, response) => {
      const wanted = request.url === '/main.js'
      response.setHeader('content-type', wanted ? 'text/javascript' : 'text/html')
      response.end(wanted ? script : page)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/#trace`
  })
  afterAll(() => void server.close())

  const start = async () => {
    const sim = await Simulator.start({ url, limitSeconds: 300 })
    onTestFinished(() => sim.stop())
    await sim.shows('Earshot example', 60_000)
    return sim
  }
  const picture = async (sim: Simulator) => Buffer.from(await sim.screenshot('glasses')).toString('base64')

  it('draws its boxes, and changes text in place on a tap', async () => {
    const sim = await start()
    expect(sim.shown()).toEqual(['Earshot example', 'Taps: 0'])
    await sim.input('tap')
    expect(await sim.shows('Taps: 1')).toEqual(['Earshot example', 'Taps: 1'])
    await sim.input('tap')
    await sim.shows('Taps: 2')
  })

  it('rebuilds the page when a box moves', async () => {
    const sim = await start()
    const before = await picture(sim)
    await sim.input('down')
    await sim.until('the line to move', async () => (await picture(sim)) !== before)
    expect(sim.shown()).toEqual(['Earshot example', 'Taps: 0'])
    await sim.input('tap')
    await sim.shows('Taps: 1')
  })
})
