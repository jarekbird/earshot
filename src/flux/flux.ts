import { SAMPLE_RATE, type Speaker } from '../audio.js'
import { Lifetime, type Timer } from '../lifetime.js'
import { most, type LiveSpeech, type LiveState, type Turn } from '../live.js'

export interface FluxSocket {
  binaryType: string
  readonly bufferedAmount: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number): void
}

export interface FluxOptions {
  host: string
  secret?: string
  model?: string
  staleMs?: number
  open?: (url: string) => FluxSocket
  now?: () => number
}

export const FLUX = '@cf/deepgram/flux'
export const LIVE_PATH = '/api/v1/live'
export const REFUSALS = { hello: 4400, secret: 4401, model: 4403 }
const BYTES_PER_S = SAMPLE_RATE * 2
export const HELD_BYTES = 10 * BYTES_PER_S
export const PIECE_BYTES = BYTES_PER_S
export const QUIET_MS = 10_000
export const CONNECT_MS = 10_000
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 8_000
const FOR_GOOD = new Set<number>(Object.values(REFUSALS))
const THIS_DEVICE = new Set(['localhost', '127.0.0.1', '[::1]'])

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

function lineTo(host: string): string {
  const relay = new URL(host)
  if (relay.protocol !== 'https:' && !THIS_DEVICE.has(relay.hostname))
    throw new Error('Live speech carries a secret and sound, so its relay is named with https.')
  return `${host.replace(/\/+$/, '').replace(/^http/, 'ws')}${LIVE_PATH}`
}

export function fluxLive(options: FluxOptions): LiveSpeech {
  const url = lineTo(options.host)
  const open = options.open ?? (address => new WebSocket(address) as unknown as FluxSocket)
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? Infinity
  const hello = JSON.stringify({
    model: options.model ?? FLUX,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    ...(options.secret ? { secret: options.secret } : {}),
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

      const tell = (now: LiveState) => {
        if (state === now || life.ended) return
        state = now
        told?.(now)
      }

      const say = (turn: Turn) => {
        if (!life.ended) heard(turn)
      }

      const cutTurn = () => {
        if (!growing) return
        const turn = { ...growing, final: true, cut: true }
        growing = null
        say(turn)
      }

      const forget = () => {
        held = []
        heldBytes = 0
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
        cutTurn()
        if (FOR_GOOD.has(code)) {
          refused = true
          forget()
          quiet?.cancel()
          return tell('refused')
        }
        failures++
        retry = life.timeout(() => {
          retry = undefined
          if (heldBytes > 0) connect()
        }, retryDelay(failures))
        tell('down')
      }

      const flush = () => {
        if (!line?.connected) return
        if (line.socket.bufferedAmount > HELD_BYTES) return lost(0)
        for (const { pcm, speaker, at: heldAt } of held) {
          if (now() - heldAt > staleMs) continue
          for (let at = 0; at < pcm.length; at += PIECE_BYTES) line.socket.send(pcm.subarray(at, at + PIECE_BYTES))
          const last = runs.at(-1)
          if (last?.speaker === speaker) last.end = sent + pcm.length
          else runs.push({ start: sent, end: sent + pcm.length, speaker })
          sent += pcm.length
        }
        forget()
      }

      function connect(): void {
        const socket = open(url)
        const mine = { socket, life: new Lifetime(), connected: false }
        line = mine
        socket.binaryType = 'arraybuffer'
        mine.life.timeout(() => lost(0), CONNECT_MS)
        socket.onopen = () => socket.send(hello)
        socket.onclose = event => lost(event.code)
        socket.onmessage = event => {
          const message = parse(event.data)
          if (!message) return
          if (message.type !== 'Connected') return turned(message)
          mine.connected = true
          mine.life.end()
          failures = 0
          flush()
          tell('on')
        }
      }

      const rest = () => {
        quiet?.cancel()
        quiet = life.timeout(() => {
          if (heldBytes > 0) return rest()
          leave(1000)
          cutTurn()
        }, QUIET_MS)
      }

      life.own(() => {
        retry?.cancel()
        quiet?.cancel()
        leave(1000)
        forget()
      })

      const hold = (piece: Piece) => {
        held.push(piece)
        heldBytes += piece.pcm.length
        while (heldBytes > HELD_BYTES) {
          const oldest = held[0]
          const extra = Math.min(oldest.pcm.length, heldBytes - HELD_BYTES + ((heldBytes - HELD_BYTES) % 2))
          oldest.pcm = oldest.pcm.subarray(extra)
          heldBytes -= extra
          if (!oldest.pcm.length) held.shift()
        }
      }

      return sound => {
        if (life.ended || refused) return
        if (sound.gap && line?.connected && sent > 0) {
          leave(1000)
          cutTurn()
          if (life.ended) return
        }
        hold({ pcm: sound.pcm, speaker: sound.speaker, at: now() })
        rest()
        if (line) flush()
        else if (!retry) connect()
      }
    },
  }
}
