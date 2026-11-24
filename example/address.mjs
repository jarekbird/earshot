const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]'])
const WRONG = 'EARSHOT_RELAY is the address of your relay alone: https, with no query, no fragment and no name or password.'

export function relayAddress(given) {
  if (!given) return ''
  let relay
  try {
    relay = new URL(given)
  } catch {
    throw new Error(WRONG)
  }
  const plain = relay.protocol === 'http:' && THIS_MACHINE.has(relay.hostname)
  if ((relay.protocol !== 'https:' && !plain) || /[?#]/.test(given) || relay.username || relay.password) throw new Error(WRONG)
  return `${relay.origin}${relay.pathname.replace(/\/+$/, '')}`
}
