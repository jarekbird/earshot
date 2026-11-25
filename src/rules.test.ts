import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { connect, Socket, type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
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

it('E2: only src/openrouter and src/flux open a connection', () => {
  const connects = /\bfetch\b|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b|\bsendBeacon\b/
  expect(breaking(connects, file => file.startsWith(`openrouter${sep}`) || file.startsWith(`flux${sep}`))).toEqual([])
})

it('E2: the framework holds no address of its own', () => {
  expect(breaking(ADDRESS)).toEqual([])
})

it('E2: the relay holds no address of its own either', () => {
  const relay = read('relay')
  expect(relay.length).toBeGreaterThan(0)
  expect(breaking(ADDRESS, undefined, relay)).toEqual([])
})

it('E4: a test that calls an outside service is refused, by fetch, by any other connection, and after a redirect', async () => {
  await expect(fetch('https://service.example.invalid/v1')).rejects.toThrow('E4')
  expect(() => get('http://service.example.invalid/v1')).toThrow('E4')
  expect(() => connect(443, 'service.example.invalid')).toThrow('E4')
  expect(() => new Socket().connect('443' as never, 'service.example.invalid')).toThrow('E4')
  expect(() => connect({ port: 443, host: 'service.example.invalid' })).toThrow('E4')
  const local = createServer((_request, response) => response.writeHead(302, { location: 'https://service.example.invalid/v1' }).end())
  await new Promise<void>(done => local.listen(0, '127.0.0.1', done))
  const address = `http://127.0.0.1:${(local.address() as AddressInfo).port}/`
  const outcome = await fetch(address).then(
    () => 'answered',
    (error: Error) => String(error.cause),
  )
  local.close()
  expect(outcome).toContain('E4')
})

const UNGUARDED = /['"`](node:)?(child_process|worker_threads|cluster|dgram)['"`]/

it('E4: the check knows each way to name what the guard does not reach: a process, a worker, UDP', () => {
  const samples = [
    "import { spawn } from 'node:child_process'",
    "import { execFile } from 'child_process'",
    'import { Worker as Thread } from "worker_threads"',
    "const { fork } = require('cluster')",
    'await import(`node:worker_threads`)',
    "import { createSocket } from 'node:dgram'",
  ]
  expect(samples.filter(sample => !UNGUARDED.test(sample))).toEqual([])
  expect(UNGUARDED.test("import { createServer } from 'node:http'")).toBe(false)
})

it('E4: only the simulator driver and this file use what the guard does not reach', () => {
  const code = tracked.filter(file => /\.(ts|mjs|js|cjs)$/.test(file) && UNGUARDED.test(readFileSync(join(root, file), 'utf8')))
  expect(code).toEqual(['sim/real.sim.test.ts', 'sim/simulator.ts', 'src/rules.test.ts'])
})

const NOT_IN_THE_EXAMPLE = [
  'toWav',
  'cleanText',
  'fitText',
  'hasGlyph',
  'oneLine',
  'textWidth',
  'wrapText',
  'FRAME_TAG',
  'SCREEN_HEIGHT',
  'LifetimeEnded',
  'matchWords',
  'navigator',
  'RelayError',
  'SayError',
  'createStore',
  'evenPlace',
  'memoryPlace',
  'StoreError',
  'webPlace',
]

it('E8: the example app uses every value the framework exports, but for a list that only gets shorter', () => {
  const parsed = (file: string) => ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.ES2023).statements
  const index = parsed('src/index.ts')
  const unnamed = index.filter(one => !ts.isExportDeclaration(one) || !one.exportClause || !ts.isNamedExports(one.exportClause))
  expect(unnamed.length, 'src/index.ts exports by name only, so that this check can read every export').toBe(0)
  const exported = index.flatMap(one =>
    ts.isExportDeclaration(one) && !one.isTypeOnly && one.exportClause && ts.isNamedExports(one.exportClause)
      ? one.exportClause.elements.filter(name => !name.isTypeOnly).map(name => name.name.text)
      : [],
  )
  const used = parsed('example/main.ts').flatMap(one => {
    if (!ts.isImportDeclaration(one) || !ts.isStringLiteral(one.moduleSpecifier) || one.moduleSpecifier.text !== 'earshot') return []
    const names = one.importClause?.isTypeOnly ? undefined : one.importClause?.namedBindings
    return names && ts.isNamedImports(names)
      ? names.elements.filter(name => !name.isTypeOnly).map(name => (name.propertyName ?? name.name).text)
      : []
  })
  expect(used.length).toBeGreaterThan(0)
  expect(
    exported.filter(name => !used.includes(name)),
    'E8: a new export comes with the example app using it. One the example now uses leaves this list. Nothing joins it.',
  ).toEqual(NOT_IN_THE_EXAMPLE)
})

it('E9: a view hands a screen no raw input, only actions', () => {
  const view = sources.find(s => s.file === 'view.ts')!.text
  expect(view).not.toMatch(/input/i)
  expect(view).toMatch(/on\?: Gestures/)
})

const root = join(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
function exportsAndUses(file: string, text: string): { exported: string[]; used: { file: string; name: string }[] } {
  const from = (specifier: string) => join(file, '..', specifier).replaceAll(sep, '/').replace(/\.js$/, '.ts')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true)
  const exported: string[] = []
  const used: { file: string; name: string }[] = []
  const bound = (name: ts.BindingName): string[] =>
    ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(one => (ts.isOmittedExpression(one) ? [] : bound(one.name)))
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.arguments[0].text.startsWith('.')) used.push({ file: from(node.arguments[0].text), name: '*' })
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      let first = node.qualifier
      while (first && ts.isQualifiedName(first)) first = first.left
      if (node.argument.literal.text.startsWith('.')) used.push({ file: from(node.argument.literal.text), name: first?.text ?? '*' })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) exported.push('default')
    else if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const names = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause
      const listed = names && (ts.isNamedImports(names) || ts.isNamedExports(names)) ? names.elements : undefined
      if (ts.isExportDeclaration(statement))
        exported.push(...(listed?.map(one => one.name.text) ?? (names && ts.isNamespaceExport(names) ? [names.name.text] : [])))
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
      if (!specifier.startsWith('.')) continue
      const everything = !listed && (names !== undefined || ts.isExportDeclaration(statement))
      const taken = [
        ...(listed?.map(one => (one.propertyName ?? one.name).text) ?? (everything ? ['*'] : [])),
        ...(ts.isImportDeclaration(statement) && statement.importClause?.name ? ['default'] : []),
      ]
      used.push(...(taken.length ? taken : ['']).map(name => ({ file: from(specifier), name })))
    } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(one => one.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(statement)?.some(one => one.kind === ts.SyntaxKind.DefaultKeyword)) exported.push('default')
      else if (ts.isVariableStatement(statement)) exported.push(...statement.declarationList.declarations.flatMap(one => bound(one.name)))
      else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node))
        exported.push((statement.name as ts.Identifier).text)
    }
  }
  return { exported, used }
}

it('C2: the check knows each way to export and each way to use what another file exports', () => {
  const of = (text: string) => exportsAndUses('src/here.ts', text)
  expect(
    of('export const a = 1, b = 2\nexport function c() {}\nexport interface D {}\nexport type E = 1\nexport class F {}').exported,
  ).toEqual(['a', 'b', 'c', 'D', 'E', 'F'])
  expect(of('const a = 1\nconst b = 2\nexport { a, b as c }').exported).toEqual(['a', 'c'])
  expect(of('export default 1').exported).toEqual(['default'])
  expect(of("export { x as y } from './there.js'")).toEqual({ exported: ['y'], used: [{ file: 'src/there.ts', name: 'x' }] })
  expect(of("export * from './there.js'").used).toEqual([{ file: 'src/there.ts', name: '*' }])
  expect(of("export * as all from './there.js'")).toEqual({ exported: ['all'], used: [{ file: 'src/there.ts', name: '*' }] })
  expect(of("import { x, y as z } from './there.js'").used).toEqual([
    { file: 'src/there.ts', name: 'x' },
    { file: 'src/there.ts', name: 'y' },
  ])
  expect(of("import whole from './there.js'").used).toEqual([{ file: 'src/there.ts', name: 'default' }])
  expect(of("import whole, { x } from '../check/there.js'").used).toEqual([
    { file: 'check/there.ts', name: 'x' },
    { file: 'check/there.ts', name: 'default' },
  ])
  expect(of("import * as all from './there.js'").used).toEqual([{ file: 'src/there.ts', name: '*' }])
  expect(of("import './there.js'").used).toEqual([{ file: 'src/there.ts', name: '' }])
  expect(of("const later = await import('./there.js')").used).toEqual([{ file: 'src/there.ts', name: '*' }])
  expect(of('export const { a, b: c, ...rest } = thing, [d, , e] = list').exported).toEqual(['a', 'c', 'rest', 'd', 'e'])
  expect(of("export type B = import('./there.js').A")).toEqual({ exported: ['B'], used: [{ file: 'src/there.ts', name: 'A' }] })
  expect(of("let deep: import('./there.js').A.B").used).toEqual([{ file: 'src/there.ts', name: 'A' }])
  expect(of("let all: typeof import('./there.js')").used).toEqual([{ file: 'src/there.ts', name: '*' }])
  expect(of("import { expect } from 'vitest'")).toEqual({ exported: [], used: [] })
})

it('C2: nothing is exported that nothing uses, and no file is left that nothing reads', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const built = [
    ...Object.values(manifest.bin as Record<string, string>),
    ...Object.values(manifest.exports as Record<string, { default: string }>).map(entry => entry.default),
  ]
  const entries = built
    .map(path => path.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts'))
    .map(path => (/^(check|sim|relay)\//.test(path) ? path : `src/${path}`))
  const code = tracked.filter(file => /\.(ts|mts|mjs)$/.test(file) && !file.endsWith('.d.mts'))
  const read = code.map(file => ({ file, ...exportsAndUses(file, readFileSync(join(root, file), 'utf8')) }))
  const uses = read.flatMap(one => one.used)
  const ours = read.filter(
    ({ file }) => /^(src|check|sim|relay)\/.*\.ts$/.test(file) && !file.endsWith('.test.ts') && !entries.includes(file),
  )
  expect(entries.filter(file => !code.includes(file))).toEqual([])
  expect(ours.filter(({ file }) => !uses.some(use => use.file === file)).map(({ file }) => file)).toEqual([])
  expect(
    ours.flatMap(({ file, exported }) =>
      exported
        .filter(name => !uses.some(use => use.file === file && (use.name === name || use.name === '*')))
        .map(name => `${file}: ${name}`),
    ),
    'C2: an export nothing imports is left over. Take the word "export" away, or the thing itself when nothing in its own file uses it.',
  ).toEqual([])
})

it('C3: a pull request tries its changed tests on the old source, with no network, unless it is marked as no new behaviour', () => {
  const workflow = readFileSync(join(root, '.github/workflows/c3.yml'), 'utf8')
  expect(workflow).toMatch(/^ {2}pull_request:$/m)
  expect(workflow).toMatch(/^ {4}if: \$\{\{ !contains\(github\.event\.pull_request\.labels\.\*\.name, 'no new behaviour'\) \}\}$/m)
  expect(workflow).toMatch(/^ {6}- run: \.github\/offline\.sh \.github\/c3\.sh "\$BASE"$/m)
  expect(workflow.match(/^ {6}- run: /gm)).toHaveLength(3)
  expect(readFileSync(join(root, '.github/c3.sh'), 'utf8')).toContain('if npx tsc --noEmit && npx vitest run $tests; then')
})

const DIRECTIVE = /^((\/\/\/? ?|\/\*+\s*)(@ts-|eslint[- ]|prettier-ignore|<reference|v8 ignore|c8 ignore|istanbul ignore|globals? )|#!)/

interface Comment {
  line: number
  text: string
  alone: boolean
}

function comments(text: string): Comment[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const found = new Map<number, Comment>()
  const visit = (node: ts.Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]
    for (const range of ranges)
      found.set(range.pos, {
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        text: text.slice(range.pos, range.end),
        alone: !text.slice(text.lastIndexOf('\n', range.pos - 1) + 1, range.pos).trim(),
      })
    node.forEachChild(visit)
  }
  visit(source)
  return [...found.values()].sort((a, b) => a.line - b.line)
}

export function commentsBreakingC1(text: string): number[] {
  const notes = comments(text).filter(comment => !DIRECTIVE.test(comment.text))
  const alone = new Set(notes.filter(note => note.alone).map(note => note.line))
  return notes
    .filter(note => note.text.includes('\n') || (note.alone && (alone.has(note.line - 1) || alone.has(note.line + 1))))
    .map(note => note.line)
}

it('C1: finds a comment of more than one line, and lets a directive and one-line notes be', () => {
  expect(commentsBreakingC1('/**\n * what it does\n */\nconst a = 1\n')).toEqual([1])
  expect(commentsBreakingC1('// first line\n// second line\nconst a = 1\n')).toEqual([1, 2])
  expect(
    commentsBreakingC1("// @ts-expect-error\n// The simulator sends 0.\nconst a: string = 1\nconst b = '://*.' // one fact\n"),
  ).toEqual([])
  expect(commentsBreakingC1('const a = 204 // HTTP 204 has no body.\nconst b = 304 // HTTP 304 has no body.\n')).toEqual([])
  expect(commentsBreakingC1('/* HTTP 204 has no body. */\nconst a = 204\n')).toEqual([])
  expect(commentsBreakingC1('/* eslint-disable\n  no-console\n*/\nconst a = 1\n')).toEqual([])
})

it('C1: no comments but tool directives and one-line notes', () => {
  const code = tracked.filter(file => /\.(ts|mjs)$/.test(file))
  expect(code.length).toBeGreaterThan(sources.length)
  expect(code.flatMap(file => commentsBreakingC1(readFileSync(join(root, file), 'utf8')).map(line => `${file}:${line}`))).toEqual([])
})

const PRIVATE = new RegExp(
  [
    '/ho' + 'me/[a-z]',
    '/Us' + 'ers/[A-Za-z]',
    '[A-Z]:\\\\+Us' + 'ers\\\\',
    '\\b10(\\.\\d{1,3}){3}\\b',
    '\\b192\\.168(\\.\\d{1,3}){2}\\b',
    '\\b172\\.(1[6-9]|2\\d|3[01])(\\.\\d{1,3}){2}\\b',
    '\\b100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(\\.\\d{1,3}){2}\\b',
    '\\b[a-z0-9-]+\\.(ts\\.n' + 'et|lo' + 'cal|la' + 'n|inter' + 'nal)\\b',
    '\\b(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*:[0-9a-f]',
  ].join('|'),
  'i',
)

it('the repository is public: the check knows a home folder, a private address and a private host name', () => {
  const samples = [
    '/ho' + 'me/someone/x',
    '/Us' + 'ers/Someone/x',
    'C:\\Us' + 'ers\\someone',
    JSON.stringify('C:\\Us' + 'ers\\someone'),
    'http://192.' + '168.1.42:8787',
    '10.' + '0.0.7',
    '172.' + '20.1.1',
    '100.' + '101.2.3',
    'https://desk.' + 'local',
    'box.tail1234.ts.' + 'net',
    'http://[fd7a:' + '115c:a1e0::1234]:8787',
    'fe80:' + ':1ff:fe23:4567:890a',
    'https://registry.example.inter' + 'nal/pkg.tgz',
  ]
  expect(samples.filter(sample => !PRIVATE.test(sample))).toEqual([])
  expect(['127.0.0.1', 'https://relay.example.com', 'demo://local', '0.0.31', 'localhost']).not.toContainEqual(
    expect.stringMatching(PRIVATE),
  )
})

it('the repository is public: no file names a home folder, a private address or a private host name', () => {
  const text = tracked.filter(file => !/\.(png|gif|jpg|woff2?|ehpk)$/.test(file))
  expect(text.filter(file => PRIVATE.test(readFileSync(join(root, file), 'utf8')))).toEqual([])
})

it("E4: a pull request runs check and the simulator suite with no network but the machine's own", () => {
  const workflow = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8')
  expect(workflow).toMatch(/^ {2}pull_request:$/m)
  expect(workflow).toMatch(/^ {2}check:\n(?: {4}.*\n)*? {6}- run: \.github\/offline\.sh npm run check$/m)
  expect(workflow).toMatch(/^ {2}sim:\n(?: {4,}.*\n)*? {6}- run: \.github\/offline\.sh npm run check:sim$/m)
  expect(workflow).not.toMatch(/^ {4}if:/m)
  const offline = readFileSync(join(root, '.github/offline.sh'), 'utf8')
  expect(offline).toContain('unshare --net')
  expect(offline).toContain('EARSHOT_OFFLINE=1')
  expect(offline).toContain('"CI=$ci"')
})

it('E4: on the other systems CI has only the guard, since only Linux can take the network away; on Linux it always does', () => {
  const workflow = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8')
  const elsewhere = [...workflow.matchAll(/^ {10}- \{ os: (\w+)-latest, node: \d+, run: (.+) \}$/gm)].map(([, os, run]) => `${os}: ${run}`)
  expect(elsewhere.filter(leg => !/^(macos|windows): npm run check$|^ubuntu: \.github\/offline\.sh npm run check$/.test(leg))).toEqual([])
  expect(elsewhere.map(leg => leg.split(':')[0]).sort()).toEqual(['macos', 'ubuntu', 'windows'])
  expect(workflow).toMatch(/^ {2}elsewhere:\n(?: {4,}.*\n)*? {6}- run: \$\{\{ matrix\.run \}\}$/m)
  expect(workflow.match(/npm run check/g)?.length).toBe(2 + elsewhere.length)
})

it("an app that installs Earshot installs no tool that runs on fewer machines than Earshot's own: the Worker's runtime is apart", () => {
  const { dependencies, devDependencies, peerDependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const installed = Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies })
  expect(
    installed.filter(name => /^(miniflare|workerd|wrangler|@cloudflare\/)/.test(name)),
    'npm installs every one of these to build Earshot for an app that takes it from Git. Put the tool in workerd/package.json.',
  ).toEqual([])
  const apart = JSON.parse(readFileSync(join(root, 'workerd/package.json'), 'utf8'))
  expect(Object.keys(apart.devDependencies)).toEqual(['miniflare'])
  const workflow = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8')
  expect(workflow).toMatch(/^ {6}- run: npm ci --prefix workerd\n {6}- run: \.github\/offline\.sh npm run check$/m)
  expect(workflow).toMatch(/^ {6}- run: npm ci --prefix workerd\n {6}- run: \$\{\{ matrix\.run \}\}$/m)
})

it.runIf(process.env.EARSHOT_OFFLINE)("E4: in CI the tests see no network but the machine's own", () => {
  const outside = Object.values(networkInterfaces())
    .flatMap(addresses => addresses ?? [])
    .filter(({ internal }) => !internal)
  expect(outside).toEqual([])
})

const onLinuxInCi = (process.env.CI || process.env.GITHUB_ACTIONS) && process.platform === 'linux'

it.runIf(onLinuxInCi)('E4: on Linux, CI never runs the tests with the network on', () => {
  expect(process.env.EARSHOT_OFFLINE).toBe('1')
})

it('asks for no older Node than the one CI runs the tests on, so that the least it takes is one that is tried', () => {
  const { engines } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const tried = [...readFileSync(join(root, '.github/workflows/check.yml'), 'utf8').matchAll(/node-version: (\d+)/g)]
  expect(tried.length).toBeGreaterThan(0)
  expect(engines.node).toBe(`>=${Math.min(...tried.map(([, version]) => Number(version)))}`)
})

it('the example asks for this version of Earshot, and for the tools Earshot itself is tested with', () => {
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const example = JSON.parse(readFileSync(join(root, 'example/package.json'), 'utf8'))
  expect(example.version).toBe(own.version)
  const { earshot, ...tools } = { ...example.dependencies, ...example.devDependencies }
  expect(earshot).toBe(`github:jarekbird/earshot#v${own.version}`)
  expect(tools).toEqual(Object.fromEntries(Object.keys(tools).map(name => [name, own.devDependencies[name]])))
})

it("the README's install line pins this version: a stale one installs an Earshot the README does not describe", () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  expect(readme.match(/earshot#v[\d.]+/g)).toEqual([`earshot#v${version}`])
  expect(readme.match(/--branch v[\d.]+/g)).toEqual([`--branch v${version}`])
})
