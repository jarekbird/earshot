const real = globalThis.fetch
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])

globalThis.fetch = (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : String(input))
  if (!LOCAL.has(hostname)) return Promise.reject(new Error(`E4: a test called ${hostname}. Tests call no outside service.`))
  return real(input, init)
}
