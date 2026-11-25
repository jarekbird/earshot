import { parse } from 'acorn'
import { originOf } from './manifest.js'

const NAMESPACE = /^https?:\/\/www\.w3\.org\//
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/|^\/\/(?=[a-z0-9-]+\.|\u0000)/gi
const END = /[\s"'`<>\\]/
const UNKNOWN = '\u0000'

function allowed(whitelist: readonly string[], text: string): boolean {
  const authority = text
    .replace(/^[a-z][a-z0-9+.-]*:/i, '')
    .slice(2)
    .split(/[/?#]/)[0]
  if (authority.includes(UNKNOWN)) return false
  let url: URL
  try {
    url = new URL(text.startsWith('//') ? `https:${text}` : text)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  return whitelist.some(entry => {
    const rule = originOf(entry)
    if (!rule || rule.protocol !== url.protocol) return false
    if (entry.includes('://*.')) return url.hostname.endsWith(rule.hostname.replace(/^wildcard/, ''))
    return url.host === rule.host
  })
}

const urlsIn = (text: string): string[] =>
  [...text.matchAll(SCHEME)]
    .map(match => {
      const rest = text.slice(match.index)
      const end = rest.slice(match[0].length).search(END)
      return (end < 0 ? rest : rest.slice(0, match[0].length + end)).replace(/[),;]+$/, '')
    })
    .filter(url => !NAMESPACE.test(url))

export function outside(whitelist: readonly string[], text: string): string[] {
  return urlsIn(text).filter(url => !allowed(whitelist, url))
}

interface Node {
  type: string
  [key: string]: unknown
}

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
const isPlus = (node: Node) => node.type === 'BinaryExpression' && node.operator === '+'
const isText = (node: Node) => node.type === 'Literal' && typeof node.value === 'string'
const isStringy = (node: Node) => isText(node) || node.type === 'TemplateLiteral' || isPlus(node)

const childrenOf = (node: Node): Node[] =>
  Object.values(node).flatMap(value => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []))

function joined(node: Node): Node[] {
  const parts: Node[] = []
  const pending = [node]
  while (pending.length) {
    const next = pending.pop() as Node
    if (isPlus(next)) pending.push(next.right as Node, next.left as Node)
    else parts.push(next)
  }
  return parts
}

function program(code: string): Node | null {
  for (const sourceType of ['module', 'script'] as const) {
    try {
      return parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true }) as unknown as Node
    } catch {
      continue
    }
  }
  return null
}

function stringsOf(code: string): string[] | null {
  const root = program(code)
  if (!root) return null
  const out: string[] = []
  let opaque: Node[] = []
  const text = (node: Node): string => {
    if (isText(node)) return node.value as string
    if (node.type === 'TemplateLiteral') {
      const quasis = node.quasis as { value: { cooked: string | null } }[]
      const expressions = node.expressions as Node[]
      return quasis.map((quasi, i) => (quasi.value.cooked ?? UNKNOWN) + (i < expressions.length ? text(expressions[i]) : '')).join('')
    }
    if (isPlus(node)) return joined(node).map(text).join('')
    opaque.push(node)
    return UNKNOWN
  }
  const pending = [root]
  while (pending.length) {
    const node = pending.pop() as Node
    if (!isStringy(node)) {
      pending.push(...childrenOf(node).reverse())
      continue
    }
    opaque = []
    const value = text(node)
    if (value.replaceAll(UNKNOWN, '') !== '') out.push(value)
    pending.push(...opaque.reverse())
  }
  return out
}

export function outsideScript(whitelist: readonly string[], code: string): string[] | null {
  return stringsOf(code)?.flatMap(value => outside(whitelist, value)) ?? null
}

export interface Scan {
  urls: string[]
  read: boolean
}

const jsonStrings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.values(value).flatMap(jsonStrings) : []

export function scan(whitelist: readonly string[], file: string, text: string): Scan {
  const asText = (read: boolean): Scan => ({ urls: outside(whitelist, text), read })
  if (/\.[cm]?js$/.test(file)) {
    const urls = outsideScript(whitelist, text)
    return urls ? { urls, read: true } : asText(false)
  }
  if (!file.endsWith('.json')) return asText(true)
  try {
    return { urls: jsonStrings(JSON.parse(text)).flatMap(value => outside(whitelist, value)), read: true }
  } catch {
    return asText(true)
  }
}
