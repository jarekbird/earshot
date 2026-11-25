import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifetime, LifetimeEnded } from '../lifetime.js'
import { RelayError, SayError } from '../say.js'
import { openRouter } from './openrouter.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

interface Sent {
  url: string
  key: string | null
  body: Record<string, unknown>
}

function service(...answers: (Response | Error)[]) {
  const sent: Sent[] = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), key: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) })
    const answer = answers.shift() ?? json({})
    if (answer instanceof Error) throw answer
    return answer
  }
  return { sent, fetcher }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const tone = () => new Uint8Array(new Int16Array(1_600).map((_, at) => 8_000 * Math.sin(at / 5)).buffer)

function ready(...answers: (Response | Error)[]) {
  const { sent, fetcher } = service(...answers)
  return { sent, router: openRouter({ host: 'https://relay.example', fetch: fetcher }) }
}

describe('a relay that asks for a secret', () => {
  const SECRET = 'a phrase of the developer'

  it('is told the secret with each of the three calls, in the body and in no header', async () => {
    const { sent, fetcher } = service(json({ text: 'x' }), json({ answers: {} }), json({ choices: [{ message: { content: 'short' } }] }))
    const router = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: fetcher })
    await router.transcribe({ pcm: tone(), seconds: 0.1 })
    await router.model.choose({ words: 'open', options: [{ id: 'a', say: 'A' }] })
    await router.compact('a long text', 40)
    expect(sent.map(call => [call.body.secret, call.key])).toEqual(Array(3).fill([SECRET, null]))
  })

  it('sends no secret when the app named none', async () => {
    const { sent, router } = ready(json({ text: 'x' }))
    await router.transcribe({ pcm: tone(), seconds: 0.1 })
    expect('secret' in sent[0].body).toBe(false)
  })

  it.each(['http://relay.example', 'ws://relay.example', 'relay.example', ''])(
    'is not named %j: a secret travels to it, so its address is whole and with https',
    host => {
      expect(() => openRouter({ host, secret: SECRET })).toThrow('https')
      expect(() => openRouter({ host })).not.toThrow()
    },
  )

  it.each(['https://relay.example/', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])('may be named %j', host => {
    expect(() => openRouter({ host, secret: SECRET })).not.toThrow()
  })

  it.each([
    'https://relay.example/?to=elsewhere',
    'https://relay.example/#part',
    'https://name@relay.example',
    'https://name:word@relay.example',
  ])('is not named %j: by its address alone', host => {
    expect(() => openRouter({ host, secret: SECRET })).toThrow('address alone')
    expect(() => openRouter({ host })).not.toThrow()
  })

  it.each([
    ['https:relay.example', 'https://relay.example/api/v1/audio/transcriptions'],
    ['https://relay.example/base//', 'https://relay.example/base/api/v1/audio/transcriptions'],
    ['HTTPS://Relay.Example:443', 'https://relay.example/api/v1/audio/transcriptions'],
  ])('is called at the address that was checked, never at the text %j as a page would read it', async (host, called) => {
    const { sent, fetcher } = service(json({ text: 'x' }))
    await openRouter({ host, secret: SECRET, fetch: fetcher }).transcribe({ pcm: tone(), seconds: 0.1 })
    expect(new URL(sent[0].url, 'https://app.example/panel/').href).toBe(called)
  })

  it('gets its failures told without what was sent: an error of a call that carried the secret has no cause', async () => {
    const telling = async (_url: string | URL | Request, init?: RequestInit) => {
      throw Object.assign(new Error('the request failed'), { request: init?.body })
    }
    const unread = async () => new Response('not json', { status: 200 })
    const failed = async (fetcher: typeof fetch, secret?: string) =>
      openRouter({ host: 'https://relay.example', ...(secret === undefined ? {} : { secret }), fetch: fetcher })
        .transcribe({ pcm: tone(), seconds: 0.1 })
        .catch((error: Error) => error)
    const errors = [await failed(telling, SECRET), await failed(unread, SECRET)]
    expect(errors.map(error => [(error as Error).constructor.name, (error as Error).cause])).toEqual([
      ['SayError', undefined],
      ['RelayError', undefined],
    ])
    expect(JSON.stringify(errors.map(error => ({ ...(error as Error) })))).not.toContain(SECRET)
    const open = [await failed(telling), await failed(unread)]
    expect(open.map(error => (error as Error).cause instanceof Error)).toEqual([true, true])
  })

  it.each([
    ['a redirect', 307, () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/api' } })],
    ['a redirect it may not look into', undefined, () => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })],
    ['a moved-for-good', 301, () => new Response('{"text":"from elsewhere"}', { status: 301 })],
  ])(
    'says there is no connection when the relay answers with %s, with the status it could see, and reads nothing of it',
    async (_name, status, moved) => {
      const { sent, fetcher } = service(moved())
      const failed = await openRouter({ host: 'https://relay.example', secret: SECRET, fetch: fetcher })
        .transcribe({ pcm: tone(), seconds: 0.1 })
        .catch((error: SayError) => error)
      expect(failed instanceof SayError && [failed.say, failed.status, failed.cause, sent.length]).toEqual([
        'No connection',
        status,
        undefined,
        1,
      ])
    },
  )

  it.each([307, 401])(
    'leaves an answer of %i unused when it comes after its turn has ended: the next turn is not held back for it',
    async status => {
      let answer = (_response: Response) => {}
      const late = new Promise<Response>(resolve => (answer = resolve))
      const answers = [late, Promise.resolve(json({ text: 'the next turn' }))]
      const router = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: async () => answers.shift() ?? json({}) })
      const life = new Lifetime()
      const failed = router.transcribe({ pcm: tone(), seconds: 0.1 }, life).catch((error: Error) => error)
      life.end()
      answer(new Response(null, { status }))
      expect(await failed).toBeInstanceOf(LifetimeEnded)
      expect(await router.transcribe({ pcm: tone(), seconds: 0.1 })).toBe('the next turn')
    },
  )

  it('leaves unused what it reads of an answer once its turn has ended, and lets go of an answer it will not read', async () => {
    let finish = (_text: string) => {}
    const slow = new Response(
      new ReadableStream<Uint8Array>({
        start: stream => void (finish = text => (stream.enqueue(new TextEncoder().encode(text)), stream.close())),
      }),
    )
    const read = new Lifetime()
    const reading = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: async () => slow })
      .transcribe({ pcm: tone(), seconds: 0.1 }, read)
      .catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(0)
    read.end()
    finish('{"text":"late"}')
    expect(await reading).toBeInstanceOf(LifetimeEnded)

    let let_go = 0
    let answer = (_response: Response) => {}
    const late = new Promise<Response>(resolve => (answer = resolve))
    const unread = new Lifetime()
    const leaving = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: () => late })
      .transcribe({ pcm: tone(), seconds: 0.1 }, unread)
      .catch((error: Error) => error)
    unread.end()
    answer(new Response(new ReadableStream({ cancel: () => (let_go++, new Promise<void>(() => {})) }), { status: 200 }))
    expect([await leaving, let_go].map(seen => (seen instanceof LifetimeEnded ? 'ended' : seen))).toEqual(['ended', 1])
  })

  it.each([401, 429, 500, 418])('lets go of an answer of %i it does not read, without waiting for it', async status => {
    let let_go = 0
    const unread = new ReadableStream({ cancel: () => (let_go++, new Promise<void>(() => {})) })
    const router = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: async () => new Response(unread, { status }) })
    const failed = await router.transcribe({ pcm: tone(), seconds: 0.1 }).catch((error: Error) => error)
    expect([failed instanceof Error, let_go]).toEqual([true, 1])
  })

  it('holds no later turn back for a refusal whose turn ended as the answer was let go of', async () => {
    const life = new Lifetime()
    const ending = new ReadableStream({ cancel: () => life.end() })
    const answers = [new Response(ending, { status: 401 }), json({ text: 'the next turn' })]
    const router = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: async () => answers.shift() ?? json({}) })
    expect(await router.transcribe({ pcm: tone(), seconds: 0.1 }, life).catch((error: Error) => error)).toBeInstanceOf(LifetimeEnded)
    expect(await router.transcribe({ pcm: tone(), seconds: 0.1 })).toBe('the next turn')
  })

  it('leaves nothing listening on a call once its answer is read, with a turn or without', async () => {
    const signals: AbortSignal[] = []
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return json({ text: 'x', choices: [{ message: { content: 'short' } }] })
    }
    const router = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: fetcher })
    await router.compact('a long text', 40)
    await router.transcribe({ pcm: tone(), seconds: 0.1 }, new Lifetime())
    expect(signals.map(signal => getEventListeners(signal, 'abort').length)).toEqual([0, 0])
  })

  it.each([undefined, SECRET])('ends with its turn while it reads an answer that never ends (secret: %s)', async secret => {
    const endless = () =>
      new Response(new ReadableStream<Uint8Array>({ start: stream => stream.enqueue(new TextEncoder().encode('{"text":')) }))
    const life = new Lifetime()
    const router = openRouter({ host: 'https://relay.example', ...(secret ? { secret } : {}), fetch: async () => endless() })
    const failed = router.transcribe({ pcm: tone(), seconds: 0.1 }, life).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(0)
    life.end()
    expect(await failed).toBeInstanceOf(LifetimeEnded)
  })

  it('ends with its turn also while it lets go of a redirect that will not be let go of', async () => {
    const stuck = new ReadableStream({ cancel: () => new Promise<void>(() => {}) })
    const life = new Lifetime()
    const router = openRouter({
      host: 'https://relay.example',
      secret: SECRET,
      fetch: async () => new Response(stuck, { status: 307 }),
    })
    const failed = router.transcribe({ pcm: tone(), seconds: 0.1 }, life).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(0)
    life.end()
    expect(await failed).toBeInstanceOf(SayError)
  })

  it('is followed to no other address: a call that carries the secret takes no redirect, and one without goes as before', async () => {
    const modes: (RequestRedirect | undefined)[] = []
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => (
      modes.push(init?.redirect),
      json({ text: 'x', choices: [{ message: { content: 'y' } }] })
    )
    const guarded = openRouter({ host: 'https://relay.example', secret: SECRET, fetch: fetcher })
    await guarded.transcribe({ pcm: tone(), seconds: 0.1 })
    await guarded.model.choose({ words: 'open', options: [{ id: 'a', say: 'A' }] })
    await guarded.compact('a long text', 40)
    await openRouter({ host: 'https://relay.example', fetch: fetcher }).transcribe({ pcm: tone(), seconds: 0.1 })
    expect(modes).toEqual(['manual', 'manual', 'manual', undefined])
  })
})

describe('speech to text', () => {
  it('sends the recording as a sound file to the host the app named, with no key, and gives the words', async () => {
    const { sent, router } = ready(json({ text: ' open the second note ' }))
    expect(await router.transcribe({ pcm: tone(), seconds: 0.1 })).toBe('open the second note')
    expect(sent.length).toBe(1)
    expect(sent[0].url).toBe('https://relay.example/api/v1/audio/transcriptions')
    expect(sent[0].key).toBeNull()
    const audio = sent[0].body.input_audio as { data: string; format: string }
    expect(sent[0].body.model).toBe('openai/whisper-large-v3-turbo')
    expect(audio.format).toBe('wav')
    expect(atob(audio.data).slice(0, 4)).toBe('RIFF')
    expect(atob(audio.data).length).toBe(44 + 3_200)
  })

  it('sends a recording over a minute in parts, in order, and joins their words', async () => {
    const { sent, router } = ready(json({ text: ' first part ' }), json({ text: 'second part' }), json({ text: '' }))
    const pcm = new Uint8Array(150 * 16_000 * 2)
    expect(await router.transcribe({ pcm, seconds: 150 })).toBe('first part second part')
    expect(sent.length).toBe(3)
    for (const call of sent) expect(atob((call.body.input_audio as { data: string }).data).length).toBeLessThanOrEqual(44 + 60 * 32_000)
  })

  it('uses the model and the language the app chose', async () => {
    const { sent, fetcher } = service(json({ text: 'hallo' }))
    const router = openRouter({
      host: 'https://relay.example/',
      fetch: fetcher,
      language: 'de',
      models: { speech: 'openai/whisper-1' },
    })
    await router.transcribe({ pcm: tone(), seconds: 0.1 })
    expect(sent[0].body).toMatchObject({ model: 'openai/whisper-1', language: 'de' })
  })
})

describe('the navigator model', () => {
  const question = {
    words: 'open voice',
    screen: 'A list of notes',
    options: [
      { id: 'o0', say: 'None of these', role: 'none' as const },
      { id: 'o1', say: 'Open note', context: 'Shows one note' },
      { id: 'o2', say: 'Open note: Voice' },
      { id: 'o3', say: 'A note to remember', role: 'pass' as const },
    ],
  }

  it('asks Jev one choice question with every option, and gives back its chances', async () => {
    const answer = { answers: { pick: { type: 'choice', choice: 'o2', probabilities: { o0: 0.01, o1: 0.09, o2: 0.9 }, confidence: 0.9 } } }
    const { sent, router } = ready(json(answer))
    expect(await router.model.choose(question)).toEqual({ o0: 0.01, o1: 0.09, o2: 0.9 })
    expect(sent[0].url).toBe('https://relay.example/api/alpha/decisions')
    expect(sent[0].body.model).toBe('typesafe/jev-1.14')
    expect(sent[0].body.state).toBe('The user said: "open voice"\nOn the screen: A list of notes')
    const pick = (sent[0].body.questions as { pick: { type: string; criteria: Record<string, string> } }).pick
    expect(pick.type).toBe('choice')
    expect(pick.criteria).toEqual({
      o0: 'The person asked for a screen or an action that is not in this list.',
      o1: 'Open note. About it: Shows one note',
      o2: 'Open note: Voice',
      o3: 'The words are not a request to go somewhere or do one of these. They are: a note to remember.',
    })
  })

  it('gives no chances when Jev refuses or answers something else', async () => {
    const { router } = ready(json({ answers: { pick: { type: 'refusal' } } }), json({ answers: {} }))
    expect(await router.model.choose(question)).toEqual({})
    expect(await router.model.choose(question)).toEqual({})
  })
})

describe('compaction', () => {
  it('asks for a shorter text within the limit and gives it back', async () => {
    const { sent, router } = ready(json({ choices: [{ message: { content: ' The short version. ' } }] }))
    expect(await router.compact('a very long text', 400)).toBe('The short version.')
    expect(sent[0].url).toBe('https://relay.example/api/v1/chat/completions')
    const messages = sent[0].body.messages as { role: string; content: string }[]
    expect(messages[0].content).toContain('400 characters')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'a very long text' })
  })

  it('fails when nothing comes back, so the last characters are used', async () => {
    const { router } = ready(json({ choices: [] }))
    await expect(router.compact('a very long text', 400)).rejects.toThrow()
  })
})

describe('when it goes wrong', () => {
  const said = async (work: Promise<unknown>) => {
    try {
      await work
    } catch (error) {
      return error instanceof SayError ? error.say : `not said: ${String(error)}`
    }
    return 'nothing wrong'
  }

  it('says there is no connection when the call cannot be made', async () => {
    const { router } = ready(new TypeError('Failed to fetch'))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe('No connection')
  })

  it('gives a short reason when the relay cannot pay or is refused, for too many calls and for a busy service', async () => {
    for (const [status, reason] of [
      [401, 'Voice is off for now'],
      [402, 'Voice is off for now'],
      [403, 'Voice is off for now'],
      [429, 'Too many requests'],
      [503, 'The service is busy'],
    ] as const) {
      const { router } = ready(json({ error: 'x' }, status))
      expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe(reason)
    }
  })

  it('stops calling for a while after such a refusal, then calls again', async () => {
    const { sent, router } = ready(json({}, 429), json({ text: 'again' }))
    const once = () => said(router.transcribe({ pcm: tone(), seconds: 0.1 }))
    expect(await once()).toBe('Too many requests')
    expect(await once()).toBe('Too many requests')
    expect(sent.length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await once()).toBe('nothing wrong')
    expect(sent.length).toBe(2)
  })

  it('does not hold back after a lost connection', async () => {
    const { sent, router } = ready(new TypeError('Failed to fetch'), json({ text: 'again' }))
    await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe('nothing wrong')
    expect(sent.length).toBe(2)
  })

  it('an error carries the status of the request that failed, however many parts were on their way', async () => {
    const { router } = ready(json({}, 402), json({ text: 'the second part' }))
    const failure = await router.transcribe({ pcm: new Uint8Array(70 * 32_000), seconds: 70 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SayError)
    expect((failure as SayError).status).toBe(402)
  })

  it('keeps why the call could not be made, and what could not be read, as the cause', async () => {
    const lost = new TypeError('Failed to fetch')
    const offline = await ready(lost)
      .router.transcribe({ pcm: tone(), seconds: 0.1 })
      .catch((error: unknown) => error)
    expect((offline as SayError).cause).toBe(lost)
    expect((offline as SayError).status).toBeUndefined()
    const garbled = await ready(new Response('not json'))
      .router.model.choose({ words: 'x', options: [] })
      .catch((error: unknown) => error)
    expect(garbled).toBeInstanceOf(RelayError)
    expect((garbled as RelayError).status).toBe(200)
    expect(((garbled as RelayError).cause as Error).name).toBe('SyntaxError')
    const refused = await ready(json({}, 400))
      .router.transcribe({ pcm: tone(), seconds: 0.1 })
      .catch((error: unknown) => error)
    expect((refused as RelayError).status).toBe(400)
  })

  it('E7: ends its requests with the lifetime it was given, and reports the end, not a lost connection', async () => {
    for (const ask of ['transcribe', 'choose'] as const) {
      const signals: AbortSignal[] = []
      const router = openRouter({
        host: 'https://relay.example',
        fetch: (_url, init) =>
          new Promise<Response>((_, fail) => {
            const signal = init!.signal!
            signals.push(signal)
            signal.addEventListener('abort', () => fail(signal.reason))
          }),
      })
      const life = new Lifetime()
      const asking =
        ask === 'transcribe'
          ? router.transcribe({ pcm: new Uint8Array(70 * 32_000), seconds: 70 }, life)
          : router.model.choose({ words: 'x', options: [] }, life)
      const ended = asking.catch((error: unknown) => error)
      await Promise.resolve()
      expect(signals.length).toBe(ask === 'transcribe' ? 2 : 1)
      expect(signals.some(signal => signal.aborted)).toBe(false)
      life.end()
      expect(await ended).toBeInstanceOf(LifetimeEnded)
      expect(signals.every(signal => signal.aborted)).toBe(true)
    }
  })

  it('gives a recording longer to arrive than a question', async () => {
    const waits: number[] = []
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => (waits.push(ms), new AbortController().signal))
    const { router } = ready(json({ text: 'x' }), json({}))
    await router.transcribe({ pcm: tone(), seconds: 0.1 })
    await router.model.choose({ words: 'x', options: [] })
    timeout.mockRestore()
    expect(waits).toEqual([30_000, 12_000])
  })

  it('reports any other answer as a plain failure', async () => {
    const { router } = ready(json({ error: 'bad request' }, 400))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toContain('not said')
  })
})
