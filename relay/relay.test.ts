import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { openRouter, MODELS } from '../src/openrouter/openrouter.js'
import { CLOSES, DIAL_MS, LIVE_PATH } from './limits.js'
import { DEFAULT_MODELS, notSetUp, relay, relayOptions, type Line, type RelayOptions, type Sockets } from './relay.js'

interface Sent {
  url: string
  key: string | null
  body: Record<string, unknown>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-upstream-secret': 'hidden' } })

function setup(answers: (Response | Error)[] = [], more: Pick<RelayOptions, 'models' | 'maxBytes' | 'calls'> = {}) {
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

describe('a relay with a secret', () => {
  const SECRET = 'a phrase of the developer'
  const guarded = (answers: Response[] = [], options: Partial<Parameters<typeof relay>[0]> = { secret: SECRET }) => {
    const sent: Sent[] = []
    const handle = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      ...options,
      fetch: async (url, init) => {
        sent.push({ url: String(url), key: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
        return answers.shift() ?? json({})
      },
    })
    const post = (path: string, body: unknown) =>
      handle(new Request(`https://relay.example${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
    return { sent, post }
  }
  const CALLS: [string, Record<string, unknown>][] = [
    ['/api/v1/audio/transcriptions', speech],
    ['/api/alpha/decisions', { model: 'typesafe/jev-1.14', state: 'x', questions: {} }],
    ['/api/v1/chat/completions', { model: 'mistralai/mistral-nemo', messages: [] }],
  ]

  it.each(CALLS)('turns away a call to %s that does not say it, and forwards nothing', async (path, body) => {
    const { sent, post } = guarded()
    const answers = [await post(path, body), await post(path, { ...body, secret: `${SECRET}!` }), await post(path, { ...body, secret: 7 })]
    expect(answers.map(answer => answer.status)).toEqual([401, 401, 401])
    expect(await answers[0].json()).toEqual({ error: 'Not an app this relay knows.' })
    expect(sent).toEqual([])
  })

  it.each(CALLS)('forwards a call to %s that says it, and the secret goes no further', async (path, body) => {
    const { sent, post } = guarded([json({ ok: true })])
    const answer = await post(path, { ...body, secret: SECRET })
    expect([answer.status, await answer.json()]).toEqual([200, { ok: true }])
    expect(sent).toEqual([{ url: `https://upstream.example${path}`, key: 'Bearer sk-developer', body }])
    expect(JSON.stringify(sent)).not.toContain(SECRET)
  })

  it('with only some calls named: a call it does not forward is refused as such whoever asks, and a named one still asks for the secret', async () => {
    const { sent, post } = guarded([json({ ok: true })], { secret: SECRET, calls: ['decide'] })
    const decide = { model: 'typesafe/jev-1.14', state: 'x', questions: {} }
    const answers = [
      await post('/api/v1/audio/transcriptions', { ...speech, secret: SECRET }),
      await post('/api/alpha/decisions', decide),
      await post('/api/alpha/decisions', { ...decide, secret: SECRET }),
    ]
    expect([answers.map(answer => answer.status), sent.length]).toEqual([[404, 401, 200], 1])
  })

  it('answers what the upstream refused with its status and none of its words, also to a caller with the secret', async () => {
    const { post } = guarded([new Response(JSON.stringify({ error: `you said ${SECRET}` }), { status: 429 })])
    const answer = await post('/api/v1/audio/transcriptions', { ...speech, secret: SECRET })
    expect([answer.status, await answer.text()]).toEqual([429, JSON.stringify({ error: 'The upstream answered 429.' })])
  })

  it('says nothing of its models to a caller without the secret', async () => {
    const { post } = guarded()
    const answer = await post('/api/v1/audio/transcriptions', { model: 'not/listed' })
    expect([answer.status, await answer.text()]).toEqual([401, JSON.stringify({ error: 'Not an app this relay knows.' })])
  })

  it('asks its calls for the secret of live speech too: a relay has one secret', async () => {
    const live = { upstream: 'wss://speech.example/v1', key: 'live-developer', secret: SECRET }
    const { sent, post } = guarded([json({})], { live })
    expect((await post('/api/v1/audio/transcriptions', speech)).status).toBe(401)
    expect((await post('/api/v1/audio/transcriptions', { ...speech, secret: SECRET })).status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(() => guarded([], { live, secret: SECRET })).not.toThrow()
    expect(() => guarded([], { live, secret: `${SECRET} of another kind` })).toThrow('one secret')
  })

  it('is given once by the settings a host reads, where it always was for live speech, so that options an app already reads keep their shape', () => {
    const settings = {
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      models: undefined,
      liveUpstream: 'wss://speech.example/v1',
      liveKey: 'live-developer',
      liveModels: undefined,
      secret: SECRET,
      calls: undefined,
    }
    const options = relayOptions(settings)
    expect([options.secret, options.live?.secret]).toEqual([undefined, SECRET])
    const { live: lone } = relayOptions({ ...settings, secret: undefined })
    expect(() => guarded([], { live: lone })).toThrow('Live speech needs a secret')
  })

  it.each([null, false, 0, 7, {}])(
    'is not made with %j for a secret, by the settings or by hand: only unset or empty means none',
    given => {
      const settings = {
        key: 'sk-developer',
        upstream: 'https://upstream.example',
        models: undefined,
        liveUpstream: undefined,
        liveKey: undefined,
        liveModels: undefined,
        secret: given as unknown as string,
        calls: undefined,
      }
      expect(() => relay(relayOptions(settings))).toThrow('needs a secret')
      expect(() => guarded([], { secret: given as unknown as string })).toThrow('needs a secret')
      expect(() => relay(relayOptions({ ...settings, liveUpstream: 'wss://speech.example/v1', liveKey: 'k' }))).toThrow('needs a secret')
    },
  )

  it.each(['', 'a'.repeat(15), 'a'.repeat(1_025), 0])('is not made with the secret %j: none is left out, not given empty', secret => {
    expect(() => guarded([], { secret: secret as string })).toThrow('needs a secret')
  })

  it('comes from the settings a host reads, with live speech or without, and an empty setting is none', () => {
    const settings = {
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      models: undefined,
      liveUpstream: undefined,
      liveKey: undefined,
      liveModels: undefined,
      calls: undefined,
    }
    const calls = { key: 'sk-developer', upstream: 'https://upstream.example' }
    expect(relayOptions({ ...settings, secret: SECRET })).toEqual({ ...calls, secret: SECRET })
    expect(relayOptions({ ...settings, secret: '' })).toEqual(calls)
    expect(relayOptions({ ...settings, liveUpstream: 'wss://speech.example/v1', liveKey: 'k', secret: SECRET })).toEqual({
      ...calls,
      live: { upstream: 'wss://speech.example/v1', key: 'k', secret: SECRET },
    })
  })

  it('is asked of the callers Earshot ships, which then get their answers as before', async () => {
    const { sent, post } = guarded([json({ text: 'open voice' })])
    const service = openRouter({
      host: 'https://relay.example',
      secret: SECRET,
      fetch: (url, init) => post(new URL(String(url)).pathname, String(init?.body)),
    })
    expect(await service.transcribe({ pcm: new Uint8Array(3_200), seconds: 0.1 })).toBe('open voice')
    expect(sent).toHaveLength(1)
  })
})

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

  it.each([400, 401, 402, 403, 404, 429, 500, 503])(
    "gets the status of the upstream's refusal (%i) and none of its words, which may quote what the user said",
    async status => {
      const quoted = 'Could not make sense of the state: The user said: "call my doctor about the results"'
      const { post } = setup([json({ error: { message: quoted, metadata: { raw: quoted } } }, status)])
      const answer = await post('/api/alpha/decisions', {
        model: 'typesafe/jev-1.14',
        state: 'The user said: "call my doctor about the results"',
      })
      expect(answer.status).toBe(status)
      expect(answer.headers.get('access-control-allow-origin')).toBe('*')
      expect(await answer.json()).toEqual({ error: `The upstream answered ${status}.` })
    },
  )

  it('lets go of a refusal that goes on sending: what the relay will not read does not stay open', async () => {
    let letGo = false
    let sent = 0
    const going = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 5))
        if (++sent > 40) controller.close()
        else controller.enqueue(new Uint8Array(1_024))
      },
      cancel: () => void (letGo = true),
    })
    const { post } = setup([new Response(going, { status: 500 })])
    expect((await post('/api/v1/audio/transcriptions', speech)).status).toBe(500)
    expect(letGo).toBe(true)
    expect(sent).toBeLessThan(40)
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

describe('the calls the developer names', () => {
  const decide = { model: 'typesafe/jev-1.14', state: 'The user said: "open voice"', questions: {} }
  const compact = { model: 'mistralai/mistral-nemo', messages: [] }
  const none = {
    key: undefined,
    upstream: undefined,
    models: undefined,
    liveUpstream: undefined,
    liveKey: undefined,
    liveModels: undefined,
    secret: undefined,
  }

  it('are the only ones forwarded: an app that asks for decisions alone has a relay that pays for nothing else', async () => {
    const { sent, post } = setup([], { calls: ['decide'] })
    expect((await post('/api/alpha/decisions', decide)).status).toBe(200)
    const others = [await post('/api/v1/audio/transcriptions', speech), await post('/api/v1/chat/completions', compact)]
    expect(others.map(answer => answer.status)).toEqual([404, 404])
    expect(await others[0].json()).toEqual({ error: 'Not a call this relay forwards.' })
    expect(sent.map(({ url }) => url)).toEqual(['https://upstream.example/api/alpha/decisions'])
  })

  it('are all three when none is named, as it always was', async () => {
    const { sent, post } = setup()
    await post('/api/v1/audio/transcriptions', speech)
    await post('/api/alpha/decisions', decide)
    await post('/api/v1/chat/completions', compact)
    expect(sent.length).toBe(3)
  })

  it('are refused before what was sent is read: a call that is not forwarded costs the relay nothing', async () => {
    const { sent, post } = setup([], { calls: ['speech'], maxBytes: 10 })
    const answer = await post('/api/alpha/decisions', 'not json, and over the limit')
    expect([answer.status, sent.length]).toEqual([404, 0])
  })

  it('may be none at all', async () => {
    const { sent, post } = setup([], { calls: [] })
    expect([(await post('/api/alpha/decisions', decide)).status, sent.length]).toEqual([404, 0])
  })

  it.each(['decisions', 'Speech', 'toString', '*'])('are not guessed: no relay is made for the name %j, by any way in', name => {
    const made = (calls: string[]) => relay({ key: 'sk-developer', upstream: 'https://upstream.example', calls: calls as never })
    expect(() => made(['decide', name])).toThrow('speech, decide and compact')
    expect(() => relayOptions({ ...none, key: 'sk-developer', upstream: 'https://upstream.example', calls: `decide,${name}` })).toThrow(
      'speech, decide and compact',
    )
  })

  it('say nothing of what was typed when a name is wrong, since a key pasted into the wrong setting would be printed', () => {
    const typed = 'sk-or-v1-pasted-into-the-wrong-setting'
    let said = ''
    try {
      relayOptions({ ...none, key: 'sk-developer', upstream: 'https://upstream.example', calls: typed })
    } catch (error) {
      said = String(error)
    }
    expect(said).toContain('speech, decide and compact')
    expect(said).not.toContain(typed)
  })

  it('are read from the comma-separated list a host has, and an empty list names none: all three are forwarded', () => {
    const settings = { ...none, key: 'sk-developer', upstream: 'https://upstream.example' }
    expect(relayOptions({ ...settings, calls: ' decide , speech' }).calls).toEqual(['decide', 'speech'])
    expect(relayOptions({ ...settings, calls: ' , ' })).toEqual({ key: 'sk-developer', upstream: 'https://upstream.example' })
    expect(relayOptions({ ...settings, calls: undefined })).toEqual({ key: 'sk-developer', upstream: 'https://upstream.example' })
  })

  it('leave live speech as it is: that line has its own settings', () => {
    const live = { upstream: 'wss://gateway.example/v1/workers-ai', key: 'live', secret: 'what only this phone was told' }
    const handle = relay({ key: 'sk-developer', upstream: 'https://upstream.example', calls: [], live })
    return handle(new Request('https://relay.example/api/v1/live')).then(answer => expect(answer.status).toBe(426))
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

describe('a host that cannot refuse to start, with settings that make no relay', () => {
  it('says that it is not set up with a status a page can read, to any page', async () => {
    const answer = notSetUp(new Request('https://relay.example/api/alpha/decisions', { method: 'POST', body: '{}' }))
    expect(answer.status).toBe(503)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(await answer.json()).toEqual({ error: 'This relay is not set up.' })
  })

  it('answers the check a browser makes first as a relay does: without it the page never sees that status', async () => {
    const { handle } = setup()
    const first = () => new Request('https://relay.example/api/alpha/decisions', { method: 'OPTIONS' })
    const [mine, relays] = [notSetUp(first()), await handle(first())]
    const headers = (answer: Response) => {
      const all: string[] = []
      answer.headers.forEach((value, name) => all.push(`${name}: ${value}`))
      return all
    }
    expect([mine.status, headers(mine)]).toEqual([relays.status, headers(relays)])
    expect(mine.status).toBe(204)
  })

  it('says the same to a caller that asks for the live line', () => {
    const asks = new Request('https://relay.example/api/v1/live', { headers: { upgrade: 'websocket' } })
    expect(notSetUp(asks).status).toBe(503)
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
  const call = () =>
    new Request('https://relay.example/api/v1/audio/transcriptions', {
      method: 'POST',
      body: JSON.stringify({ model: DEFAULT_MODELS[0] }),
    })

  it("ask for the redirect itself and follow none: a Worker's fetch refuses any other way of not following", async () => {
    const seen: Array<RequestInit['redirect']> = []
    const handle = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
      fetch: async (_url, init) => {
        seen.push(init?.redirect)
        return new Response('{}')
      },
    })
    await handle(call())
    expect(seen).toEqual(['manual'])
  })

  it.each([301, 302, 303, 307, 308])('answer a %i that the upstream could not be reached, and pass on nothing of it', async status => {
    const moved = new Response('{"key":"sk-developer"}', { status, headers: { location: 'https://elsewhere.example/api' } })
    const handle = relay({ key: 'sk-developer', upstream: 'https://upstream.example', fetch: async () => moved })
    const answered = await handle(call())
    expect(answered.status).toBe(502)
    expect(answered.headers.get('location')).toBeNull()
    expect(await answered.text()).toBe('{"error":"The upstream could not be reached."}')
  })

  it('let go of a redirect that goes on sending: what the relay will not read does not stay open', async () => {
    let letGo = false
    let sent = 0
    const going = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 5))
        if (++sent > 40) controller.close()
        else controller.enqueue(new Uint8Array(1_024))
      },
      cancel: () => void (letGo = true),
    })
    const moved = new Response(going, { status: 307, headers: { location: 'https://elsewhere.example/api' } })
    const handle = relay({ key: 'sk-developer', upstream: 'https://upstream.example', fetch: async () => moved })
    expect((await handle(call())).status).toBe(502)
    expect(letGo).toBe(true)
    expect(sent).toBeLessThan(40)
  })

  it('answer the same when the host gives no more than that it was a redirect', async () => {
    const hidden = Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })
    const handle = relay({ key: 'sk-developer', upstream: 'https://upstream.example', fetch: async () => hidden })
    expect((await handle(call())).status).toBe(502)
  })
})

describe('the upstream of the calls, named with a query of its own', () => {
  it.each([
    [
      "https://gateway.example/dispatch?tenant=Bob's&route=",
      "https://gateway.example/dispatch?tenant=Bob's&route=/api/v1/audio/transcriptions",
    ],
    ['https://upstream.example?route=', 'https://upstream.example?route=/api/v1/audio/transcriptions'],
  ])("reaches a host's own fetch spelled as the developer spelled it: %s", async (upstream, called) => {
    const urls: string[] = []
    const handle = relay({
      key: 'sk-developer',
      upstream,
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
    expect(urls).toEqual([called])
  })

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

describe('the upstream of the calls, for a host that brings its own fetch', () => {
  it.each([
    '/backend',
    'backend',
    '',
    ' ',
    '//upstream.example',
    '/\t',
    'http:127.0.0.1',
    'https:upstream.example',
    'ftp://localhost/x',
    'http://',
  ])('is a whole address like any other: %j is refused, so no name can come to mean another host', upstream => {
    expect(() => relay({ key: 'sk-developer', upstream, fetch: async () => new Response('{}') })).toThrow(/address|https/)
  })

  it('may come with no key, as it always could: a host with its own fetch may sign its calls itself', async () => {
    const keys: Array<string | null> = []
    const handle = relay({
      key: '',
      upstream: 'https://upstream.example',
      fetch: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('authorization'))
        return new Response('{}')
      },
    })
    const answer = await handle(
      new Request('https://relay.example/api/v1/audio/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ model: DEFAULT_MODELS[0] }),
      }),
    )
    expect([answer.status, keys.length]).toEqual([200, 1])
  })

  it('keeps an explicitly empty key through the settings a host reads', () => {
    const settings = {
      key: '',
      upstream: 'https://upstream.example',
      models: undefined,
      liveUpstream: undefined,
      liveKey: undefined,
      liveModels: undefined,
      secret: undefined,
      calls: undefined,
    }
    expect(relayOptions(settings)).toEqual({ key: '', upstream: 'https://upstream.example' })
    expect(() => relay(relayOptions(settings))).not.toThrow()
  })

  it('needs a key to be given when the relay fetches its upstream itself, though the key may be empty, as it always could', async () => {
    expect(() => relay({ upstream: 'https://upstream.example' })).toThrow('need the key')
    const keys: Array<string | null> = []
    const real = globalThis.fetch
    onTestFinished(() => void (globalThis.fetch = real))
    globalThis.fetch = async (_url, init) => {
      keys.push(new Headers(init?.headers).get('authorization'))
      return new Response('{}')
    }
    const handle = relay({ key: '', upstream: 'http://127.0.0.1:8080' })
    await handle(
      new Request('https://relay.example/api/v1/audio/transcriptions', {
        method: 'POST',
        body: JSON.stringify({ model: DEFAULT_MODELS[0] }),
      }),
    )
    expect(keys).toEqual(['Bearer'])
  })

  it('takes plain http to any address of this machine, as the whole of 127 is', () => {
    expect(() => relay({ key: 'sk-developer', upstream: 'http://127.0.0.2:8787' })).not.toThrow()
    expect(() => relay({ key: 'sk-developer', upstream: 'http://127.example.com' })).toThrow('https')
    expect(() => relay({ key: 'sk-developer', upstream: 'http://128.0.0.1' })).toThrow('https')
  })

  it.each(['http://[::ffff:127.0.0.1]:8787', 'http://[::ffff:7f01:203]:8787', 'http://[0:0:0:0:0:ffff:127.9.9.9]'])(
    'takes plain http to %s, which is this machine written as IPv6 writes an IPv4 address',
    upstream => {
      expect(() => relay({ key: 'sk-developer', upstream })).not.toThrow()
    },
  )

  it.each(['http://[::ffff:128.0.0.1]', 'http://[::ffff:126.255.0.1]', 'http://[::fffe:7f00:1]', 'http://[2001:db8::7f00:1]'])(
    'does not take plain http to %s, which is another machine',
    upstream => {
      expect(() => relay({ key: 'sk-developer', upstream })).toThrow('https')
    },
  )

  it('must be a whole address when the relay fetches it itself', () => {
    expect(() => relay({ key: 'sk-developer', upstream: '/backend' })).toThrow('needs the address')
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
    const handle = relay({ live: { upstream: 'wss://speech.example/v1', key: 'live-developer', secret: PHRASE } }, sockets)
    await handle(new Request(`https://relay.example${LIVE_PATH}`, { headers: { upgrade: 'websocket' } }))
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
    const handle = relay({ live: { upstream: 'wss://speech.example/v1', key: 'live-developer', secret: PHRASE } }, host)
    await handle(new Request(`https://relay.example${LIVE_PATH}`, { headers: { upgrade: 'websocket' } }))
    caller.says(JSON.stringify({ model: '@cf/deepgram/flux', secret: PHRASE }))
    await Promise.resolve()
    expect(host.asked).toHaveLength(1)
    expect(caller.closedWith).toBeUndefined()
    caller.goes()
  })

  it('keeps the shape a host already gives it: one request in, one answer out', () => {
    const fetch: (request: Request, env: { APP_MODE: string }) => Promise<Response> = relay({
      key: 'sk-developer',
      upstream: 'https://upstream.example',
    })
    expect(fetch).toHaveLength(1)
  })
})
