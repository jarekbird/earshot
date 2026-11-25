import {
  CLOSES,
  DEFAULT_LIVE_MODELS,
  DIAL_MS,
  HELLO_MS,
  LIVE_PATH,
  MAX_FRAME,
  MAX_HELLO,
  MAX_QUEUED,
  MAX_SECRET,
  MIN_SECRET,
} from './limits.js'

export interface LiveOptions {
  upstream: string
  key: string
  secret: string
  models?: string[]
}

export interface RelayOptions {
  key?: string
  upstream?: string
  models?: string[]
  live?: LiveOptions
  maxBytes?: number
  fetch?: typeof fetch
}

export interface RelaySettings {
  key: string | undefined
  upstream: string | undefined
  models: string | undefined
  liveUpstream: string | undefined
  liveKey: string | undefined
  liveModels: string | undefined
  secret: string | undefined
}

export interface Line {
  binaryType: string
  readonly bufferedAmount?: number
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', heard: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', closed: (event: { code: number }) => void): void
}

export interface Sockets {
  accept(request: Request): Promise<{ line: Line; response: Response }>
  dial(url: string, headers: Record<string, string>, stop: AbortSignal, opened: (line: Line) => void): Promise<void>
  readonly closing?: AbortSignal
}

const listed = (models: string | undefined) => {
  const names = models
    ?.split(',')
    .map(model => model.trim())
    .filter(Boolean)
  return names?.length ? { models: names } : {}
}

export function relayOptions({ key, upstream, models, liveUpstream, liveKey, liveModels, secret }: RelaySettings): RelayOptions {
  return {
    ...(key !== undefined || upstream !== undefined ? { key, upstream } : {}),
    ...listed(models),
    ...(liveUpstream ? { live: { upstream: liveUpstream, key: liveKey ?? '', secret: secret ?? '', ...listed(liveModels) } } : {}),
  }
}

export const DEFAULT_MODELS = ['openai/whisper-large-v3-turbo', 'typesafe/jev-1.14', 'mistralai/mistral-nemo']

const SPEECH = '/api/v1/audio/transcriptions'
const FIELDS = new Map([
  [SPEECH, ['model', 'input_audio', 'language']],
  ['/api/alpha/decisions', ['model', 'state', 'questions']],
  ['/api/v1/chat/completions', ['model', 'messages', 'max_tokens']],
])
const LIVE_FIELDS = ['model', 'encoding', 'sample_rate', 'eot_threshold', 'eot_timeout_ms', 'eager_eot_threshold']
const KEPT_OUT_OF_TRAINING = ['mip_opt_out', 'true']
const BYTES = new TextEncoder()
// Fact: a URL writes an IPv4 address inside IPv6 in hex, so 127.0.0.1 there reads [::ffff:7f00:1].
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\])$/
const onThisMachine = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || LOOPBACK.test(hostname)
const WHOLE = /^\s*[a-z][a-z0-9+.-]*:\/\//i
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

function same(given: string, wanted: string): boolean {
  let differ = given.length ^ wanted.length
  for (let at = 0; at < wanted.length; at++) differ |= given.charCodeAt(at) ^ wanted.charCodeAt(at)
  return differ === 0
}

function sealed(address: string | undefined, scheme: 'https' | 'wss', what: string): string {
  const plain = scheme === 'https' ? 'http:' : 'ws:'
  let url: URL | undefined
  try {
    url = new URL(address ?? '')
  } catch {
    throw new Error(`${what} needs the address of its upstream.`)
  }
  if (!WHOLE.test(address ?? '')) throw new Error(`${what} needs the address of its upstream.`)
  if (url.protocol !== `${scheme}:` && !(url.protocol === plain && onThisMachine(url.hostname)))
    throw new Error(`${what} sends a key, so its upstream is named with ${scheme}.`)
  return (address ?? '').replace(/\/+$/, '')
}

function checked(live: LiveOptions): LiveOptions {
  if (!live.key) throw new Error('Live speech needs the key of its upstream.')
  if (typeof live.secret !== 'string' || live.secret.length < MIN_SECRET || JSON.stringify(live.secret).length - 2 > MAX_SECRET)
    throw new Error(`Live speech needs a secret of ${MIN_SECRET} to ${MAX_SECRET} characters.`)
  if (/[?#]/.test(sealed(live.upstream, 'wss', 'Live speech'))) throw new Error('Live speech names its upstream with no query.')
  return { ...live, upstream: new URL(live.upstream).href.replace(/\/+$/, '') }
}

function sizeOf(data: unknown): number {
  if (typeof data === 'string') return BYTES.encode(data).length
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength
  const { size } = (data ?? {}) as { size?: unknown }
  return typeof size === 'number' ? size : 0
}

function live(line: Line, sockets: Sockets, { upstream, key, secret, models }: LiveOptions): void {
  const allowed = new Set(models ?? DEFAULT_LIVE_MODELS)
  const reaching = new AbortController()
  let up: Line | undefined
  let greeted = false
  let over = false
  const going = () => end(CLOSES.going)
  const leave = () => {
    over = true
    clearTimeout(waiting)
    sockets.closing?.removeEventListener('abort', going)
    reaching.abort()
    up?.close(1000)
  }
  const end = (code: number) => {
    if (over) return
    leave()
    line.close(code)
  }
  let waiting = setTimeout(() => end(CLOSES.hello), HELLO_MS)
  // Fact: a Worker's WebSocket does not say how much it has queued, so there the runtime's own memory limit is the bound.
  const pass = (to: Line, data: string | ArrayBuffer) => ((to.bufferedAmount ?? 0) > MAX_QUEUED ? end(CLOSES.stalled) : to.send(data))

  const reach = async (url: string) => {
    waiting = setTimeout(() => end(CLOSES.upstream), DIAL_MS)
    try {
      await sockets.dial(url, { 'cf-aig-authorization': `Bearer ${key}` }, reaching.signal, opened => {
        if (over) return opened.close(1000)
        clearTimeout(waiting)
        up = opened
        up.addEventListener('message', ({ data }) => {
          if (over) return
          if (sizeOf(data) > MAX_FRAME) return end(CLOSES.upstream)
          if (typeof data === 'string') pass(line, data)
        })
        up.addEventListener('close', () => end(CLOSES.upstream))
      })
    } catch {
      end(CLOSES.upstream)
    }
  }

  line.binaryType = 'arraybuffer'
  line.addEventListener('close', leave)
  sockets.closing?.addEventListener('abort', going)
  if (sockets.closing?.aborted) going()
  line.addEventListener('message', ({ data }) => {
    if (over) return
    if (sizeOf(data) > MAX_FRAME) return end(CLOSES.big)
    if (greeted) return void (data instanceof ArrayBuffer && up && pass(up, data))
    greeted = true
    clearTimeout(waiting)
    const hello = typeof data === 'string' && data.length <= MAX_HELLO ? parse(data) : null
    if (!hello) return end(CLOSES.hello)
    if (typeof hello.secret !== 'string' || !same(hello.secret, secret)) return end(CLOSES.secret)
    if (typeof hello.model !== 'string' || !allowed.has(hello.model)) return end(CLOSES.model)
    const asked = LIVE_FIELDS.flatMap(field => (typeof hello[field] === 'string' ? [[field, hello[field] as string]] : []))
    void reach(`${upstream}?${new URLSearchParams([...asked, KEPT_OUT_OF_TRAINING])}`)
  })
}

export function relay(options: RelayOptions, sockets?: Sockets): (request: Request) => Promise<Response> {
  const forwards = options.key !== undefined || options.upstream !== undefined
  if (!forwards && !options.live) throw new Error('A relay needs an upstream: for its calls, for live speech, or for both.')
  if (forwards && options.key === undefined && !options.fetch) throw new Error("The relay's calls need the key of their upstream.")
  const upstream = forwards ? sealed(options.upstream, 'https', "The relay's calls") : ''
  const speech = options.live && checked(options.live)
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
    if (pathname === LIVE_PATH && speech) {
      const asksForOne = request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (!asksForOne || !sockets) return refuse(426, 'Only a WebSocket.')
      const { line, response } = await sockets.accept(request)
      live(line, sockets, speech)
      return response
    }
    const fields = forwards ? FIELDS.get(pathname) : undefined
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
        headers: { authorization: `Bearer ${options.key ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify(kept),
        // Fact: Cloudflare's runtime refuses redirect: 'error'. With 'manual' a Worker and Node hand back the redirect itself.
        redirect: 'manual',
        signal: control.signal,
      })
      const moved = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      if (!moved) return answer(response.status, await response.text())
      await response.body?.cancel().catch(() => {})
      return refuse(502, 'The upstream could not be reached.')
    } catch {
      return refuse(502, 'The upstream could not be reached.')
    } finally {
      clearTimeout(timer)
    }
  }
}
