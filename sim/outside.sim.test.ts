import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'
import { outsideCalls } from '../vitest.sim.setup.js'
import { Simulator } from './simulator.js'

it('E4: a call from the page in the simulator to an outside service is refused, and fails its test', async () => {
  const calls = `fetch('http://service.example.invalid/plain').catch(() => {});fetch('https://service.example.invalid/secure').catch(() => {})`
  const page = createServer((_request, response) => response.setHeader('content-type', 'text/html').end(`<script>${calls}</script>`))
  await new Promise<void>(done => page.listen(0, '127.0.0.1', done))
  onTestFinished(() => void page.close())
  const sim = await Simulator.start({ url: `http://127.0.0.1:${(page.address() as AddressInfo).port}/`, limitSeconds: 120 })
  onTestFinished(() => sim.stop())
  await expect.poll(() => outsideCalls.length, { timeout: 30_000 }).toBe(2)
  expect(outsideCalls.splice(0).sort()).toEqual(['CONNECT service.example.invalid:443', 'GET http://service.example.invalid/plain'])
})
