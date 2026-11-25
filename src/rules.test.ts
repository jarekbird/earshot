import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { connect, Socket, type AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
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
  expect(readFileSync(join(root, '.github/c3.sh'), 'utf8')).toContain(
    'if npx tsc -p tsconfig.c3.json && xargs -0 npx vitest run < "$lists/tests"; then',
  )
})

const KEPT = Array.from({ length: 8 }, (_, n) => `export const kept${n} = ${n}`).join('\n')
const WAS: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['src', 'example'],
  }),
  'src/add.ts': `${KEPT}\nexport const add = (a: number, b: number) => a - b\n`,
  'src/add.test.ts':
    "import { expect, it } from 'vitest'\nimport { add } from './add.js'\n\nit('adds nothing', () => expect(add(1, 0)).toBe(1))\n",
  'example/main.ts': "import { add } from '../src/add.js'\n\nexport const one = add(1, 0)\n",
}
const FIXED = WAS['src/add.ts'].replace('a - b', 'a + b')
const SHOWS = `${WAS['src/add.test.ts']}\nit('adds', () => expect(add(1, 2)).toBe(3))\n`
const SHOWS_NOTHING = `${WAS['src/add.test.ts']}\nit('adds nothing to two', () => expect(add(2, 0)).toBe(2))\n`

async function c3(changes: Record<string, string | null>, also: Record<string, string> = {}): Promise<{ passed: boolean; said: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-c3-'))
  const run = promisify(execFile)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=trial', '-c', 'user.email=trial@example.invalid', ...args], { cwd: dir, env })
  const write = (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      if (text === null) rmSync(join(dir, file))
      else writeFileSync(join(dir, file), text)
    }
  }
  try {
    write({ ...WAS, ...also, '.gitignore': 'node_modules\n' })
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction')
    await git('init', '-q')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'as it was')
    const old = (await git('rev-parse', 'HEAD')).stdout.trim()
    write(changes)
    await git('add', '-A')
    await git('commit', '-q', '-m', 'the change')
    const done = await run('sh', [join(root, '.github/c3.sh'), old], { cwd: dir, env }).then(
      ({ stdout }) => ({ passed: true, said: stdout }),
      (failed: { stdout: string }) => ({ passed: false, said: failed.stdout }),
    )
    return { passed: done.passed, said: done.said.split('\n').findLast(line => line.includes('C3: ')) ?? done.said }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const C3_CASES: [string, Record<string, string | null>, boolean, string, Record<string, string>?][] = [
  ['takes a fix with a test that fails without it', { 'src/add.ts': FIXED, 'src/add.test.ts': SHOWS }, true, 'fail, or do not compile'],
  [
    'refuses a fix whose test passes without it too',
    { 'src/add.ts': FIXED, 'src/add.test.ts': SHOWS_NOTHING },
    false,
    'pass on the old source too',
  ],
  ['refuses a fix with no test', { 'src/add.ts': FIXED }, false, 'no test did'],
  ['has nothing to ask of a change to no source', { 'README.md': 'Words.\n' }, true, 'no source changed'],
  [
    'takes a test that does not compile without the change',
    {
      'src/add.ts': `${FIXED}export type Sum = number\n`,
      'src/add.test.ts': `${WAS['src/add.test.ts']}import type { Sum } from './add.js'\n\nexport const sum: Sum = add(1, 0)\n`,
    },
    true,
    'fail, or do not compile',
  ],
  [
    'refuses a change that only something else fails to compile without, when its test shows nothing',
    {
      'src/add.ts': `${WAS['src/add.ts']}export const sub = (a: number, b: number) => a - b\n`,
      'src/add.test.ts': SHOWS_NOTHING,
      'example/main.ts': "import { sub } from '../src/add.js'\n\nexport const one = sub(1, 0)\n",
    },
    false,
    'pass on the old source too',
  ],
  [
    'takes a fix in a file that is renamed in the same change',
    {
      'src/add.ts': null,
      'src/sum.ts': FIXED,
      'src/add.test.ts': null,
      'src/sum.test.ts': SHOWS.replace('./add.js', './sum.js'),
      'example/main.ts': WAS['example/main.ts'].replace('add.js', 'sum.js'),
    },
    true,
    'fail, or do not compile',
  ],
  [
    'refuses a fix whose test passes without it too, also when the name of the test has a space in it',
    { 'src/add.ts': FIXED, 'src/add nothing.test.ts': WAS['src/add.test.ts'] },
    false,
    'pass on the old source too',
  ],
  [
    'takes a fix in a file whose name has a space in it',
    {
      'src/two words.ts': 'export const two = 2\n',
      'src/two words.test.ts':
        "import { expect, it } from 'vitest'\nimport { two } from './two words.js'\n\nit('is two', () => expect(two).toBe(2))\n",
    },
    true,
    'fail, or do not compile',
    { 'src/two words.ts': 'export const two = 1\n' },
  ],
]

it.skipIf(process.platform === 'win32').concurrent.each(C3_CASES)(
  'C3: the job %s',
  { timeout: 120_000 },
  async (_, changes, passed, said, also) => {
    const done = await c3(changes, also)
    expect(done.said).toContain(said)
    expect(done.passed).toBe(passed)
  },
)

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
  expect(elsewhere.sort()).toEqual([
    'macos: npm run check',
    'ubuntu: .github/offline.sh npm run check',
    'windows: npm run check',
    'windows: npm run check:sim',
  ])
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

function surface() {
  const pack = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const paths = Object.entries(pack.exports as Record<string, { types: string }>).map(([path, { types }]) => {
    const file = types.replace('./dist/', '').replace(/\.d\.ts$/, '.ts')
    return { path, file: tracked.includes(file) ? file : `src/${file}` }
  })
  const program = ts.createProgram(
    paths.map(({ file }) => join(root, file)),
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2023,
      skipLibCheck: true,
      noEmit: true,
    },
  )
  const checker = program.getTypeChecker()
  const names = ({ file }: { file: string }) => {
    const module = checker.getSymbolAtLocation(program.getSourceFile(join(root, file))!)
    return module
      ? checker
          .getExportsOfModule(module)
          .map(symbol => symbol.name)
          .sort()
      : []
  }
  return {
    exports: Object.fromEntries(paths.map(entry => [entry.path, names(entry)])),
    bin: Object.keys(pack.bin).sort(),
    node: pack.engines.node,
    peers: pack.peerDependencies,
  }
}

const gone = (was: Record<string, string[]>, is: Record<string, string[]>) =>
  Object.entries(was).flatMap(([path, names]) =>
    is[path] ? names.filter(name => !is[path].includes(name)).map(name => `${path}: ${name}`) : [path],
  )

it('E14: nothing an app could be using has gone, and docs/api.json lists what an app has', () => {
  const was = JSON.parse(readFileSync(join(root, 'docs/api.json'), 'utf8')) as ReturnType<typeof surface>
  const is = surface()
  const broken = [
    ...gone(was.exports, is.exports),
    ...was.bin.filter(name => !is.bin.includes(name)).map(name => `bin: ${name}`),
    ...(was.node === is.node ? [] : [`node: ${was.node} became ${is.node}`]),
    ...(JSON.stringify(was.peers) === JSON.stringify(is.peers) ? [] : ['peerDependencies changed']),
  ]
  expect(
    broken,
    'E14: this breaks apps written against the last version. Ask Jarek before going on. With his word, list it in the pull request and bring docs/api.json up to date.',
  ).toEqual([])
  expect(
    is,
    `E14: what an app has changed. Nothing went, so no app breaks; bring docs/api.json up to date:\n${JSON.stringify(is, null, 2)}`,
  ).toEqual(was)
})

it('E14: the check sees a name, a way in or a command that went, and a need that rose', () => {
  const was = { '.': ['Glasses', 'Shell'], './relay': ['relay'] }
  expect(gone(was, { '.': ['Glasses', 'Shell', 'fluxLive'], './relay': ['relay'] })).toEqual([])
  expect(gone(was, { '.': ['Glasses'], './relay': ['relay'] })).toEqual(['.: Shell'])
  expect(gone(was, { '.': ['Glasses', 'Shell'] })).toEqual(['./relay'])
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

it('the changelog has an entry for this version and for every version before it: an app raises its pin by what it reads there', () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').trimEnd().split('\n')
  const HEADING = /^## (\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)$/
  const first = lines.findIndex(line => HEADING.test(line))
  expect(lines[0]).toBe('# Changelog')
  expect(lines.filter(line => /<[a-z!/]|^\s*(```|~~~)/i.test(line))).toEqual([])
  expect(lines.slice(1, first).filter(line => !/^([A-Za-z].*)?$/.test(line))).toEqual([])
  expect(lines.slice(first).filter(line => !HEADING.test(line) && !/^(- \S.*| {2}[\w`*].*)?$/.test(line))).toEqual([])
  const named = lines.flatMap(line => line.match(HEADING)?.[1] ?? [])
  expect(named[0]).toBe(version)
  const follows = (newer: string, older: string) => {
    const [major, minor, patch] = newer.split('.').map(Number)
    const [olderMajor, olderMinor] = older.split('.').map(Number)
    return patch > 0 ? older === `${major}.${minor}.${patch - 1}` : olderMajor < major || (olderMajor === major && olderMinor < minor)
  }
  expect(named.filter((one, at) => at > 0 && !follows(named[at - 1], one))).toEqual([])
  expect(named.at(-1)).toBe('0.0.1')
  expect(lines.filter((line, at) => HEADING.test(line) && !(lines[at + 1] === '' && lines[at + 2]?.startsWith('- ')))).toEqual([])
})
