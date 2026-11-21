import { toWav, type Audio } from '../audio.js'
import type { Compact } from '../context.js'
import type { NavigatorModel, Option } from '../navigator.js'
import { SayError } from '../say.js'

export interface OpenRouterModels {
  speech: string
  decide: string
  compact: string
}

export interface OpenRouterOptions {
  host: string
  models?: Partial<OpenRouterModels>
  language?: string
  fetch?: typeof fetch
  now?: () => number
}

export interface OpenRouter {
  transcribe(audio: Audio): Promise<string>
  model: NavigatorModel
  compact: Compact
}

export const MODELS: OpenRouterModels = {
  speech: 'openai/whisper-large-v3-turbo',
  decide: 'typesafe/jev-1.14',
  compact: 'mistralai/mistral-nemo',
}
const TIMEOUT_MS = 12_000
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

export function openRouter(options: OpenRouterOptions): OpenRouter {
  const host = options.host.replace(/\/+$/, '')
  const models = { ...MODELS, ...options.models }
  const now = options.now ?? Date.now
  let heldBack: { until: number; say: string } | undefined

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (heldBack && now() < heldBack.until) throw new SayError(heldBack.say)
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`${host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new SayError(NO_CONNECTION)
    }
    if (response.ok) return (await response.json()) as Record<string, unknown>
    const say = REFUSALS[response.status] ?? (response.status >= 500 ? BUSY : undefined)
    if (!say) throw new Error(`The relay answered ${response.status} to ${path}.`)
    heldBack = { until: now() + HOLD_BACK_MS, say }
    throw new SayError(say)
  }

  return {
    async transcribe(audio) {
      const answer = await call('/api/v1/audio/transcriptions', {
        model: models.speech,
        input_audio: { data: base64(toWav(audio.pcm)), format: 'wav' },
        ...(options.language ? { language: options.language } : {}),
      })
      return typeof answer.text === 'string' ? answer.text : ''
    },

    model: {
      async choose(question) {
        const criteria = Object.fromEntries(question.options.map(option => [option.id, describe(option)]))
        const answer = await call('/api/alpha/decisions', {
          model: models.decide,
          state: `The user said: "${question.words}"${question.screen ? `\nOn the screen: ${question.screen}` : ''}`,
          questions: { pick: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
        })
        const pick = (answer.answers as { pick?: { type?: string; probabilities?: Record<string, number> } } | undefined)?.pick
        return pick?.type === 'choice' && pick.probabilities ? pick.probabilities : {}
      },
    },

    async compact(text, limit) {
      const answer = await call('/api/v1/chat/completions', {
        model: models.compact,
        max_tokens: Math.ceil(limit / 2),
        messages: [
          {
            role: 'system',
            content: `Shorten the user's text to at most ${limit} characters. Keep names, numbers and what happened last. Answer with the shortened text only.`,
          },
          { role: 'user', content: text },
        ],
      })
      const content = (answer.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('No shorter text came back.')
      return content.trim()
    },
  }
}
