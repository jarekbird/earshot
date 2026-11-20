import type { CheckOptions, CheckResult } from './app.js'

export interface CommandResult {
  code: number
  lines: string[]
}

const USAGE = 'Usage: earshot-check [app.json] [dist] [--allow <url>]...'

export function command(argv: readonly string[], check: (options: CheckOptions) => CheckResult): CommandResult {
  const paths: string[] = []
  const allow: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--allow' && argv[i + 1] !== undefined) allow.push(argv[++i])
    else if (arg.startsWith('--allow=')) allow.push(arg.slice('--allow='.length))
    else if (arg.startsWith('--')) return { code: 2, lines: [USAGE] }
    else paths.push(arg)
  }
  if (paths.length > 2) return { code: 2, lines: [USAGE] }
  const [manifest = 'app.json', dist = 'dist'] = paths
  const { problems, files, whitelist } = check({ manifest, dist, allow })
  if (problems.length) {
    const count = problems.length === 1 ? 'a store rule' : `${problems.length} store rules`
    return { code: 1, lines: [`${manifest} and ${dist} break ${count}:`, ...problems.map(problem => `  ${problem}`)] }
  }
  const listed = whitelist.join(' ') || 'empty'
  return {
    code: 0,
    lines: [`${manifest} follows the store rules, and no URL in ${files} built files is outside the whitelist (${listed}).`],
  }
}
