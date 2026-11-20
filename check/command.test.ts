import { describe, expect, it } from 'vitest'
import { command } from './command.js'
import type { CheckOptions, CheckResult } from './app.js'

const run = (argv: string[], result: Partial<CheckResult> = {}) => {
  const seen: CheckOptions[] = []
  const out = command(argv, options => {
    seen.push(options)
    return { problems: [], files: 3, whitelist: ['https://api.example.invalid'], ...result }
  })
  return { ...out, options: seen[0] }
}

describe('earshot-check', () => {
  it('checks app.json and dist by default, and says what passed', () => {
    const { code, lines, options } = run([])
    expect(options).toEqual({ manifest: 'app.json', dist: 'dist', allow: [] })
    expect(code).toBe(0)
    expect(lines).toEqual([
      'app.json follows the store rules, and no URL in 3 built files is outside the whitelist (https://api.example.invalid).',
    ])
  })

  it('takes the manifest, the build folder and the URLs the app says are its own', () => {
    const { options } = run(['plugin/app.json', 'plugin/dist', '--allow', 'demo://local', '--allow=local://cache'])
    expect(options).toEqual({ manifest: 'plugin/app.json', dist: 'plugin/dist', allow: ['demo://local', 'local://cache'] })
  })

  it('lists every problem and fails', () => {
    const { code, lines } = run([], { problems: ['name is missing.', 'edition "1" must be "202601".'] })
    expect(code).toBe(1)
    expect(lines).toEqual(['app.json and dist break 2 store rules:', '  name is missing.', '  edition "1" must be "202601".'])
  })

  it('says how to call it when it cannot read the arguments', () => {
    for (const argv of [['--allow'], ['--verbose'], ['a', 'b', 'c']]) {
      const { code, lines, options } = run(argv)
      expect(options).toBeUndefined()
      expect(code).toBe(2)
      expect(lines).toEqual(['Usage: earshot-check [app.json] [dist] [--allow <url>]...'])
    }
  })
})
