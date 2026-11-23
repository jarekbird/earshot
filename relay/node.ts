import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { relay, relayOptions, type RelayOptions } from './relay.js'

export interface ServeOptions extends RelayOptions {
  port?: number
  hostname?: string
}

const PORT = 8787

export function serve({ port = PORT, hostname, ...options }: ServeOptions): Promise<Server> {
  const handle = relay(options)
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value)
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
      const request = new Request(`http://${incoming.headers.host ?? 'relay'}${incoming.url ?? '/'}`, {
        method: incoming.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit)
      const response = await handle(request)
      response.headers.forEach((value, name) => outgoing.setHeader(name, value))
      outgoing.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500).end()
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
    ...relayOptions({ key: need('EARSHOT_RELAY_KEY'), upstream: need('EARSHOT_RELAY_UPSTREAM'), models: env.EARSHOT_RELAY_MODELS }),
    port: Number(env.PORT) || PORT,
    ...(env.HOST ? { hostname: env.HOST } : {}),
  }
}
