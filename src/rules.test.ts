import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src')
const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map(f => ({ file: relative(root, join(root, f)), text: readFileSync(join(root, f), 'utf8') }))
const breaking = (pattern: RegExp, allowed: (file: string) => boolean = () => false) =>
  sources.filter(s => !allowed(s.file) && pattern.test(s.text)).map(s => s.file)

it('finds the sources', () => {
  expect(sources.length).toBeGreaterThan(0)
})

it('E1: only src/glasses imports the Even SDK', () => {
  expect(breaking(/@evenrealities\//, file => file.startsWith(`glasses${sep}`))).toEqual([])
})

it('E2: the framework opens no connection', () => {
  expect(breaking(/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b|\bsendBeacon\b/)).toEqual([])
})
