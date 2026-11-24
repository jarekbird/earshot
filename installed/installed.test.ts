import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NAMES } from './names.js'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const entries = Object.keys(manifest.exports).map(path => join(manifest.name, path).replaceAll('\\', '/'))
const configs = [...manifest.scripts.build.matchAll(/tsc -p (\S+)/g)].map(([, config]) => config)
const everyEntry = entries
  .map((entry, n) => `import * as entry${n} from '${entry}'\nexport const used${n} = Object.keys(entry${n})`)
  .join('\n')
const STRICTEST: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: false,
}

let home: string
let app: string
let installed: string
let unbuilt: string[]

const problems = (diagnostics: readonly ts.Diagnostic[]) =>
  diagnostics.map(d => {
    const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined
    const where = d.file ? `${relative(app, d.file.fileName)}${at ? `:${at.line + 1}` : ''}: ` : ''
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
  })

function build(config: string) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, config), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
    },
  })!
  const outDir = join(installed, relative(root, parsed.options.outDir!))
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir })
  return problems([...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics])
}

function compile(files: Record<string, string>, types: string[]) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(app, name), text)
  const names = Object.keys(files).map(name => join(app, name))
  const inApp = (d: ts.Diagnostic) => !d.file || !relative(app, d.file.fileName).startsWith('..')
  return problems(ts.getPreEmitDiagnostics(ts.createProgram(names, { ...STRICTEST, types })).filter(inApp))
}

const shipped = () =>
  readdirSync(installed, { recursive: true, encoding: 'utf8' })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => /\.(js|d\.ts)$/.test(file))

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'earshot-installed-'))
  app = join(home, 'app')
  installed = join(app, 'node_modules', manifest.name)
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'an-app', type: 'module' }))
  symlinkSync(join(root, 'node_modules'), join(home, 'node_modules'), 'junction')
  cpSync(join(root, 'package.json'), join(installed, 'package.json'))
  unbuilt = configs.flatMap(build)
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('Earshot as an app installs it', () => {
  it('is built by the configurations the build script names, and by nothing else', () => {
    expect(manifest.scripts.build).toBe(configs.map(config => `tsc -p ${config}`).join(' && '))
    expect(manifest.scripts.prepare).toBe('npm run build')
    expect(unbuilt).toEqual([])
  })

  it('names only files the build makes, inside what it ships', () => {
    expect(manifest.files).toEqual(['dist'])
    const named = [
      manifest.types,
      ...Object.values(manifest.bin as Record<string, string>),
      ...Object.values(manifest.exports as Record<string, Record<string, string>>).flatMap(entry => Object.values(entry)),
    ].map(path => path.replace(/^\.\//, ''))
    expect(named.filter(path => !path.startsWith('dist/'))).toEqual([])
    expect(named.filter(path => !shipped().includes(path))).toEqual([])
  })

  it('starts each command with the line that makes it one', () => {
    const commands = Object.values(manifest.bin as Record<string, string>)
    expect(commands.filter(path => !readFileSync(join(installed, path), 'utf8').startsWith('#!/usr/bin/env node\n'))).toEqual([])
  })

  it('reaches for no package but its dependencies and its peers, in its code and in its types', () => {
    const has = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)])
    const wanted = shipped().flatMap(file =>
      ts
        .preProcessFile(readFileSync(join(installed, file), 'utf8'), true, true)
        .importedFiles.map(({ fileName }) => fileName)
        .filter(name => !name.startsWith('.') && !name.startsWith('node:') && !builtinModules.includes(name))
        .map(name => name.split('/', name.startsWith('@') ? 2 : 1).join('/'))
        .filter(name => !has.has(name))
        .map(name => `${file}: ${name}`),
    )
    expect(wanted).toEqual([])
  })

  it('gives no typed array a type argument in its types: a TypeScript before 5.7 cannot read one', () => {
    const TYPED = /\b(?:Big)?(?:Ui|I)nt(?:8|8Clamped|16|32|64)Array<|\bFloat(?:16|32|64)Array</
    expect(shipped().filter(file => file.endsWith('.d.ts') && TYPED.test(readFileSync(join(installed, file), 'utf8')))).toEqual([])
  })

  it('gives each entry point its types by name, under the strictest module rules an app can set', () => {
    expect(compile({ 'entries.ts': everyEntry }, ['node'])).toEqual([])
  })

  it("needs Node's types only where it needs Node: in check, sim and the relay's Node server", () => {
    const needing = compile({ 'entries.ts': everyEntry }, []).map(problem => problem.split(':')[0])
    expect(
      needing.filter(file => !/^node_modules\/earshot\/dist\/(check\/|sim\/|relay\/(node|cli)\.)/.test(file.replaceAll('\\', '/'))),
    ).toEqual([])
  })

  it('loads each entry point by name', async () => {
    const find = createRequire(join(app, 'main.js'))
    const loaded = await Promise.all(entries.map(async entry => Object.keys(await import(pathToFileURL(find.resolve(entry)).href)).length))
    expect(loaded.filter(count => count === 0)).toEqual([])
  })

  it('compiles every example of the README as an app would write it, given only the names the README leaves to the app', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const examples = [...readme.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map(match => ({
      code: match[1],
      line: readme.slice(0, match.index).split('\n').length + 1,
    }))
    expect(examples.length).toBeGreaterThan(10)
    const own = (code: string, name: string) =>
      new RegExp(`^(const|let|function|class|interface|type) ${name}\\b|^import [^\\n]*\\b${name}\\b[^\\n]* from`, 'm').test(code)
    const given = (code: string) =>
      Object.entries(NAMES)
        .filter(([name]) => new RegExp(`\\b${name}\\b`).test(code) && !own(code, name))
        .map(([, declaration]) => declaration)
        .join('; ')
    const files = Object.fromEntries(examples.map(({ code }, n) => [`readme-${n}.ts`, `${given(code)}\n${code}\nexport {}\n`]))
    const inReadme = (problem: string) =>
      problem.replace(/^readme-(\d+)\.ts:(\d+)/, (_, n, line) => `README.md:${examples[Number(n)].line + Number(line) - 2}`)
    expect(compile(files, ['node']).map(inReadme)).toEqual([])
  })
})
