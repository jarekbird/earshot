import { describe, expect, it } from 'vitest'
import { outside, outsideScript, scan } from './urls.js'

const whitelist = ['https://api.example.invalid', 'wss://api.example.invalid']

describe('the URL scan', () => {
  it('accepts the listed origins', () => {
    expect(outside(whitelist, '"wss://api.example.invalid/v1/room" "https://api.example.invalid/health"')).toEqual([])
  })

  it('rejects other hosts, schemes, ports and look-alikes', () => {
    const urls = [
      'https://attacker.invalid/x',
      'http://api.example.invalid/x',
      'https://api.example.invalid:8443/x',
      'https://api.example.invalid.attacker.invalid/x',
      'ftp://api.example.invalid/x',
    ]
    expect(outside(whitelist, urls.join(' '))).toEqual(urls)
  })

  it('rejects credentials that hide another host', () => {
    const url = 'https://api.example.invalid:password@attacker.invalid/upload'
    expect(outside(whitelist, `<a href="${url}">`)).toEqual([url])
  })

  it('accepts hosts under a wildcard entry, on any port, and nothing else', () => {
    const wild = ['https://*.example.invalid']
    expect(outside(wild, 'https://a.example.invalid/x https://a.b.example.invalid:8443/x')).toEqual([])
    const urls = [
      'https://example.invalid/x',
      'https://badexample.invalid/x',
      'wss://a.example.invalid/x',
      'https://a.example.invalid.attacker.invalid/x',
    ]
    expect(outside(wild, urls.join(' '))).toEqual(urls)
  })

  it('ignores XML namespaces', () => {
    expect(outside(whitelist, '<svg xmlns="http://www.w3.org/2000/svg">')).toEqual([])
  })

  it('treats a whitelist entry it cannot read as allowing nothing', () => {
    expect(outside(['not an origin'], 'https://api.example.invalid/x')).toEqual(['https://api.example.invalid/x'])
  })
})

describe('the URL scan reads scripts as JavaScript', () => {
  it('accepts listed URLs, also when built from parts', () => {
    expect(outsideScript(whitelist, 'fetch("https://api.example.invalid/health")')).toEqual([])
    expect(outsideScript(whitelist, 'const u = "wss://api.example.invalid" + "/v1/" + room')).toEqual([])
    expect(outsideScript(whitelist, 'const u = `wss://api.example.invalid/v1/${room}`')).toEqual([])
  })

  it('rejects URLs split across concatenation or templates', () => {
    expect(outsideScript(whitelist, 'fetch("https:" + "//attacker.invalid/x")')).toHaveLength(1)
    expect(outsideScript(whitelist, 'fetch(`https://attacker${".invalid"}/x`)')).toHaveLength(1)
  })

  it('rejects URLs whose host is only known at run time', () => {
    expect(outsideScript(whitelist, 'fetch("https://" + host + "/x")')).toHaveLength(1)
    expect(outsideScript(whitelist, 'new WebSocket(`wss://${host}/v1`)')).toHaveLength(1)
    expect(outsideScript(whitelist, 'fetch("https://api.example.invalid" + suffix)')).toHaveLength(1)
    expect(outsideScript(whitelist, 'fetch(`https://api.example.invalid:${port}/x`)')).toHaveLength(1)
  })

  it('reads strings inside expressions that are part of a concatenation', () => {
    expect(outsideScript(whitelist, 'fetch(new URL("/upload", "https://attacker.invalid").href + "?x=1")')).toHaveLength(1)
    expect(outsideScript(whitelist, 'const u = `${f("https://attacker.invalid")}/x`')).toHaveLength(1)
  })

  it('rejects a URL inside another URL', () => {
    const inner = 'const u = "https://api.example.invalid/redirect?target=" + "https://attacker.invalid/upload"'
    expect(outsideScript(whitelist, inner)).toEqual(['https://attacker.invalid/upload'])
    expect(outside(whitelist, 'https://api.example.invalid/r?to=wss://attacker.invalid')).toEqual(['wss://attacker.invalid'])
  })

  it('rejects protocol-relative URLs to another host', () => {
    expect(outsideScript(whitelist, 'fetch("//attacker.invalid/x")')).toHaveLength(1)
    expect(outsideScript(whitelist, 'fetch("//" + host + "/upload")')).toHaveLength(1)
    expect(outsideScript(whitelist, 'fetch(`//${host}/upload`)')).toHaveLength(1)
  })

  it('ignores comments and the "//" in ordinary strings', () => {
    expect(outsideScript(whitelist, '// see https://attacker.invalid\nconst u = "a//b"')).toEqual([])
  })

  it('reads JSON values, and scans HTML, CSS and broken JSON as text', () => {
    expect(scan(whitelist, 'a.json', '{"u": ["https://attacker.invalid"]}')).toHaveLength(1)
    expect(scan(whitelist, 'a.json', '{"u": "https://attacker.invalid"')).toHaveLength(1)
    expect(scan(whitelist, 'index.html', '<script src="https://attacker.invalid/x.js"></script>')).toHaveLength(1)
    expect(scan(whitelist, 'a.css', '@import url(https://attacker.invalid/a.css);')).toHaveLength(1)
    expect(scan(whitelist, 'a.mjs', 'fetch("https:" + "//attacker.invalid/x")')).toHaveLength(1)
  })
})
