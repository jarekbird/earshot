import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import './vitest.setup.js'

export const outsideCalls: string[] = []

const proxy = createServer((request, response) => {
  outsideCalls.push(`${request.method} ${request.url}`)
  response.writeHead(403).end()
})
proxy.on('connect', (request, socket) => {
  socket.on('error', () => {})
  outsideCalls.push(`CONNECT ${request.url}`)
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
})

beforeAll(async () => {
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done))
  const at = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy']) process.env[name] = process.env[name.toUpperCase()] = at
  process.env.no_proxy = process.env.NO_PROXY = '127.0.0.1,localhost'
})

afterEach(() => {
  expect(outsideCalls.splice(0), 'E4: the page in the simulator called an outside service').toEqual([])
})

afterAll(() => void proxy.close())
