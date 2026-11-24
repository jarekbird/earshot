import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { openRouter, MODELS } from '../src/openrouter/openrouter.js'
import { CLOSES, DEFAULT_MODELS, DIAL_MS, LIVE_PATH, relay, type Line, type Sockets } from './relay.js'

interface Sent {
  url: string
  key: string | null
  body: Record<string, unknown>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-upstream-secret': 'hidden' } })

function setup(answers: (Response | Error)[] = [], more: { models?: string[]; maxBytes?: number } = {}) {
  const sent: Sent[] = []
  const handle = relay({
    key: 'sk-developer',
    upstream: 'https://upstream.example/',
    ...more,
    fetch: async (url, init) => {
      sent.push({ url: String(url), key: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      const answer = answers.shift() ?? json({})
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`https://relay.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )
  return { sent, handle, post }
}

const speech = { model: 'openai/whisper-large-v3-turbo', input_audio: { data: 'UklGRg==', format: 'wav' } }

describe('a call from the app', () => {
  it("goes to the upstream with the developer's key, and its answer comes back", async () => {
    const { sent, post } = setup([json({ text: 'open voice' })])
    const answer = await post('/api/v1/audio/transcriptions', { ...speech, language: 'en' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ text: 'open voice' })
    expect(sent).toEqual([
      { url: 'https://upstream.example/api/v1/audio/transcriptions', key: 'Bearer sk-developer', body: { ...speech, language: 'en' } },
    ])
  })

  it('may come from any page, and gets none of the headers of the upstream', async () => {
    const { post } = setup([json({ text: 'x' })])
    const answer = await post('/api/v1/audio/transcriptions', speech)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(answer.headers.get('content-type')).toBe('application/json')
    expect(answer.headers.get('x-upstream-secret')).toBeNull()
  })

  it('is forwarded for Jev and for shortening too', async () => {
    const { sent, post } = setup()
    await post('/api/alpha/decisions', { model: 'typesafe/jev-1.14', state: 's', questions: { pick: { type: 'choice' } } })
    await post('/api/v1/chat/completions', { model: 'mistralai/mistral-nemo', max_tokens: 200, messages: [{ role: 'user', content: 'x' }] })
    expect(sent.map(call => call.url)).toEqual([
      'https://upstream.example/api/alpha/decisions',
      'https://upstream.example/api/v1/chat/completions',
    ])
    expect(sent[0].body).toEqual({ model: 'typesafe/jev-1.14', state: 's', questions: { pick: { type: 'choice' } } })
    expect(sent[1].body).toEqual({ model: 'mistralai/mistral-nemo', max_tokens: 200, messages: [{ role: 'user', content: 'x' }] })
  })

  it('carries only the fields Earshot sends', async () => {
    const { sent, post } = setup()
    await post('/api/v1/chat/completions', {
      model: 'mistralai/mistral-nemo',
      messages: [],
      models: ['openai/gpt-5'],
      plugins: [{ id: 'web' }],
      provider: { order: ['x'] },
      stream: true,
      state: 'not for this call',
    })
    expect(sent[0].body).toEqual({ model: 'mistralai/mistral-nemo', messages: [] })
  })

  it("gets the upstream's refusal as it is", async () => {
    const { post } = setup([json({ error: { message: 'Rate limited' } }, 429)])
    const answer = await post('/api/v1/audio/transcriptions', speech)
    expect(answer.status).toBe(429)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(await answer.json()).toEqual({ error: { message: 'Rate limited' } })
  })
})

describe('what it refuses, without calling the upstream', () => {
  const refused = async (answer: Promise<Response>, status: number, sent: Sent[]) => {
    const got = await answer
    expect(got.status).toBe(status)
    expect(got.headers.get('access-control-allow-origin')).toBe('*')
    expect(typeof ((await got.json()) as { error: unknown }).error).toBe('string')
    expect(sent).toEqual([])
  }

  it('a model the developer did not list', async () => {
    const { sent, post } = setup()
    await refused(post('/api/v1/chat/completions', { model: 'openai/gpt-5', messages: [] }), 400, sent)
    await refused(post('/api/v1/chat/completions', { messages: [] }), 400, sent)
  })

  it('any other path', async () => {
    const { sent, post } = setup()
    await refused(post('/api/v1/embeddings', { model: 'mistralai/mistral-nemo' }), 404, sent)
    await refused(post('/api/v1/keys', {}), 404, sent)
    await refused(post('/', {}), 404, sent)
  })

  it('any other method', async () => {
    const { sent, handle } = setup()
    await refused(handle(new Request('https://relay.example/api/v1/chat/completions')), 405, sent)
  })

  it('a body that is not a JSON object', async () => {
    const { sent, post } = setup()
    await refused(post('/api/v1/chat/completions', 'not json'), 400, sent)
    await refused(post('/api/v1/chat/completions', '[1]'), 400, sent)
    await refused(post('/api/v1/chat/completions', 'null'), 400, sent)
  })

  it('a body over the size limit, whatever length it claims', async () => {
    const { sent, post, handle } = setup([], { maxBytes: 1_000 })
    const big = { model: 'mistralai/mistral-nemo', messages: [{ role: 'user', content: 'x'.repeat(1_000) }] }
    await refused(post('/api/v1/chat/completions', big), 413, sent)
    const stream = new Blob([JSON.stringify(big)]).stream()
    const unsized = new Request('https://relay.example/api/v1/chat/completions', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)
    await refused(handle(unsized), 413, sent)
  })
})

describe('the models', () => {
  it("are Earshot's own unless the developer lists others", async () => {
    expect(DEFAULT_MODELS).toEqual(Object.values(MODELS))
    const { sent, post } = setup([], { models: ['openai/whisper-1'] })
    expect((await post('/api/v1/audio/transcriptions', { ...speech, model: 'openai/whisper-1' })).status).toBe(200)
    expect((await post('/api/v1/audio/transcriptions', speech)).status).toBe(400)
    expect(sent.length).toBe(1)
  })
})

describe('the check a browser makes first', () => {
  it('is answered without calling the upstream', async () => {
    const { sent, handle } = setup()
    const answer = await handle(new Request('https://relay.example/api/alpha/decisions', { method: 'OPTIONS' }))
    expect(answer.status).toBe(204)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(answer.headers.get('access-control-allow-methods')).toBe('POST')
    expect(answer.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(sent).toEqual([])
  })
})

describe('when the upstream cannot be reached', () => {
  it('says so, and never shows the key', async () => {
    const { post } = setup([new TypeError('connect failed for Bearer sk-developer')])
    const answer = await post('/api/v1/audio/transcriptions', speech)
    expect(answer.status).toBe(502)
    expect(await answer.text()).not.toContain('sk-developer')
  })
})

describe('how long it waits for the upstream', () => {
  const slow = (seconds: number) => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const handle = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      fetch: (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(json({ text: 'open voice' })), seconds * 1000)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('timed out', 'TimeoutError'))
          })
        }),
    })
    return async (path: string, body: unknown) => {
      const answer = handle(new Request(`https://relay.example${path}`, { method: 'POST', body: JSON.stringify(body) }))
      await vi.advanceTimersByTimeAsync(60_000)
      return (await answer).status
    }
  }

  it("gives speech nearly the thirty seconds Earshot's transcriber waits, so a long recording is not cut off at ten", async () => {
    expect(await slow(20)('/api/v1/audio/transcriptions', speech)).toBe(200)
    expect(await slow(29)('/api/v1/audio/transcriptions', speech)).toBe(502)
  })

  it('gives a question and a shortening ten seconds, under the twelve Earshot waits', async () => {
    expect(await slow(9)('/api/alpha/decisions', { model: 'typesafe/jev-1.14', state: {}, questions: [] })).toBe(200)
    expect(await slow(11)('/api/alpha/decisions', { model: 'typesafe/jev-1.14', state: {}, questions: [] })).toBe(502)
    expect(await slow(11)('/api/v1/chat/completions', { model: 'mistralai/mistral-nemo', messages: [] })).toBe(502)
  })
})

describe("Earshot's own transports through the relay", () => {
  it('get their answers, and send no key of their own', async () => {
    const { sent, handle } = setup([
      json({ text: 'open voice' }),
      json({ answers: { pick: { type: 'choice', probabilities: { o1: 0.9 } } } }),
      json({ choices: [{ message: { content: 'short' } }] }),
    ])
    const seen: (string | null)[] = []
    const service = openRouter({
      host: 'https://relay.example',
      language: 'en',
      fetch: (url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return handle(new Request(url, init))
      },
    })
    const pcm = new Uint8Array(new Int16Array(1_600).fill(4_000).buffer)
    expect(await service.transcribe({ pcm, seconds: 0.1 })).toBe('open voice')
    const question = { words: 'open voice', screen: 'Notes', options: [{ id: 'o1', say: 'Open note: Voice', context: 'About voice' }] }
    expect(await service.model.choose(question)).toEqual({ o1: 0.9 })
    expect(await service.compact('a long text', 400)).toBe('short')
    expect(seen).toEqual([null, null, null])
    expect(sent.map(call => call.key)).toEqual(['Bearer sk-developer', 'Bearer sk-developer', 'Bearer sk-developer'])
    expect(sent.map(call => Object.keys(call.body).sort())).toEqual([
      ['input_audio', 'language', 'model'],
      ['model', 'questions', 'state'],
      ['max_tokens', 'messages', 'model'],
    ])
  })
})

class Wire implements Line {
  binaryType = 'blob'
  sent: Array<string | ArrayBuffer> = []
  closedWith: number | undefined
  readonly #heard: Array<(event: { data: unknown }) => void> = []
  readonly #closed: Array<(event: { code: number }) => void> = []
  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedWith ??= code ?? 1005
  }
  addEventListener(type: 'message' | 'close', listener: never): void {
    ;(type === 'message' ? this.#heard : this.#closed).push(listener)
  }
  says(data: unknown): void {
    for (const heard of this.#heard) heard({ data })
  }
  goes(code = 1000): void {
    for (const closed of this.#closed) closed({ code })
  }
}

describe('the calls, when the upstream answers with another address', () => {
  it('are told to follow none, so that no key and no recording go there', async () => {
    const seen: Array<RequestInit['redirect']> = []
    const handle = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      fetch: async (_url, init) => {
        seen.push(init?.redirect)
        return new Response('{}')
      },
    })
    await handle(
      new Request('https://relay.example/api/v1/audio/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ model: DEFAULT_MODELS[0] }),
      }),
    )
    expect(seen).toEqual(['error'])
  })
})

describe('the upstream of the calls, named with a query of its own', () => {
  it('is called as it always was: the path follows the query', async () => {
    const urls: string[] = []
    const handle = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example/dispatch?route=',
      fetch: async url => {
        urls.push(String(url))
        return new Response('{}')
      },
    })
    await handle(
      new Request('https://relay.example/api/v1/audio/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ model: DEFAULT_MODELS[0] }),
      }),
    )
    expect(urls).toEqual(['https://upstream.example/dispatch?route=/api/v1/audio/transcriptions'])
  })
})

describe('reaching the upstream of live speech', () => {
  const PHRASE = 'what only this phone was told'

  async function greeted() {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const caller = new Wire()
    const up = new Wire()
    let opens = () => {}
    let stop: AbortSignal | undefined
    const sockets: Sockets = {
      accept: async () => ({ line: caller, response: new Response(null) }),
      dial: (_url, _headers, signal, opened) => {
        stop = signal
        return new Promise(done => {
          opens = () => {
            opened(up)
            done()
          }
        })
      },
    }
    const handle = relay({ live: { upstream: 'wss://speech.example/v1', key: 'live-developer', secret: PHRASE } })
    await handle(new Request(`https://relay.example${LIVE_PATH}`, { headers: { upgrade: 'websocket' } }), sockets)
    caller.says(JSON.stringify({ model: '@cf/deepgram/flux', secret: PHRASE }))
    return { caller, up, opens: () => opens(), stopped: () => stop?.aborted }
  }

  it('gives up after five seconds, tells the caller so and tells the host to stop', async () => {
    const { caller, stopped } = await greeted()
    await vi.advanceTimersByTimeAsync(DIAL_MS - 1)
    expect([caller.closedWith, stopped()]).toEqual([undefined, false])
    await vi.advanceTimersByTimeAsync(1)
    expect([caller.closedWith, stopped()]).toEqual([CLOSES.upstream, true])
  })

  it('keeps a line whose upstream opened in time, however long it then lasts', async () => {
    const { caller, up, opens } = await greeted()
    opens()
    await vi.advanceTimersByTimeAsync(DIAL_MS * 3)
    up.says('{"type":"Connected"}')
    expect(caller.closedWith).toBeUndefined()
    expect(caller.sent).toEqual(['{"type":"Connected"}'])
  })

  it('closes an upstream that a host opened after the caller had left', async () => {
    const { caller, up, opens, stopped } = await greeted()
    caller.goes()
    expect(stopped()).toBe(true)
    opens()
    await vi.advanceTimersByTimeAsync(0)
    expect(up.closedWith).toBe(1000)
    up.says('{"type":"Connected"}')
    expect(caller.sent).toEqual([])
  })

  it('asks the host for the upstream through the host itself, so a host that keeps state in its sockets works', async () => {
    const caller = new Wire()
    class Host implements Sockets {
      readonly asked: string[] = []
      accept = async () => ({ line: caller as Line, response: new Response(null) })
      async dial(url: string) {
        this.asked.push(url)
      }
    }
    const host = new Host()
    const handle = relay({ live: { upstream: 'wss://speech.example/v1', key: 'live-developer', secret: PHRASE } })
    await handle(new Request(`https://relay.example${LIVE_PATH}`, { headers: { upgrade: 'websocket' } }), host)
    caller.says(JSON.stringify({ model: '@cf/deepgram/flux', secret: PHRASE }))
    await Promise.resolve()
    expect(host.asked).toHaveLength(1)
    expect(caller.closedWith).toBeUndefined()
    caller.goes()
  })
})
