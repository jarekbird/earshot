// Fact: a URL writes an IPv4 address inside IPv6 in hex, so 127.0.0.1 there reads [::ffff:7f00:1].
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\])$/
const onThisDevice = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || LOOPBACK.test(hostname)

export function relayAddress(host: string, says: { alone: string; sealed: string }): URL {
  let relay: URL
  try {
    relay = new URL(host)
  } catch {
    throw new Error(says.alone)
  }
  if (relay.protocol !== 'https:' && !(relay.protocol === 'http:' && onThisDevice(relay.hostname))) throw new Error(says.sealed)
  if (/[?#]/.test(host) || relay.username || relay.password) throw new Error(says.alone)
  return relay
}
