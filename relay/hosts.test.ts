import { readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { Miniflare } from '../workerd/runtime.js'
import { serve, settings } from './node.js'

const KEY = 'sk-developer'
const BUSY = 'typesafe/jev-1.14'

const ROOT = join(import.meta.dirname, '..')
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

const closing: (() => unknown)[] = []
afterAll(async () => void (await Promise.all(closing.splice(0).map(close => close()))))

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
  closing.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

type Host = (path: string, init: RequestInit, asksFirst?: boolean) => Promise<Response>

// Fact: a runtime with no proxy before it gives up on an upload it was not going to read, and the caller may see that before the answer.
const askingFirst = (address: string, init: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(String(init.body))
    const call = request(address, {
      method: init.method,
      headers: { ...(init.headers as Record<string, string>), 'content-length': body.length, expect: '100-continue' },
    })
    call.on('continue', () => call.end(body))
    call.on('error', reject)
    call.on('response', answer => {
      const parts: Buffer[] = []
      answer.on('data', part => parts.push(part))
      answer.on('end', () => {
        call.destroy()
        const headers = Object.entries(answer.headers).flatMap(([name, value]) =>
          typeof value === 'string' ? [[name, value] as [string, string]] : [],
        )
        resolve(new Response(Buffer.concat(parts), { status: answer.statusCode, headers }))
      })
    })
    call.flushHeaders()
  })

async function inWorkerd(to: string, models?: string): Promise<string> {
  const runtime = new Miniflare({
    modules: true,
    script: worker,
    compatibilityDate: '2026-07-01',
    bindings: { OPENROUTER_KEY: KEY, UPSTREAM: to, ...(models ? { MODELS: models } : {}) },
  })
  closing.push(() => runtime.dispose())
  return (await runtime.ready).href.replace(/\/$/, '')
}

async function start(to: string, models?: string): Promise<Record<string, Host>> {
  const server = await serve({
    ...settings({ EARSHOT_RELAY_KEY: KEY, EARSHOT_RELAY_UPSTREAM: to, ...(models ? { EARSHOT_RELAY_MODELS: models } : {}) }),
    port: 0,
    hostname: '127.0.0.1',
  })
  closing.push(() => server.close())
  const node = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const edge = await inWorkerd(to, models)
  return {
    'the Node server': (path, init, asks) => (asks ? askingFirst : fetch)(`${node}${path}`, init),
    "the Worker, in Cloudflare's own runtime": (path, init, asks) => (asks ? askingFirst : fetch)(`${edge}${path}`, init),
  }
}

const started = new Map<string, Promise<Record<string, Host>>>()
const hosts = (models = ''): Promise<Record<string, Host>> => {
  if (!started.has(models))
    started.set(
      models,
      upstream().then(to => start(to, models || undefined)),
    )
  return started.get(models)!
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

const CALLS: { name: string; models?: string; path: string; init: RequestInit; status: number; asksFirst?: boolean }[] = [
  { name: 'forward a call with the key', path: SPEECH, init: post({ model: WHISPER, input_audio: 'UklGR', stream: true }), status: 200 },
  { name: "answer a browser's first check", path: '/api/alpha/decisions', init: { method: 'OPTIONS' }, status: 204 },
  { name: 'refuse a path Earshot never calls', path: '/api/v1/keys', init: post({ model: WHISPER }), status: 404 },
  { name: 'refuse another method', path: SPEECH, init: { method: 'GET' }, status: 405 },
  { name: 'refuse a body that is not a JSON object', path: SPEECH, init: post('[1]'), status: 400 },
  {
    name: 'refuse a body over the limit, before a caller that asks first has sent it',
    path: SPEECH,
    init: post({ model: WHISPER, input_audio: 'a'.repeat(4_000_001) }),
    status: 413,
    asksFirst: true,
  },
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
    const init = post({ model: WHISPER, input_audio: 'UklGR' })
    const answers = await Promise.all(Object.values(await start(to)).map(async host => seen(await host(SPEECH, init))))
    expect(answers.map(answer => answer.status)).toEqual([502, 502])
    expect(heard).toEqual([])
  })
})

describe('E13: the Node server and the Worker are one relay', () => {
  it.each(CALLS)('both $name', async ({ models, path, init, status, asksFirst }) => {
    const answers = await Promise.all(Object.values(await hosts(models)).map(async host => seen(await host(path, init, asksFirst))))
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
