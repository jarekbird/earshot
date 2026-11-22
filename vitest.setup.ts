import net from 'node:net'

const isLocal = (host: string) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
const refused = (host: string) => new Error(`E4: a test called ${host}. Tests call no outside service.`)

const isPath = (first: unknown) => typeof first === 'string' && !(Number(first) >= 0)

function hostOf(args: unknown[]): string {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (isPath(first)) return 'localhost'
  if (typeof first === 'object' && first !== null) {
    const { host, path } = first as { host?: string; path?: string }
    return path ? 'localhost' : (host ?? 'localhost')
  }
  return typeof args[1] === 'string' ? args[1] : 'localhost'
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const host = hostOf(args)
  if (!isLocal(host)) throw refused(host)
  return connect.apply(this, args as never)
} as typeof connect

const real = globalThis.fetch
globalThis.fetch = (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : String(input))
  return isLocal(hostname) ? real(input, init) : Promise.reject(refused(hostname))
}
