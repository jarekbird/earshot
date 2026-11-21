import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

const read = (folder: string) => {
  const root = join(import.meta.dirname, '..', folder)
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => ({ file: relative(root, join(root, f)), text: readFileSync(join(root, f), 'utf8') }))
}
const sources = read('src')
const ADDRESS = /\b(?:https?|wss?):\/\/[\w.-]/
const breaking = (pattern: RegExp, allowed: (file: string) => boolean = () => false, among = sources) =>
  among.filter(s => !allowed(s.file) && pattern.test(s.text)).map(s => s.file)

it('finds the sources', () => {
  expect(sources.length).toBeGreaterThan(0)
})

it('E1: only src/glasses imports the Even SDK', () => {
  expect(breaking(/@evenrealities\//, file => file.startsWith(`glasses${sep}`))).toEqual([])
})

it('E2: only src/openrouter opens a connection', () => {
  const connects = /\bfetch\b|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b|\bsendBeacon\b/
  expect(breaking(connects, file => file.startsWith(`openrouter${sep}`))).toEqual([])
})

it('E2: the framework holds no address of its own', () => {
  expect(breaking(ADDRESS)).toEqual([])
})

it('E2: the relay holds no address of its own either', () => {
  const relay = read('relay')
  expect(relay.length).toBeGreaterThan(0)
  expect(breaking(ADDRESS, undefined, relay)).toEqual([])
})
