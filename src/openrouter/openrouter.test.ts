import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SayError } from '../say.js'
import { createStore, memoryPlace } from '../store.js'
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

async function signedIn(...answers: (Response | Error)[]) {
  const store = createStore([memoryPlace()])
  await store.set('earshot.openrouter.key', 'sk-test')
  const { sent, fetcher } = service(...answers)
  return { store, sent, router: openRouter({ host: 'https://openrouter.example', store, fetch: fetcher }) }
}

describe('speech to text', () => {
  it('sends the recording as a sound file to the host the app named, with the user key, and gives the words', async () => {
    const { sent, router } = await signedIn(json({ text: ' open the second note ' }))
    expect(await router.transcribe({ pcm: tone(), seconds: 0.1 })).toBe(' open the second note ')
    expect(sent.length).toBe(1)
    expect(sent[0].url).toBe('https://openrouter.example/api/v1/audio/transcriptions')
    expect(sent[0].key).toBe('Bearer sk-test')
    const audio = sent[0].body.input_audio as { data: string; format: string }
    expect(sent[0].body.model).toBe('openai/whisper-large-v3-turbo')
    expect(audio.format).toBe('wav')
    expect(atob(audio.data).slice(0, 4)).toBe('RIFF')
    expect(atob(audio.data).length).toBe(44 + 3_200)
  })

  it('uses the model and the language the app chose', async () => {
    const store = createStore([memoryPlace()])
    await store.set('earshot.openrouter.key', 'sk-test')
    const { sent, fetcher } = service(json({ text: 'hallo' }))
    const router = openRouter({
      host: 'https://openrouter.example',
      store,
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
    const { sent, router } = await signedIn(json(answer))
    expect(await router.model.choose(question)).toEqual({ o0: 0.01, o1: 0.09, o2: 0.9 })
    expect(sent[0].url).toBe('https://openrouter.example/api/alpha/decisions')
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
    const { router } = await signedIn(json({ answers: { pick: { type: 'refusal' } } }), json({ answers: {} }))
    expect(await router.model.choose(question)).toEqual({})
    expect(await router.model.choose(question)).toEqual({})
  })
})

describe('compaction', () => {
  it('asks for a shorter text within the limit and gives it back', async () => {
    const { sent, router } = await signedIn(json({ choices: [{ message: { content: ' The short version. ' } }] }))
    expect(await router.compact('a very long text', 400)).toBe('The short version.')
    expect(sent[0].url).toBe('https://openrouter.example/api/v1/chat/completions')
    const messages = sent[0].body.messages as { role: string; content: string }[]
    expect(messages[0].content).toContain('400 characters')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'a very long text' })
  })

  it('fails when nothing comes back, so the last characters are used', async () => {
    const { router } = await signedIn(json({ choices: [] }))
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

  it('calls nothing without a key, and says to set voice up on the phone', async () => {
    const { sent, fetcher } = service()
    const router = openRouter({ host: 'https://openrouter.example', store: createStore([memoryPlace()]), fetch: fetcher })
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe('Set up voice on your phone')
    expect(sent).toEqual([])
  })

  it('says there is no connection when the call cannot be made', async () => {
    const { router } = await signedIn(new TypeError('Failed to fetch'))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe('No connection')
  })

  it('gives a short reason for a refused key, no credit, too many calls and a busy service', async () => {
    for (const [status, reason] of [
      [401, 'Sign in again on your phone'],
      [403, 'Sign in again on your phone'],
      [402, 'Out of credit'],
      [429, 'Too many requests'],
      [503, 'The service is busy'],
    ] as const) {
      const { router } = await signedIn(json({ error: 'x' }, status))
      expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe(reason)
    }
  })

  it('stops calling for a while after such a refusal, then calls again', async () => {
    const { sent, router } = await signedIn(json({}, 429), json({ text: 'again' }))
    const once = () => said(router.transcribe({ pcm: tone(), seconds: 0.1 }))
    expect(await once()).toBe('Too many requests')
    expect(await once()).toBe('Too many requests')
    expect(sent.length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await once()).toBe('nothing wrong')
    expect(sent.length).toBe(2)
  })

  it('does not hold back after a lost connection', async () => {
    const { sent, router } = await signedIn(new TypeError('Failed to fetch'), json({ text: 'again' }))
    await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toBe('nothing wrong')
    expect(sent.length).toBe(2)
  })

  it('reports any other answer as a plain failure', async () => {
    const { router } = await signedIn(json({ error: 'bad request' }, 400))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toContain('not said')
  })
})

describe('signing in', () => {
  const setup = (...answers: (Response | Error)[]) => {
    const store = createStore([memoryPlace()])
    const { sent, fetcher } = service(...answers)
    return { store, sent, router: openRouter({ host: 'https://openrouter.example', store, fetch: fetcher }) }
  }

  it('makes a sign-in address with a fresh challenge, and keeps the secret half on the device', async () => {
    const { store, router } = setup()
    const first = new URL(await router.signInUrl({ callbackUrl: 'https://app.example/back', label: 'My app' }))
    expect(first.origin + first.pathname).toBe('https://openrouter.example/auth')
    expect(first.searchParams.get('callback_url')).toBe('https://app.example/back')
    expect(first.searchParams.get('code_challenge_method')).toBe('S256')
    expect(first.searchParams.get('key_label')).toBe('My app')
    expect(first.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const verifier = await store.get('earshot.openrouter.verifier')
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(first.href).not.toContain(verifier)
    const second = new URL(await router.signInUrl())
    expect(second.searchParams.get('code_challenge')).not.toBe(first.searchParams.get('code_challenge'))
    expect(second.searchParams.has('callback_url')).toBe(false)
  })

  it('trades the code for a key, stores it, and is then signed in', async () => {
    const { store, sent, router } = setup(json({ key: 'sk-new' }))
    await router.signInUrl()
    const verifier = await store.get('earshot.openrouter.verifier')
    expect(await router.signedIn()).toBe(false)
    expect(await router.finishSignIn('https://app.example/back?code=abc123')).toBe(true)
    expect(sent[0].url).toBe('https://openrouter.example/api/v1/auth/keys')
    expect(sent[0].key).toBeNull()
    expect(sent[0].body).toEqual({ code: 'abc123', code_verifier: verifier, code_challenge_method: 'S256' })
    expect(await store.get('earshot.openrouter.key')).toBe('sk-new')
    expect(await store.get('earshot.openrouter.verifier')).toBeNull()
    expect(await router.signedIn()).toBe(true)
  })

  it('takes a code that the user pasted', async () => {
    const { sent, router } = setup(json({ key: 'sk-new' }))
    await router.signInUrl()
    expect(await router.finishSignIn('  abc123 ')).toBe(true)
    expect(sent[0].body.code).toBe('abc123')
  })

  it('is not signed in when there is no code, no sign-in was started, or the code is refused', async () => {
    const { sent, router } = setup(json({ error: 'Invalid code or code_verifier' }, 403))
    expect(await router.finishSignIn('https://app.example/back?other=1')).toBe(false)
    expect(await router.finishSignIn('abc123')).toBe(false)
    expect(sent).toEqual([])
    await router.signInUrl()
    expect(await router.finishSignIn('abc123')).toBe(false)
    expect(await router.signedIn()).toBe(false)
  })

  it('forgets the key on sign-out', async () => {
    const { store, router } = await signedIn()
    await router.signOut()
    expect(await store.get('earshot.openrouter.key')).toBeNull()
    expect(await router.signedIn()).toBe(false)
  })
})
