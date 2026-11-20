import ts from 'typescript'
import { originOf } from './manifest.js'

const NAMESPACE = /^https?:\/\/www\.w3\.org\//
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/|^\/\/(?=[a-z0-9-]+\.|\u0000)/gi
const END = /[\s"'`<>\\]/
const UNKNOWN = '\u0000'

export function allowed(whitelist: readonly string[], text: string): boolean {
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

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken

export function stringsOf(code: string): string[] {
  const source = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const out: string[] = []
  let opaque: ts.Node[] = []
  const text = (node: ts.Node): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node))
      return node.head.text + node.templateSpans.map(span => text(span.expression) + span.literal.text).join('')
    if (ts.isParenthesizedExpression(node)) return text(node.expression)
    if (isPlus(node)) return text(node.left) + text(node.right)
    opaque.push(node)
    return UNKNOWN
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || isPlus(node)) {
      opaque = []
      const value = text(node)
      const inner = opaque
      if (value.replaceAll(UNKNOWN, '') !== '') out.push(value)
      inner.forEach(visit)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

export function outsideScript(whitelist: readonly string[], code: string): string[] {
  return stringsOf(code).flatMap(value => outside(whitelist, value))
}

const jsonStrings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.values(value).flatMap(jsonStrings) : []

export function scan(whitelist: readonly string[], file: string, text: string): string[] {
  if (/\.[cm]?js$/.test(file)) return outsideScript(whitelist, text)
  if (file.endsWith('.json')) {
    try {
      return jsonStrings(JSON.parse(text)).flatMap(value => outside(whitelist, value))
    } catch {
      return outside(whitelist, text)
    }
  }
  return outside(whitelist, text)
}
