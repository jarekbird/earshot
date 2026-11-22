import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SayError } from '../say.js'
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

  it('reports any other answer as a plain failure', async () => {
    const { router } = ready(json({ error: 'bad request' }, 400))
    expect(await said(router.transcribe({ pcm: tone(), seconds: 0.1 }))).toContain('not said')
  })
})
