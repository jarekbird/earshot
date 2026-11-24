import { relay, relayOptions, type Line, type Sockets } from '../relay/relay.js'

interface Env {
  OPENROUTER_KEY?: string
  UPSTREAM?: string
  MODELS?: string
  LIVE_UPSTREAM?: string
  LIVE_KEY?: string
  LIVE_MODELS?: string
  SECRET?: string
}

type Accepted = Line & { accept(): void }
declare const WebSocketPair: new () => { 0: WebSocket; 1: Accepted }

const sockets: Sockets = {
  async accept() {
    const { 0: caller, 1: line } = new WebSocketPair()
    line.accept()
    return { line, response: new Response(null, { status: 101, webSocket: caller } as ResponseInit) }
  },
  // Fact: a Worker opens a WebSocket with its own headers through fetch, which would follow a redirect unless told not to.
  async dial(url, headers, signal, opened) {
    const { webSocket: line } = (await fetch(url.replace(/^ws/, 'http'), {
      headers: { ...headers, upgrade: 'websocket' },
      redirect: 'manual',
      signal,
    })) as Response & { webSocket: Accepted | null }
    if (!line) throw new Error('The upstream refused.')
    line.accept()
    opened(line)
  },
}

export default {
  fetch: (request: Request, env: Env) =>
    relay(
      relayOptions({
        key: env.OPENROUTER_KEY,
        upstream: env.UPSTREAM,
        models: env.MODELS,
        liveUpstream: env.LIVE_UPSTREAM,
        liveKey: env.LIVE_KEY,
        liveModels: env.LIVE_MODELS,
        secret: env.SECRET,
      }),
      sockets,
    )(request),
}
