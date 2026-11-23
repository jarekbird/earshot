import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import worker from '../example/worker.js'
import { serve, settings } from './node.js'

const KEY = 'sk-developer'
const BUSY = 'typesafe/jev-1.14'

async function upstream(): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    const parts: Buffer[] = []
    incoming.on('data', part => parts.push(part))
    incoming.on('end', () => {
      const body = Buffer.concat(parts).toString()
      const busy = body.includes(BUSY)
      outgoing.writeHead(busy ? 429 : 200, { 'content-type': 'application/json', 'x-upstream': 'secret' })
      outgoing.end(JSON.stringify({ path: incoming.url, key: incoming.headers.authorization, body }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => void server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

type Host = (path: string, init: RequestInit) => Promise<Response>

async function hosts(models?: string): Promise<Record<string, Host>> {
  const to = await upstream()
  const server = await serve({
    ...settings({ EARSHOT_RELAY_KEY: KEY, EARSHOT_RELAY_UPSTREAM: to, ...(models ? { EARSHOT_RELAY_MODELS: models } : {}) }),
    port: 0,
    hostname: '127.0.0.1',
  })
  onTestFinished(() => void server.close())
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const env = { OPENROUTER_KEY: KEY, UPSTREAM: to, ...(models ? { MODELS: models } : {}) }
  return {
    'the Node server': (path, init) => fetch(`${at}${path}`, init),
    'the Worker': (path, init) => worker.fetch(new Request(`https://relay.example${path}`, init), env),
  }
}

const SEEN = ['content-type', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'x-upstream']

async function seen(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(SEEN.map(name => [name, response.headers.get(name)])),
    body: await response.text(),
  }
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const SPEECH = '/api/v1/audio/transcriptions'
const WHISPER = 'openai/whisper-large-v3-turbo'

const CALLS: { name: string; models?: string; path: string; init: RequestInit; status: number }[] = [
  { name: 'forward a call with the key', path: SPEECH, init: post({ model: WHISPER, input_audio: 'UklGR', stream: true }), status: 200 },
  { name: "answer a browser's first check", path: '/api/alpha/decisions', init: { method: 'OPTIONS' }, status: 204 },
  { name: 'refuse a path Earshot never calls', path: '/api/v1/keys', init: post({ model: WHISPER }), status: 404 },
  { name: 'refuse another method', path: SPEECH, init: { method: 'GET' }, status: 405 },
  { name: 'refuse a body that is not a JSON object', path: SPEECH, init: post('[1]'), status: 400 },
  { name: 'refuse a body over the limit', path: SPEECH, init: post({ model: WHISPER, input_audio: 'a'.repeat(4_000_001) }), status: 413 },
  { name: 'refuse a model nobody listed', path: SPEECH, init: post({ model: 'other/model' }), status: 400 },
  { name: "pass the upstream's refusal on as it is", path: '/api/alpha/decisions', init: post({ model: BUSY, state: {} }), status: 429 },
  { name: 'forward a model the developer listed', models: 'a/one, b/two', path: SPEECH, init: post({ model: 'b/two' }), status: 200 },
  {
    name: "refuse Earshot's own model once the developer lists others",
    models: 'a/one',
    path: SPEECH,
    init: post({ model: WHISPER }),
    status: 400,
  },
]

describe('E13: the Node server and the Worker follow the upstream of a call nowhere else', () => {
  it('both answer that the upstream could not be reached, and the other address hears nothing', async () => {
    const heard: string[] = []
    const elsewhere = createServer((incoming, outgoing) => {
      heard.push(`${incoming.method} ${incoming.headers.authorization}`)
      outgoing.end('{}')
    })
    await new Promise<void>(resolve => elsewhere.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => void elsewhere.close())
    const moved = createServer((_incoming, outgoing) => {
      outgoing
        .writeHead(307, { location: `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/api/v1/audio/transcriptions` })
        .end()
    })
    await new Promise<void>(resolve => moved.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => void moved.close())
    const to = `http://127.0.0.1:${(moved.address() as AddressInfo).port}`
    const server = await serve({ ...settings({ EARSHOT_RELAY_KEY: KEY, EARSHOT_RELAY_UPSTREAM: to }), port: 0, hostname: '127.0.0.1' })
    onTestFinished(() => void server.close())
    const init = post({ model: WHISPER, input_audio: 'UklGR' })
    const answers = [
      await seen(await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${SPEECH}`, init)),
      await seen(await worker.fetch(new Request(`https://relay.example${SPEECH}`, init), { OPENROUTER_KEY: KEY, UPSTREAM: to })),
    ]
    expect(answers.map(answer => answer.status)).toEqual([502, 502])
    expect(heard).toEqual([])
  })
})

describe('E13: the Node server and the Worker are one relay', () => {
  it.each(CALLS)('both $name', async ({ models, path, init, status }) => {
    const answers = await Promise.all(Object.values(await hosts(models)).map(async host => seen(await host(path, init))))
    for (const answer of answers) expect(answer.status).toBe(status)
    expect(answers[1]).toEqual(answers[0])
  })

  it('read their settings through one function, whose type names every setting a host must pass', () => {
    for (const file of ['example/worker.ts', 'relay/node.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
      expect(text, file).toMatch(/\brelayOptions\(\{/)
      expect(text.match(/\brelay\(/g)?.length, file).toBe(1)
    }
  })
})
