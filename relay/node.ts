import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { WebSocketServer } from 'ws'
import { relay, relayOptions, type Line, type RelayOptions, type Sockets } from './relay.js'

export interface ServeOptions extends RelayOptions {
  port?: number
  hostname?: string
}

const PORT = 8787
// Fact: a Worker takes a WebSocket message of one mebibyte at most, so this server takes no more.
const MAX_MESSAGE = 1_048_576

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

// Fact: Node's WebSocket takes headers in its second argument, which the standard one does not.
const dial: Sockets['dial'] = (url, headers) =>
  new Promise((opened, failed) => {
    const line = new WebSocket(url, { headers } as never)
    line.addEventListener('open', () => opened(line as Line))
    line.addEventListener('close', () => failed(new Error('The upstream closed.')))
  })

export function serve({ port = PORT, hostname, ...options }: ServeOptions): Promise<Server> {
  const handle = relay(options)
  const lines = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
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
        lines.handleUpgrade(incoming, socket, head, line => done({ line: line as Line, response: new Response(null) })),
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
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => resolve(server))
  })
}

export function settings(env: Record<string, string | undefined>): ServeOptions {
  const need = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Set ${name}.`)
    return value
  }
  return {
    ...relayOptions({
      key: need('EARSHOT_RELAY_KEY'),
      upstream: need('EARSHOT_RELAY_UPSTREAM'),
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
