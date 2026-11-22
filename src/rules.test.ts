import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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

it('E4: a test that calls an outside service is refused', async () => {
  await expect(fetch('https://service.example.invalid/v1')).rejects.toThrow('E4')
})

it('E9: a view hands a screen no raw input, only actions', () => {
  const view = sources.find(s => s.file === 'view.ts')!.text
  expect(view).not.toMatch(/input/i)
  expect(view).toMatch(/on\?: Gestures/)
})

const root = join(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const DIRECTIVE = /^(\/\/\/? ?(@ts-|eslint-|prettier-ignore|<reference)|#!)/

function comments(text: string): { line: number; text: string; block: boolean }[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const found = new Map<number, { line: number; text: string; block: boolean }>()
  const visit = (node: ts.Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]
    for (const range of ranges)
      found.set(range.pos, {
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        text: text.slice(range.pos, range.end),
        block: range.kind === ts.SyntaxKind.MultiLineCommentTrivia,
      })
    node.forEachChild(visit)
  }
  visit(source)
  return [...found.values()].sort((a, b) => a.line - b.line)
}

export function commentsBreakingC1(text: string): number[] {
  const notes = comments(text).filter(comment => !DIRECTIVE.test(comment.text))
  return notes
    .filter((note, at) => note.block || notes[at - 1]?.line === note.line - 1 || notes[at + 1]?.line === note.line + 1)
    .map(note => note.line)
}

it('C1: finds a block comment and a note of more than one line, and lets a directive and a one-line note be', () => {
  expect(commentsBreakingC1('/** what it does */\nconst a = 1\n')).toEqual([1])
  expect(commentsBreakingC1('// first line\n// second line\nconst a = 1\n')).toEqual([1, 2])
  expect(
    commentsBreakingC1("// @ts-expect-error\n// The simulator sends 0.\nconst a: string = 1\nconst b = '://*.' // one fact\n"),
  ).toEqual([])
})

it('C1: no comments but tool directives and one-line notes', () => {
  const code = tracked.filter(file => /\.(ts|mjs)$/.test(file))
  expect(code.length).toBeGreaterThan(sources.length)
  expect(code.flatMap(file => commentsBreakingC1(readFileSync(join(root, file), 'utf8')).map(line => `${file}:${line}`))).toEqual([])
})

it('the repository is public: no file names a home folder or a private network', () => {
  const PRIVATE = new RegExp(['/ho' + 'me/[a-z]', '/Us' + 'ers/[A-Za-z]', '\\.ts\\.n' + 'et\\b'].join('|'))
  const text = tracked.filter(file => !/\.(png|gif|jpg|woff2?|ehpk)$/.test(file) && file !== 'package-lock.json')
  expect(text.filter(file => PRIVATE.test(readFileSync(join(root, file), 'utf8')))).toEqual([])
})

it('a pull request runs check and the simulator suite, which the main branch requires', () => {
  const workflow = readFileSync(join(root, '.github/workflows/check.yml'), 'utf8')
  expect(workflow).toMatch(/^ {2}pull_request:$/m)
  expect(workflow).toMatch(/^ {2}check:\n(?: {4}.*\n)*? {6}- run: npm run check$/m)
  expect(workflow).toMatch(/^ {2}sim:\n(?: {4,}.*\n)*? {6}- run: npm run check:sim$/m)
  expect(workflow).not.toMatch(/^ {4}if:/m)
})
