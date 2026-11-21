import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as pause } from 'node:timers/promises'

const LOOPBACK = '127.0.0.1'
const POLL_MS = 100
const FRAME_TAG = '[earshot frame]'
const INPUT_TAG = '[earshot input]'
const MENU_OPENS_MS = 1_500
const ACTIONS = {
  tap: 'click',
  double: 'double_click',
  up: 'up',
  down: 'down',
  press: 'long_press',
  release: 'long_press_release',
  menu: 'context_menu',
} as const

export type Input = keyof typeof ACTIONS

export interface ConsoleEntry {
  id: number
  level: string
  message: string
  ts: number
}

export interface SimulatorOptions {
  url: string
  binary?: string
  headless?: boolean
  mic?: boolean
  env?: Record<string, string>
  limitSeconds?: number
  startMs?: number
}

export function limited(platform: string, command: string, args: string[], seconds: number): [string, string[]] {
  return platform === 'linux' ? ['timeout', ['--kill-after=10', String(seconds), command, ...args]] : [command, args]
}

export function findBinary(from: string, platform: string = process.platform, arch: string = process.arch): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const binary = join(dir, 'node_modules', '@evenrealities', `sim-${platform}-${arch}`, 'bin', 'evenhub-simulator')
    if (existsSync(binary)) return binary
    if (dirname(dir) === dir)
      throw new Error(`No Even Hub simulator for ${platform} ${arch} here. Install @evenrealities/evenhub-simulator.`)
  }
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, LOOPBACK, () => {
      const address = server.address()
      server.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })

const MIC_RATE = 16_000
const MIC_CHUNK_MS = 100

// ALSA's default device becomes a file that is read from a pipe, which the driver fills with a tone.
function standInMic(home: string): () => void {
  if (process.platform !== 'linux') throw new Error('A stand-in microphone needs Linux.')
  const pipe = join(home, 'mic.pipe')
  execFileSync('mkfifo', [pipe])
  writeFileSync(
    join(home, '.asoundrc'),
    `pcm.!default {\n  type plug\n  slave { pcm "standin" format S16_LE rate ${MIC_RATE} channels 1 }\n}\npcm.standin {\n  type file\n  slave.pcm "null"\n  file "/dev/null"\n  infile "${pipe}"\n  format "raw"\n}\n`,
  )
  const samples = (MIC_RATE * MIC_CHUNK_MS) / 1000
  let pipeEnd: number | undefined
  let sent = 0
  const feeding = setInterval(() => {
    const chunk = new Int16Array(samples)
    for (let at = 0; at < samples; at++) chunk[at] = Math.round(8_000 * Math.sin((sent + at) / 5))
    sent += samples
    try {
      pipeEnd ??= openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK)
      writeSync(pipeEnd, new Uint8Array(chunk.buffer))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPIPE' && pipeEnd !== undefined) {
        closeSync(pipeEnd)
        pipeEnd = undefined
      } else if (code !== 'ENXIO' && code !== 'EAGAIN') throw error
    }
  }, MIC_CHUNK_MS)
  feeding.unref()
  return () => {
    clearInterval(feeding)
    if (pipeEnd !== undefined) closeSync(pipeEnd)
  }
}

const over = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

function signal(group: number, name: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-group, name)
  } catch {
    return false
  }
}

async function end(child: ChildProcess | undefined): Promise<void> {
  const group = child?.pid
  if (!child || group === undefined) return
  if (!over(child)) {
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    signal(group, 'SIGTERM')
    await Promise.race([exited, pause(2_500, undefined, { ref: false })])
  }
  signal(group, 'SIGKILL')
  for (let checks = 0; checks < 100 && signal(group, 0); checks++) await pause(20)
}

interface Started {
  child: ChildProcess
  failed: () => Error | undefined
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, log: number, seconds: number, pipe = false): Started {
  const [limiter, limitedArgs] = limited(process.platform, command, args, seconds)
  const child = spawn(limiter, limitedArgs, { cwd, env, detached: true, stdio: ['ignore', log, log, ...(pipe ? (['pipe'] as const) : [])] })
  let failure: Error | undefined
  child.once('error', error => (failure = error))
  if (limiter === command) setTimeout(() => void end(child), seconds * 1000).unref()
  return { child, failed: () => failure }
}

async function startDisplay(home: string, log: number, seconds: number): Promise<{ child: ChildProcess; name: string }> {
  const { child, failed } = launch(
    'Xvfb',
    ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1280x1024x24'],
    process.env,
    home,
    log,
    seconds,
    true,
  )
  let text = ''
  ;(child.stdio[3] as Readable).on('data', chunk => (text += String(chunk)))
  for (const until = Date.now() + 15_000; !text.includes('\n'); await pause(20)) {
    if (failed() || over(child) || Date.now() > until) {
      await end(child)
      throw new Error('The hidden display did not start. Is Xvfb installed?')
    }
  }
  return { child, name: `:${text.trim()}` }
}

export class Simulator {
  readonly entries: ConsoleEntry[] = []
  #seen = -1
  #matched = -1
  #stopping: Promise<void> | undefined

  private constructor(
    readonly api: string,
    private readonly sim: Started,
    private readonly display: ChildProcess | undefined,
    private readonly home: string,
    private readonly quiet: () => void,
  ) {}

  static async start(options: SimulatorOptions): Promise<Simulator> {
    const home = mkdtempSync(join(tmpdir(), 'earshot-sim-'))
    const log = openSync(join(home, 'simulator.log'), 'a')
    const seconds = options.limitSeconds ?? 3600
    let display: { child: ChildProcess; name: string } | undefined
    let simulator: Simulator | undefined
    let quiet = () => {}
    try {
      const binary = options.binary ?? findBinary(process.cwd())
      if (options.headless ?? (process.platform === 'linux' && !process.env.DISPLAY)) display = await startDisplay(home, log, seconds)
      if (options.mic) quiet = standInMic(home)
      const port = await freePort()
      const env = {
        ...process.env,
        ...(display ? { DISPLAY: display.name } : {}),
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        ...options.env,
      }
      const sim = launch(binary, ['--no-aid', '--no-glow', '--automation-port', String(port), options.url], env, home, log, seconds)
      simulator = new Simulator(`http://${LOOPBACK}:${port}`, sim, display?.child, home, quiet)
      const api = simulator.api
      await simulator.#wait(
        'the simulator to answer',
        () =>
          fetch(`${api}/api/ping`).then(
            pong => pong.ok,
            () => false,
          ),
        options.startMs ?? 60_000,
      )
      return simulator
    } catch (error) {
      if (simulator) await simulator.stop()
      else {
        quiet()
        await end(display?.child)
        rmSync(home, { recursive: true, force: true })
      }
      throw error
    } finally {
      closeSync(log)
    }
  }

  async read(): Promise<ConsoleEntry[]> {
    const response = await fetch(`${this.api}/api/console${this.#seen >= 0 ? `?since_id=${this.#seen}` : ''}`)
    if (!response.ok) throw new Error(`The simulator did not give its console (${response.status}).`)
    const { entries = [] } = (await response.json()) as { entries?: ConsoleEntry[] }
    const fresh = entries.filter(entry => entry.id > this.#seen)
    for (const entry of fresh) this.#seen = Math.max(this.#seen, entry.id)
    this.entries.push(...fresh)
    return fresh
  }

  until<T>(what: string, check: () => T | Promise<T>, ms = 20_000): Promise<Exclude<T, undefined | null | false>> {
    return this.#wait(
      what,
      async () => {
        await this.read()
        return check()
      },
      ms,
    )
  }

  logged(match: string | RegExp, ms = 20_000): Promise<ConsoleEntry> {
    const matches = (entry: ConsoleEntry) => (typeof match === 'string' ? entry.message.includes(match) : match.test(entry.message))
    return this.until(
      `the console to say ${typeof match === 'string' ? JSON.stringify(match) : String(match)}`,
      () => {
        const at = this.entries.findIndex((entry, index) => index > this.#matched && matches(entry))
        if (at < 0) return undefined
        this.#matched = at
        return this.entries[at]
      },
      ms,
    )
  }

  #frame(): { lines: string[]; menu: string[] } {
    for (let at = this.entries.length - 1; at >= 0; at--) {
      const tagged = this.entries[at].message.indexOf(FRAME_TAG)
      if (tagged < 0) continue
      try {
        const frame: unknown = JSON.parse(this.entries[at].message.slice(tagged + FRAME_TAG.length))
        if (!frame || typeof frame !== 'object') continue
        const strings = (key: string) => {
          const value = (frame as Record<string, unknown>)[key]
          return Array.isArray(value) ? value.map(String) : []
        }
        return { lines: strings('lines'), menu: strings('menu') }
      } catch {}
    }
    return { lines: [], menu: [] }
  }

  shown(): string[] {
    return this.#frame().lines
  }

  menu(): string[] {
    return this.#frame().menu
  }

  async pick(name: string, ms = 15_000): Promise<void> {
    await this.read()
    const at = this.menu().indexOf(name)
    if (at < 0) throw new Error(`No menu item ${JSON.stringify(name)}. The menu is: ${this.menu().join(', ') || 'empty'}.`)
    const saysSince = (from: number, text: string) => this.entries.slice(from).some(entry => entry.message.includes(text))
    const deadline = Date.now() + ms
    // Even's menu ignores a press while it is still closing, so a press is repeated until the app reports it open.
    for (let open = false; !open;) {
      if (Date.now() > deadline) throw new Error(`Even's menu did not open for ${JSON.stringify(name)}.`)
      const from = this.entries.length
      await this.input('menu')
      const until = Date.now() + MENU_OPENS_MS
      while (!open && Date.now() < until) {
        await pause(POLL_MS)
        await this.read()
        open = saysSince(from, `${INPUT_TAG} {"kind":"foreground"}`)
      }
    }
    for (let moved = 0; moved < at; moved++) await this.input('down')
    const from = this.entries.length
    await this.input('tap')
    const heard = () => saysSince(from, `${INPUT_TAG} {"kind":"menu"`) && saysSince(from, `${INPUT_TAG} {"kind":"background"}`)
    await this.until(`the app to hear the pick of ${JSON.stringify(name)} and the menu to close`, heard, Math.max(1, deadline - Date.now()))
  }

  shows(text: string, ms = 20_000): Promise<string[]> {
    return this.until(
      `the glasses to show ${JSON.stringify(text)}`,
      () => {
        const lines = this.shown()
        return lines.some(line => line.includes(text)) ? lines : undefined
      },
      ms,
    )
  }

  async input(input: Input): Promise<void> {
    const response = await fetch(`${this.api}/api/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: ACTIONS[input] }),
    })
    if (!response.ok) throw new Error(`The simulator refused ${input} (${response.status}).`)
  }

  async hold(ms = 1_000): Promise<void> {
    await this.input('press')
    await pause(ms)
    await this.input('release')
  }

  async screenshot(of: 'glasses' | 'phone'): Promise<Uint8Array> {
    const response = await fetch(`${this.api}/api/screenshot/${of === 'phone' ? 'webview' : 'glasses'}`)
    if (!response.ok) throw new Error(`The simulator gave no picture of the ${of} (${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.quiet()
      await end(this.sim.child)
      await end(this.display)
      rmSync(this.home, { recursive: true, force: true })
    })()
    return this.#stopping
  }

  async #wait<T>(what: string, check: () => T | Promise<T>, ms: number): Promise<Exclude<T, undefined | null | false>> {
    for (const until = Date.now() + ms; ; await pause(POLL_MS)) {
      let found: T | undefined
      let thrown: unknown
      try {
        found = await check()
      } catch (error) {
        thrown = error
        await pause(POLL_MS)
      }
      if (found !== undefined && found !== null && found !== false) return found as Exclude<T, undefined | null | false>
      const failure = this.sim.failed()
      if (failure) throw new Error(`The simulator did not run: ${failure.message}`)
      if (over(this.sim.child)) throw new Error(`The simulator exited while waiting for ${what}.${this.#said()}`)
      if (thrown) throw thrown
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.${this.#said()}`)
    }
  }

  #said(): string {
    const last = this.entries.slice(-5).map(entry => entry.message)
    let printed: string[] = []
    try {
      printed = readFileSync(join(this.home, 'simulator.log'), 'utf8').trim().split('\n').slice(-15)
    } catch {}
    return [
      ...(last.length ? ['', 'The console last said:', ...last] : []),
      ...(printed.join('').length ? ['', 'The simulator printed:', ...printed] : []),
    ].join('\n')
  }
}
