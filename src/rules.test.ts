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

it('E9: a view hands a screen no raw input, only actions', () => {
  const view = sources.find(s => s.file === 'view.ts')!.text
  expect(view).not.toMatch(/input/i)
  expect(view).toMatch(/on\?: Gestures/)
})

const root = join(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
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
  expect(workflow.match(/npm run check/g)?.length).toBe(2)
  const offline = readFileSync(join(root, '.github/offline.sh'), 'utf8')
  expect(offline).toContain('unshare --net')
  expect(offline).toContain('EARSHOT_OFFLINE=1')
  expect(offline).toContain('"CI=$ci"')
})

it.runIf(process.env.EARSHOT_OFFLINE)("E4: in CI the tests see no network but the machine's own", () => {
  const outside = Object.values(networkInterfaces())
    .flatMap(addresses => addresses ?? [])
    .filter(({ internal }) => !internal)
  expect(outside).toEqual([])
})

it.runIf(process.env.CI || process.env.GITHUB_ACTIONS)('E4: CI never runs the tests with the network on', () => {
  expect(process.env.EARSHOT_OFFLINE).toBe('1')
})
