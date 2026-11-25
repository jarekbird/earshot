import { splitPcm, toWav, type Audio } from '../audio.js'
import type { Compact } from '../context.js'
import type { NavigatorModel, Option } from '../navigator.js'
import { LifetimeEnded, type Lifetime } from '../lifetime.js'
import { RelayError, SayError } from '../say.js'
import { relayAddress } from '../relayAddress.js'

export interface OpenRouterModels {
  speech: string
  decide: string
  compact: string
}

export interface OpenRouterOptions {
  host: string
  secret?: string
  models?: Partial<OpenRouterModels>
  language?: string
  fetch?: typeof fetch
  now?: () => number
}

export interface OpenRouter {
  transcribe(audio: Audio, life?: Lifetime): Promise<string>
  model: NavigatorModel
  compact: Compact
}

export const MODELS: OpenRouterModels = {
  speech: 'openai/whisper-large-v3-turbo',
  decide: 'typesafe/jev-1.14',
  compact: 'mistralai/mistral-nemo',
}
const TIMEOUT_MS = 12_000
const SPEECH_TIMEOUT_MS = 30_000
const SPEECH_PART_S = 60
const HOLD_BACK_MS = 30_000
const REFUSALS: Record<number, string> = {
  401: 'Voice is off for now',
  402: 'Voice is off for now',
  403: 'Voice is off for now',
  429: 'Too many requests',
}
const NO_CONNECTION = 'No connection'
const BUSY = 'The service is busy'

// This wording picked the wanted option on 12 of 12 test phrases with typesafe/jev-1.14 on 2026-11-20.
const INSTRUCTIONS =
  'A person wearing smart glasses said the words in the state to an app. Choose what they meant. Match on meaning, not only on the same words: a description or a detail of an item counts as asking for it.'

function describe({ say, context, role }: Option): string {
  if (role === 'none') return 'The person asked for a screen or an action that is not in this list.'
  if (role === 'pass')
    return `The words are not a request to go somewhere or do one of these. They are: ${say.charAt(0).toLowerCase()}${say.slice(1)}.`
  return context ? `${say}. About it: ${context}` : say
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

const NOT_ALONE = 'A relay that is told a secret is named by its address alone, with https: no query, no fragment, no name or password.'

function sealed(host: string): string {
  const relay = relayAddress(host, { alone: NOT_ALONE, sealed: 'The calls carry a secret, so their relay is named with https.' })
  return `${relay.origin}${relay.pathname.replace(/\/+$/, '')}`
}

export function openRouter(options: OpenRouterOptions): OpenRouter {
  const { secret } = options
  const host = secret === undefined ? options.host.replace(/\/+$/, '') : sealed(options.host)
  const models = { ...MODELS, ...options.models }
  const now = options.now ?? Date.now
  let heldBack: { until: number; say: string } | undefined

  function within(ms: number, life?: Lifetime): { signal: AbortSignal; done: () => void } {
    const timeout = AbortSignal.timeout(ms)
    if (!life) return { signal: timeout, done: () => {} }
    const both = new AbortController()
    const timedOut = () => both.abort(timeout.reason)
    const ended = () => both.abort(new LifetimeEnded())
    timeout.addEventListener('abort', timedOut)
    life.signal.addEventListener('abort', ended)
    if (life.ended) ended()
    return {
      signal: both.signal,
      done: () => {
        timeout.removeEventListener('abort', timedOut)
        life.signal.removeEventListener('abort', ended)
      },
    }
  }

  async function call(path: string, body: Record<string, unknown>, ms: number, life?: Lifetime): Promise<Record<string, unknown>> {
    if (heldBack && now() < heldBack.until) throw new SayError(heldBack.say)
    const { signal, done } = within(ms, life)
    let response: Response | undefined
    let moved: { status?: number } | undefined
    try {
      const answered = await (options.fetch ?? fetch)(`${host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(secret === undefined ? body : { ...body, secret }),
        // Fact: Cloudflare's runtime refuses redirect: 'error'. With 'manual' every runtime hands back the redirect itself.
        ...(secret === undefined ? {} : { redirect: 'manual' as const }),
        signal,
      })
      const elsewhere = answered.status >= 300 && answered.status < 400
      const redirected = secret !== undefined && (answered.type === 'opaqueredirect' || elsewhere)
      if (redirected || life?.ended) void answered.body?.cancel().catch(() => {})
      if (life?.ended) throw new LifetimeEnded()
      if (redirected) moved = elsewhere ? { status: answered.status } : {}
      else response = answered
      if (response?.ok) {
        let stopped = () => {}
        const over = new Promise<never>((_, stop) => {
          stopped = () => stop(signal.reason)
          if (signal.aborted) stopped()
          else signal.addEventListener('abort', stopped, { once: true })
        })
        const read = (await Promise.race([response.json(), over]).finally(() => signal.removeEventListener('abort', stopped))) as Record<
          string,
          unknown
        >
        if (life?.ended) throw new LifetimeEnded()
        return read
      }
    } catch (failure) {
      const cause = secret === undefined ? failure : undefined
      if (life?.ended) throw new LifetimeEnded()
      if (response) throw new RelayError(`The answer of the relay to ${path} could not be read.`, response.status, cause)
      throw new SayError(NO_CONNECTION, cause === undefined ? {} : { cause })
    } finally {
      done()
    }
    if (!response) throw new SayError(NO_CONNECTION, moved)
    void response.body?.cancel().catch(() => {})
    if (life?.ended) throw new LifetimeEnded()
    const { status } = response
    const say = REFUSALS[status] ?? (status >= 500 ? BUSY : undefined)
    if (!say) throw new RelayError(`The relay answered ${status} to ${path}.`, status)
    heldBack = { until: now() + HOLD_BACK_MS, say }
    throw new SayError(say, { status })
  }

  return {
    async transcribe(audio, life) {
      const parts = await Promise.all(
        splitPcm(audio.pcm, SPEECH_PART_S).map(async pcm => {
          const answer = await call(
            '/api/v1/audio/transcriptions',
            {
              model: models.speech,
              input_audio: { data: base64(toWav(pcm)), format: 'wav' },
              ...(options.language ? { language: options.language } : {}),
            },
            SPEECH_TIMEOUT_MS,
            life,
          )
          return typeof answer.text === 'string' ? answer.text.trim() : ''
        }),
      )
      return parts.filter(Boolean).join(' ')
    },

    model: {
      async choose(question, life) {
        const criteria = Object.fromEntries(question.options.map(option => [option.id, describe(option)]))
        const answer = await call(
          '/api/alpha/decisions',
          {
            model: models.decide,
            state: `The user said: "${question.words}"${question.screen ? `\nOn the screen: ${question.screen}` : ''}`,
            questions: { pick: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
          },
          TIMEOUT_MS,
          life,
        )
        const pick = (answer.answers as { pick?: { type?: string; probabilities?: Record<string, number> } } | undefined)?.pick
        return pick?.type === 'choice' && pick.probabilities ? pick.probabilities : {}
      },
    },

    async compact(text, limit) {
      const answer = await call(
        '/api/v1/chat/completions',
        {
          model: models.compact,
          max_tokens: Math.ceil(limit / 2),
          messages: [
            {
              role: 'system',
              content: `Shorten the user's text to at most ${limit} characters. Keep names, numbers and what happened last. Answer with the shortened text only.`,
            },
            { role: 'user', content: text },
          ],
        },
        TIMEOUT_MS,
      )
      const content = (answer.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('No shorter text came back.')
      return content.trim()
    },
  }
}
