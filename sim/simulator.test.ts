import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { FRAME_TAG, INPUT_TAG } from '../src/glasses/glasses.js'
import { findBinary, limited, Simulator } from './simulator.js'

const FAKE = `#!/usr/bin/env node
import { createServer } from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--automation-port') + 1])
const mode = process.env.FAKE_SIM ?? ''
if (mode === 'exits') {
  console.error('cannot open display')
  process.exit(3)
}
const entries = []
const say = message => entries.push({ id: entries.length, level: 'log', message, ts: 1 })
let presses = 0
say('started ' + args.join(' '))
say('home=' + process.env.HOME + ' pid=' + process.pid + ' display=' + (process.env.DISPLAY ?? ''))
if (mode === 'later') setTimeout(() => say('ready later'), 300)
if (mode.startsWith('frames')) say('[earshot frame] {"lines":["Threads","One"],"menu":["Refresh","About"]}')
if (mode === 'dies') setTimeout(() => process.exit(0), 300)
if (mode === 'mic') {
  const { createReadStream, readFileSync } = await import('node:fs')
  const fifo = /infile "([^"]+)"/.exec(readFileSync(process.env.HOME + '/.asoundrc', 'utf8'))[1]
  let bytes = 0
  createReadStream(fifo).on('data', chunk => {
    bytes += chunk.length
    if (bytes >= 6400) say('mic heard enough')
  })
}
if (mode === 'silent') setInterval(() => {}, 1000)
else
  createServer((request, response) => {
    const url = new URL(request.url, 'http://fake')
    if (url.pathname === '/api/ping') return response.end('pong')
    if (url.pathname === '/api/console') {
      const since = Number(url.searchParams.get('since_id') ?? -1)
      return response.end(JSON.stringify({ entries: entries.filter(entry => entry.id > since), total: entries.length }))
    }
    if (url.pathname === '/api/input' && request.method === 'POST') {
      let body = ''
      request.on('data', chunk => (body += chunk))
      request.on('end', () => {
        const { action } = JSON.parse(body)
        if (mode === 'refuses') response.statusCode = 400
        else say('input ' + action)
        if (action === 'context_menu' && (mode === 'frames' || presses++ > 0)) say('[earshot input] {"kind":"foreground"}')
        if (action === 'click' && mode.startsWith('frames')) {
          say('[earshot input] {"kind":"menu","item":2}')
          setTimeout(() => say('[earshot input] {"kind":"background"}'), 200)
        }
        if (mode === 'frames') setTimeout(() => say('[earshot frame] {"lines":["Threads","after ' + action + '"]}'), 200)
        response.end()
      })
      return
    }
    if (url.pathname.startsWith('/api/screenshot/')) return response.end('png of ' + url.pathname.split('/').at(-1))
    response.statusCode = 404
    response.end()
  }).listen(port, '127.0.0.1')
`

let dir: string
let binary: string
// Fact: Windows starts only programs, and the stand-in for the simulator is a script.
const started = it.skipIf(process.platform === 'win32')

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'earshot-sim-test-'))
  binary = join(dir, 'fake-simulator.mjs')
  writeFileSync(binary, FAKE)
  chmodSync(binary, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const start = async (mode = '', options: { startMs?: number } = {}) => {
  const sim = await Simulator.start({ url: 'http://127.0.0.1:1/app', binary, headless: false, env: { FAKE_SIM: mode }, ...options })
  onTestFinished(() => sim.stop())
  return sim
}
const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const homes = () => readdirSync(tmpdir()).filter(name => name.startsWith('earshot-sim-') && !name.startsWith('earshot-sim-test-'))
const facts = (sim: Simulator) => {
  const [, home, pid] = /home=(\S+) pid=(\d+)/.exec(sim.entries.map(entry => entry.message).join('\n')) ?? []
  return { home, pid: Number(pid) }
}

describe('start', () => {
  started('opens the page in the simulator and waits until it answers', async () => {
    const sim = await start()
    await sim.read()
    expect(sim.entries[0].message).toMatch(/^started --no-aid --no-glow --automation-port \d+ http:\/\/127\.0\.0\.1:1\/app$/)
    expect(sim.api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  started('gives the simulator a home folder of its own', async () => {
    const sim = await start()
    await sim.read()
    expect(facts(sim).home).toContain('earshot-sim-')
    expect(existsSync(facts(sim).home)).toBe(true)
  })

  started('reports a simulator that exits, with what it printed, and leaves nothing behind', async () => {
    await expect(start('exits')).rejects.toThrow(/exited[\s\S]*cannot open display/)
  })

  started('reports a simulator that never answers, and stops it', async () => {
    await expect(start('silent', { startMs: 400 })).rejects.toThrow(/Timed out waiting for the simulator to answer/)
  })
})

describe('input', () => {
  started('sends each touchpad action', async () => {
    const sim = await start()
    for (const input of ['tap', 'double', 'up', 'down', 'press', 'release', 'menu'] as const) await sim.input(input)
    await sim.read()
    expect(sim.entries.map(entry => entry.message).filter(message => message.startsWith('input '))).toEqual([
      'input click',
      'input double_click',
      'input up',
      'input down',
      'input long_press',
      'input long_press_release',
      'input context_menu',
    ])
  })

  started('fails when the simulator refuses it', async () => {
    const sim = await start('refuses')
    await expect(sim.input('tap')).rejects.toThrow(/tap/)
  })
})

describe('the console', () => {
  started('reads each entry once', async () => {
    const sim = await start()
    expect((await sim.read()).length).toBe(2)
    expect(await sim.read()).toEqual([])
    await sim.input('tap')
    expect((await sim.read()).map(entry => entry.message)).toEqual(['input click'])
    expect(sim.entries.length).toBe(3)
  })

  started('waits for an entry that comes later', async () => {
    const sim = await start('later')
    expect((await sim.logged('ready later')).message).toBe('ready later')
  })

  started('finds the next matching entry each time it is asked', async () => {
    const sim = await start()
    await sim.input('tap')
    await sim.input('up')
    await sim.input('tap')
    expect((await sim.logged(/^input/)).message).toBe('input click')
    expect((await sim.logged(/^input/)).message).toBe('input up')
    expect((await sim.logged('click')).message).toBe('input click')
    await expect(sim.logged('click', 300)).rejects.toThrow(/Timed out waiting for the console to say "click"/)
  })
})

describe('until', () => {
  started('gives what the check found', async () => {
    const sim = await start()
    await sim.input('down')
    expect(await sim.until('a down', () => sim.entries.find(entry => entry.message === 'input down')?.id)).toBe(2)
  })

  started('says what it waited for and what the console last said when time runs out', async () => {
    const sim = await start()
    await expect(sim.until('the moon', () => false, 300)).rejects.toThrow(/Timed out waiting for the moon\.[\s\S]*home=/)
  })

  started('stops waiting when the simulator exits', async () => {
    const sim = await start('dies')
    await expect(sim.until('the moon', () => false, 10_000)).rejects.toThrow(/exited while waiting for the moon/)
  })
})

describe('what the glasses show', () => {
  started('is the lines of the last frame the app traced', async () => {
    const sim = await start('frames')
    expect(sim.shown()).toEqual([])
    await sim.read()
    expect(sim.shown()).toEqual(['Threads', 'One'])
  })

  started('can be waited for', async () => {
    const sim = await start('frames')
    await sim.input('tap')
    expect(await sim.shows('after click')).toEqual(['Threads', 'after click'])
    await expect(sim.shows('never', 300)).rejects.toThrow(/Timed out waiting for the glasses to show "never"/)
  })

  started("picks an item from Even's menu by its name", async () => {
    const sim = await start('frames')
    expect(sim.menu()).toEqual([])
    await sim.pick('About')
    expect(sim.entries.map(entry => entry.message).filter(message => message.startsWith('input '))).toEqual([
      'input context_menu',
      'input down',
      'input click',
    ])
    expect(sim.entries.map(entry => entry.message)).toContain('[earshot input] {"kind":"background"}')
    await expect(sim.pick('Missing')).rejects.toThrow(/No menu item "Missing"/)
  })

  started(
    'presses for the menu again when the first press was ignored',
    async () => {
      const sim = await start('frames-deaf')
      await sim.pick('Refresh')
      expect(sim.entries.map(entry => entry.message).filter(message => message.startsWith('input '))).toEqual([
        'input context_menu',
        'input context_menu',
        'input click',
      ])
    },
    15_000,
  )

  it('uses the tags the renderer writes', () => {
    expect(readFileSync(new URL('./simulator.ts', import.meta.url), 'utf8')).toContain(`const INPUT_TAG = '${INPUT_TAG}'`)
  })

  it('uses the tag the renderer writes', () => {
    expect(readFileSync(new URL('./simulator.ts', import.meta.url), 'utf8')).toContain(`const FRAME_TAG = '${FRAME_TAG}'`)
  })
})

describe('a stand-in microphone', () => {
  it.runIf(process.platform === 'linux')('lets the simulator hear a steady tone', async () => {
    const sim = await Simulator.start({ url: 'http://127.0.0.1:1/app', binary, headless: false, mic: true, env: { FAKE_SIM: 'mic' } })
    onTestFinished(() => sim.stop())
    expect((await sim.logged('mic heard enough', 5_000)).message).toBe('mic heard enough')
  })

  started('holds the touchpad for a while and lets go', async () => {
    const sim = await start()
    const before = Date.now()
    await sim.hold(300)
    expect(Date.now() - before).toBeGreaterThanOrEqual(300)
    await sim.read()
    expect(sim.entries.map(entry => entry.message).filter(message => message.startsWith('input '))).toEqual([
      'input long_press',
      'input long_press_release',
    ])
  })
})

describe('screenshot', () => {
  started('gives the picture of the glasses or of the phone page', async () => {
    const sim = await start()
    expect(Buffer.from(await sim.screenshot('glasses')).toString()).toBe('png of glasses')
    expect(Buffer.from(await sim.screenshot('phone')).toString()).toBe('png of webview')
  })
})

describe('stop', () => {
  started('ends the simulator and removes its home folder, however often it is called', async () => {
    const sim = await start()
    await sim.read()
    const { home, pid } = facts(sim)
    expect(running(pid)).toBe(true)
    await sim.stop()
    await sim.stop()
    expect(running(pid)).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  started('ends a simulator that would not start', async () => {
    const before = new Set(homes())
    await expect(start('silent', { startMs: 300 })).rejects.toThrow()
    expect(homes().filter(home => !before.has(home))).toEqual([])
  })
})

describe('limited', () => {
  it('gives every process a hard time limit where the system can', () => {
    expect(limited('linux', 'Xvfb', ['-displayfd', '3'], 60)).toEqual(['timeout', ['--kill-after=10', '60', 'Xvfb', '-displayfd', '3']])
    expect(limited('darwin', 'sim', ['x'], 60)).toEqual(['sim', ['x']])
  })
})

describe('findBinary', () => {
  it('finds the simulator installed in the project or above it', () => {
    const project = mkdtempSync(join(dir, 'project-'))
    const bin = join(project, 'node_modules/@evenrealities/sim-linux-x64/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'evenhub-simulator'), '')
    mkdirSync(join(project, 'packages/app'), { recursive: true })
    expect(findBinary(join(project, 'packages/app'), 'linux', 'x64')).toBe(join(bin, 'evenhub-simulator'))
  })

  it('says what to install when it is missing', () => {
    expect(() => findBinary(dir, 'linux', 'x64')).toThrow(/@evenrealities\/evenhub-simulator/)
  })
})
