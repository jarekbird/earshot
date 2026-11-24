import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { WebSocket as Upstream, WebSocketServer } from 'ws'
import { MAX_FRAME, relay, relayOptions, type Line, type RelayOptions, type Sockets } from './relay.js'

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
    line.on('error', () => failed(new Error('The upstream could not be reached.')))
    line.once('close', () => failed(new Error('The upstream closed.')))
    // Fact: ws hands on what came with the opening before a promise made at the opening is read, so the line is handed on here.
    line.once('open', () => {
      stop.removeEventListener('abort', drop)
      opened(line as Line)
      done()
    })
    if (stop.aborted) drop()
  })

export function serve({ port = PORT, hostname, ...options }: ServeOptions): Promise<Server> {
  const handle = relay(options)
  const lines = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(requestOf(incoming))
      response.headers.forEach((value, name) => outgoing.setHeader(name, value))
      outgoing.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  server.on('upgrade', async (incoming, socket, head) => {
    let taken = false
    const accept: Sockets['accept'] = () => {
      taken = true
      return new Promise(done =>
        lines.handleUpgrade(incoming, socket, head, line => {
          line.on('error', UNHEARD)
          done({ line: line as Line, response: new Response(null) })
        }),
      )
    }
    try {
      const response = await handle(requestOf(incoming), { accept, dial })
      if (taken) return
      const body = await response.text()
      socket.end(
        `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status]}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
    } catch {
      socket.destroy()
    }
  })
  const stop = server.close.bind(server)
  server.close = done => {
    for (const line of lines.clients) line.close(1001)
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
