import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { manifestProblems, whitelistOf } from './manifest.js'
import { scan } from './urls.js'

export interface CheckOptions {
  root?: string
  manifest?: string
  dist?: string
  allow?: readonly string[]
}

export interface CheckResult {
  problems: string[]
  files: number
  whitelist: string[]
}

const SDK = 'node_modules/@evenrealities/even_hub_sdk/package.json'

const versionIn = (path: string): string | undefined => {
  try {
    const version: unknown = JSON.parse(readFileSync(path, 'utf8')).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? filesIn(join(dir, name)) : [join(dir, name)]))

export function checkApp({ root = process.cwd(), manifest = 'app.json', dist = 'dist', allow = [] }: CheckOptions = {}): CheckResult {
  const failed = (problem: string): CheckResult => ({ problems: [problem], files: 0, whitelist: [] })
  const manifestPath = resolve(root, manifest)
  if (!existsSync(manifestPath)) return failed(`${manifest} was not found.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return failed(`${manifest} is not valid JSON.`)
  }

  const build = resolve(root, dist)
  const built = existsSync(build) && statSync(build).isDirectory()
  const whitelist = whitelistOf(parsed)
  const problems = manifestProblems(parsed, {
    packageVersion: versionIn(resolve(root, 'package.json')),
    sdkVersion: versionIn(resolve(root, SDK)),
    hasFile: built ? path => existsSync(join(build, path)) && statSync(join(build, path)).isFile() : undefined,
  })
  if (!built) return { problems: [...problems, `The build folder ${dist} was not found. Build the app first.`], files: 0, whitelist }

  const files = filesIn(build)
  for (const file of files) {
    for (const url of new Set(scan(whitelist, file, readFileSync(file, 'utf8')))) {
      if (!allow.includes(url)) problems.push(`${JSON.stringify(url)} in ${relative(root, file)} is outside the network whitelist.`)
    }
  }
  return { problems, files: files.length, whitelist }
}
