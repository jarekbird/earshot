export interface RelayOptions {
  key: string
  upstream: string
  models?: string[]
  maxBytes?: number
  fetch?: typeof fetch
}

export interface RelaySettings {
  key: string
  upstream: string
  models: string | undefined
}

export function relayOptions({ key, upstream, models }: RelaySettings): RelayOptions {
  const listed = models
    ?.split(',')
    .map(model => model.trim())
    .filter(Boolean)
  return { key, upstream, ...(listed?.length ? { models: listed } : {}) }
}

export const DEFAULT_MODELS = ['openai/whisper-large-v3-turbo', 'typesafe/jev-1.14', 'mistralai/mistral-nemo']

const SPEECH = '/api/v1/audio/transcriptions'
const FIELDS = new Map([
  [SPEECH, ['model', 'input_audio', 'language']],
  ['/api/alpha/decisions', ['model', 'state', 'questions']],
  ['/api/v1/chat/completions', ['model', 'messages', 'max_tokens']],
])
const MAX_BYTES = 4_000_000
const WAIT_MS = 10_000
const SPEECH_WAIT_MS = 28_000
const ANY_PAGE = { 'access-control-allow-origin': '*' }

const answer = (status: number, body: string) =>
  new Response(body, { status, headers: { ...ANY_PAGE, 'content-type': 'application/json' } })
const refuse = (status: number, error: string) => answer(status, JSON.stringify({ error }))

async function read(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > limit) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.length
    if (size > limit) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function relay(options: RelayOptions): (request: Request) => Promise<Response> {
  const upstream = options.upstream.replace(/\/+$/, '')
  const models = new Set(options.models ?? DEFAULT_MODELS)
  const limit = options.maxBytes ?? MAX_BYTES

  return async request => {
    const { pathname } = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...ANY_PAGE,
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      })
    }
    const fields = FIELDS.get(pathname)
    if (!fields) return refuse(404, 'Not a call this relay forwards.')
    if (request.method !== 'POST') return refuse(405, 'Only POST.')
    const text = await read(request, limit)
    if (text === null) return refuse(413, 'Too large.')
    const body = parse(text)
    if (!body) return refuse(400, 'Not a JSON object.')
    if (typeof body.model !== 'string' || !models.has(body.model)) return refuse(400, 'Not a model this relay allows.')
    const kept = Object.fromEntries(fields.filter(field => field in body).map(field => [field, body[field]]))
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), pathname === SPEECH ? SPEECH_WAIT_MS : WAIT_MS)
    try {
      const response = await (options.fetch ?? fetch)(`${upstream}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(kept),
        signal: control.signal,
      })
      return answer(response.status, await response.text())
    } catch {
      return refuse(502, 'The upstream could not be reached.')
    } finally {
      clearTimeout(timer)
    }
  }
}
