import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { WebSocket as Upstream, WebSocketServer, type ServerOptions } from 'ws'
import { GOODBYE_MS, LIVE_PATH, MAX_FRAME } from './limits.js'
import { relay, relayOptions, type Line, type RelayOptions, type Sockets } from './relay.js'

export interface ServeOptions extends RelayOptions {
  port?: number
  hostname?: string
}

const PORT = 8787

function requestOf(incoming: IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value)
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
  return new Request(`http://${incoming.headers.host ?? 'relay'}${incoming.url ?? '/'}`, {
    method: incoming.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit)
}

const UNHEARD = () => {}

// Fact: Node's own WebSocket cannot drop a connection it is still making, so the upstream is opened with ws, which can.
const dial: Sockets['dial'] = (url, headers, stop, opened) =>
  new Promise((done, failed) => {
    const line = new Upstream(url, { headers, maxPayload: MAX_FRAME })
    const drop = () => line.terminate()
    stop.addEventListener('abort', drop)
    line.on('error', () => {
      failed(new Error('The upstream could not be reached.'))
      line.terminate()
    })
    line.once('close', () => failed(new Error('The upstream closed.')))
    // Fact: ws hands on what came with the opening before a promise made at the opening is read, so the line is handed on here.
    line.once('open', () => {
      opened(line as Line)
      done()
    })
    if (stop.aborted) drop()
  })

interface Upgrade {
  incoming: IncomingMessage
  socket: Duplex
  head: Buffer
  taken: boolean
}

export function serve({ port = PORT, hostname, ...options }: ServeOptions): Promise<Server> {
  // Fact: ws waits thirty seconds for a peer to answer a close unless told otherwise; its types do not know the setting yet.
  const taking: ServerOptions & { closeTimeout: number } = { noServer: true, maxPayload: MAX_FRAME, closeTimeout: GOODBYE_MS }
  const lines = new WebSocketServer(taking)
  const upgrades = new WeakMap<Request, Upgrade>()
  let closing = new AbortController()
  const handle = relay(options, {
    dial,
    accept: request =>
      new Promise((done, failed) => {
        const upgrade = upgrades.get(request)
        if (!upgrade) return failed(new Error('Not an upgrade this server was given.'))
        upgrade.taken = true
        lines.handleUpgrade(upgrade.incoming, upgrade.socket, upgrade.head, line => {
          line.on('error', UNHEARD)
          done({ line: line as Line, response: new Response(null) })
        })
      }),
    get closing() {
      return closing.signal
    },
  })
  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(requestOf(incoming))
      response.headers.forEach((value, name) => outgoing.setHeader(name, value))
      outgoing.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  const upgraded = async (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const others = server.listenerCount('upgrade') > 1
    if (others && (incoming.url ?? '').split('?')[0] !== LIVE_PATH) return
    const upgrade = { incoming, socket, head, taken: false }
    try {
      const request = requestOf(incoming)
      upgrades.set(request, upgrade)
      const response = await handle(request)
      if (upgrade.taken) return
      const body = await response.text()
      socket.end(
        `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status]}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    } catch {
      socket.destroy()
    }
  }
  if (options.live) server.on('upgrade', upgraded)
  server.on('listening', () => void (closing = new AbortController()))
  const stop = server.close.bind(server)
  server.close = done => {
    closing.abort()
    return stop(done)
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => resolve(server))
  })
}

export function settings(env: Record<string, string | undefined>): ServeOptions {
  return {
    ...relayOptions({
      key: env.EARSHOT_RELAY_KEY,
      upstream: env.EARSHOT_RELAY_UPSTREAM,
      models: env.EARSHOT_RELAY_MODELS,
      liveUpstream: env.EARSHOT_RELAY_LIVE_UPSTREAM,
      liveKey: env.EARSHOT_RELAY_LIVE_KEY,
      liveModels: env.EARSHOT_RELAY_LIVE_MODELS,
      secret: env.EARSHOT_RELAY_SECRET,
    }),
    port: Number(env.PORT) || PORT,
    ...(env.HOST ? { hostname: env.HOST } : {}),
  }
}
