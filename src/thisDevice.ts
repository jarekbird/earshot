// Fact: a URL writes an IPv4 address inside IPv6 in hex, so 127.0.0.1 there reads [::ffff:7f00:1].
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\])$/

export const onThisDevice = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || LOOPBACK.test(hostname)
