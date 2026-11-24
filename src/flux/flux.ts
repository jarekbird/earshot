import { SAMPLE_RATE, type Speaker } from '../audio.js'
import { Lifetime, type Timer } from '../lifetime.js'
import { most, type LiveSpeech, type LiveState, type Turn } from '../live.js'
import { serve } from '../serve.js'

export interface FluxSocket {
  binaryType: string
  readonly readyState: number
  readonly bufferedAmount: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number): void
}

export interface FluxOptions {
  host: string
  secret: string
  staleMs?: number
}

export interface FluxWiring {
  open: (url: string) => FluxSocket
  now: () => number
}

// Fact: performance.now never goes back, as the wall clock can, so it is what the age of held sound is told by.
const BROWSER: FluxWiring = { open: address => new WebSocket(address) as unknown as FluxSocket, now: () => performance.now() }

export const fluxLive = (options: FluxOptions): LiveSpeech => fluxOver(options, BROWSER)

export const FLUX = '@cf/deepgram/flux'
export const LIVE_PATH = '/api/v1/live'
export const REFUSALS = { hello: 4400, secret: 4401, model: 4403 }
const BYTES_PER_S = SAMPLE_RATE * 2
export const HELD_BYTES = 10 * BYTES_PER_S
export const PIECE_BYTES = BYTES_PER_S
export const STALLED_BYTES = 3 * HELD_BYTES
export const QUIET_MS = 10_000
export const CONNECT_MS = 10_000
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 8_000
const FOR_GOOD = new Set<number>(Object.values(REFUSALS))
const onThisDevice = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
const HEARD = 'live speech'
const OPEN = 1

export const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))

interface Piece {
  pcm: Uint8Array
  speaker: Speaker
  at: number
}

interface Run {
  start: number
  end: number
  speaker: Speaker
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null
  try {
    const message: unknown = JSON.parse(data)
    return message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const NOT_ALONE = 'The relay of live speech is named by its address alone: no query, no fragment, no name or password.'

function lineTo(host: string): string {
  let relay: URL
  try {
    relay = new URL(host)
  } catch {
    throw new Error(NOT_ALONE)
  }
  if (relay.protocol !== 'https:' && !(relay.protocol === 'http:' && onThisDevice(relay.hostname)))
    throw new Error('Live speech carries a secret and sound, so its relay is named with https.')
  if (/[?#]/.test(host) || relay.username || relay.password) throw new Error(NOT_ALONE)
  relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'
  relay.pathname = `${relay.pathname.replace(/\/+$/, '')}${LIVE_PATH}`
  return relay.href
}

export function fluxOver(options: FluxOptions, { open, now }: FluxWiring): LiveSpeech {
  const url = lineTo(options.host)
  const staleMs = options.staleMs ?? Infinity
  const hello = JSON.stringify({
    model: FLUX,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    secret: options.secret,
  })

  return {
    start(life, heard, told) {
      let line: { socket: FluxSocket; life: Lifetime; connected: boolean } | null = null
      let held: Piece[] = []
      let heldBytes = 0
      let runs: Run[] = []
      let sent = 0
      let first = 0
      let next = 0
      let growing: Turn | null = null
      let failures = 0
      let state: LiveState = 'on'
      let refused = false
      let retry: Timer | undefined
      let quiet: Timer | undefined
      let telling = false
      const news: Array<() => void> = []

      const settled = <A extends unknown[]>(step: (...args: A) => void) => {
        return (...args: A) => {
          step(...args)
          if (telling) return
          telling = true
          try {
            for (let one = news.shift(); one; one = news.shift()) one()
          } finally {
            telling = false
          }
        }
      }

      const tell = (now: LiveState) => {
        if (state === now) return
        state = now
        news.push(() => serve(() => told?.(now), HEARD))
      }

      const say = (turn: Turn) => void news.push(() => serve(() => heard({ ...turn }), HEARD))

      const cutTurn = () => {
        if (!growing) return
        say({ ...growing, final: true, cut: true })
        growing = null
      }

      const forget = () => {
        held = []
        heldBytes = 0
      }

      const expire = () => {
        if (staleMs === Infinity) return
        const at = now()
        held = held.filter(piece => at >= piece.at && at - piece.at <= staleMs)
        heldBytes = held.reduce((bytes, piece) => bytes + piece.pcm.length, 0)
      }

      const leave = (code?: number) => {
        if (!line) return
        const { socket } = line
        socket.onopen = socket.onmessage = socket.onclose = null
        line.life.end()
        line = null
        socket.close(code)
        runs = []
        sent = 0
        first = next
        cutTurn()
      }

      const who = (from: number, to: number): Speaker => {
        const by: Record<Speaker, number> = { self: 0, other: 0, unknown: 0 }
        for (const run of runs)
          by[run.speaker] += Math.max(0, Math.min(run.end, to * BYTES_PER_S) - Math.max(run.start, from * BYTES_PER_S))
        return most(by)
      }

      const turned = (message: Record<string, unknown>) => {
        const { turn_index: index, transcript, audio_window_start: from, audio_window_end: to } = message
        if (message.type !== 'TurnInfo' || typeof index !== 'number' || typeof transcript !== 'string') return
        const id = first + index
        const words = transcript.trim()
        if (!words || (id < next && growing?.id !== id)) return
        if (growing && growing.id !== id) cutTurn()
        const final = message.event === 'EndOfTurn'
        const until = Number(to) || 0
        const turn: Turn = { id, words, final, cut: false, speaker: who(Number(from) || 0, until) }
        if (!final && growing?.words === words && growing.speaker === turn.speaker) return
        growing = final ? null : turn
        next = id + 1
        if (final) runs = runs.filter(run => run.end > until * BYTES_PER_S)
        say(turn)
      }

      const lost = (code: number) => {
        leave()
        if (FOR_GOOD.has(code)) {
          refused = true
          forget()
          quiet?.cancel()
          return tell('refused')
        }
        failures++
        retry = life.timeout(
          settled(() => {
            retry = undefined
            expire()
            if (heldBytes > 0) connect()
          }),
          retryDelay(failures),
        )
        tell('down')
      }

      const send = ({ pcm, speaker, at: heldAt }: Piece) => {
        for (let at = 0; at < pcm.length; at += PIECE_BYTES) {
          if (!line || line.socket.readyState !== OPEN) return hold({ pcm: pcm.subarray(at), speaker, at: heldAt })
          if (line.socket.bufferedAmount > STALLED_BYTES) {
            lost(0)
            return hold({ pcm: pcm.subarray(at), speaker, at: heldAt })
          }
          const part = pcm.subarray(at, at + PIECE_BYTES)
          line.socket.send(part)
          const last = runs.at(-1)
          if (last?.speaker === speaker) last.end = sent + part.length
          else runs.push({ start: sent, end: sent + part.length, speaker })
          sent += part.length
        }
      }

      function hold(given: Piece): void {
        const piece = { ...given, pcm: new Uint8Array(given.pcm.subarray(-HELD_BYTES - (given.pcm.length % 2))) }
        held.push(piece)
        heldBytes += piece.pcm.length
        while (heldBytes > HELD_BYTES) {
          const oldest = held[0]
          const extra = Math.min(oldest.pcm.length, heldBytes - HELD_BYTES + ((heldBytes - HELD_BYTES) % 2))
          oldest.pcm = oldest.pcm.slice(extra)
          heldBytes -= extra
          if (!oldest.pcm.length) held.shift()
        }
      }

      const sendHeld = () => {
        expire()
        const waiting = held
        forget()
        if (waiting.length) rest()
        waiting.forEach(send)
      }

      function connect(): void {
        let socket: FluxSocket
        try {
          socket = open(url)
        } catch {
          return lost(0)
        }
        const mine = { socket, life: new Lifetime(), connected: false }
        line = mine
        socket.binaryType = 'arraybuffer'
        mine.life.timeout(
          settled(() => lost(0)),
          CONNECT_MS,
        )
        socket.onopen = () => socket.send(hello)
        socket.onclose = settled(event => lost(event.code))
        socket.onmessage = settled(event => {
          const message = parse(event.data)
          if (!message) return
          if (message.type !== 'Connected') return turned(message)
          mine.connected = true
          mine.life.end()
          failures = 0
          sendHeld()
          if (line === mine) tell('on')
        })
      }

      const rest = () => {
        quiet?.cancel()
        quiet = life.timeout(
          settled(() => {
            expire()
            if (heldBytes > 0) return rest()
            leave(1000)
          }),
          QUIET_MS,
        )
      }

      life.own(() => {
        retry?.cancel()
        quiet?.cancel()
        leave(1000)
        forget()
        news.length = 0
      })

      return settled(sound => {
        if (life.ended || refused) return
        const piece = { pcm: sound.pcm, speaker: sound.speaker, at: now() }
        if (sound.gap) {
          forget()
          if (line?.connected && sent > 0) leave(1000)
        }
        if (!sound.pcm.length) return
        rest()
        if (line?.connected) return send(piece)
        hold(piece)
        if (!line && !retry) connect()
      })
    },
  }
}
