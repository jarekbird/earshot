import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkApp } from './app.js'

const manifest = {
  package_id: 'com.example.weather',
  edition: '202601',
  name: 'Weather',
  version: '1.2.3',
  min_sdk_version: '0.0.16',
  entrypoint: 'index.html',
  permissions: [{ name: 'network', desc: 'Reads the forecast from the weather service.', whitelist: ['https://api.example.invalid'] }],
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'earshot-check-'))
  made.push(root)
  const all = {
    'app.json': JSON.stringify(manifest),
    'package.json': JSON.stringify({ version: '1.2.3' }),
    'node_modules/@evenrealities/even_hub_sdk/package.json': JSON.stringify({ version: '0.0.16' }),
    'dist/index.html': '<script type="module" src="./assets/app.js"></script>',
    'dist/assets/app.js': 'fetch("https://api.example.invalid/forecast")',
    ...files,
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('checking a built app', () => {
  it('passes an app that follows the rules, and says how much it read', () => {
    expect(checkApp({ root: project({}) })).toEqual({ problems: [], files: 2, whitelist: ['https://api.example.invalid'] })
  })

  it('reports manifest problems with the facts it found in the project', () => {
    const root = project({
      'package.json': JSON.stringify({ version: '1.2.4' }),
      'app.json': JSON.stringify({ ...manifest, entrypoint: 'main.html' }),
    })
    expect(checkApp({ root }).problems).toEqual([
      'version "1.2.3" differs from package.json, which says "1.2.4".',
      'entrypoint "main.html" is not a file in the build.',
    ])
  })

  it('reports each URL in the build that is outside the whitelist, with its file', () => {
    const root = project({
      'dist/assets/app.js': 'fetch("https:" + "//attacker.invalid/x")',
      'dist/assets/app.css': '@import url(https://fonts.invalid/a.css);',
    })
    expect(checkApp({ root }).problems.sort()).toEqual([
      `"https://attacker.invalid/x" in ${join('dist', 'assets', 'app.js')} is outside the network whitelist.`,
      `"https://fonts.invalid/a.css" in ${join('dist', 'assets', 'app.css')} is outside the network whitelist.`,
    ])
  })

  it('skips a URL the app lists as its own, and only that exact URL', () => {
    const root = project({ 'dist/assets/app.js': 'const demo = "demo://local"; const other = "demo://local/elsewhere"' })
    expect(checkApp({ root, allow: ['demo://local'] }).problems).toEqual([
      `"demo://local/elsewhere" in ${join('dist', 'assets', 'app.js')} is outside the network whitelist.`,
    ])
  })

  it('reports a script it cannot read as JavaScript, because joined URLs in it go unchecked', () => {
    const root = project({ 'dist/assets/app.js': 'fetch("https://api.example.invalid/x") }{' })
    expect(checkApp({ root }).problems).toEqual([
      `${join('dist', 'assets', 'app.js')} could not be read as JavaScript, so a URL joined from parts in it would be missed.`,
    ])
  })

  it('reads a manifest and a build from other places', () => {
    const root = project({ 'plugin/app.json': JSON.stringify({ ...manifest, name: 'Even Weather' }), 'out/index.html': '<p>hi</p>' })
    expect(checkApp({ root, manifest: 'plugin/app.json', dist: 'out' }).problems).toEqual([
      'name "Even Weather" contains "Even", which the store rejects.',
    ])
  })

  it('says so when the manifest or the build is missing or unreadable', () => {
    const root = project({ 'app.json': '{ not json' })
    expect(checkApp({ root }).problems).toEqual(['app.json is not valid JSON.'])
    expect(checkApp({ root, manifest: 'missing.json' }).problems).toEqual(['missing.json was not found.'])
    expect(checkApp({ root: project({}), dist: 'nowhere' }).problems).toEqual([
      'The build folder nowhere was not found. Build the app first.',
    ])
  })
})
