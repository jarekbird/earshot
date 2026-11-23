export const SAMPLE_RATE = 16_000
export const MIN_SPEECH_MS = 500
export const SILENCE_PEAK = 250
const BYTES_PER_SECOND = SAMPLE_RATE * 2

export interface Audio {
  pcm: Uint8Array
  seconds: number
}

export type Speaker = 'self' | 'other' | 'unknown'

export interface Sound {
  pcm: Uint8Array
  speaker: Speaker
}

export function scriptedSpeech(lines: readonly string[]): (audio: Audio) => Promise<string> {
  const left = [...lines]
  return async () => left.shift() ?? ''
}

export function joinPcm(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return joined
}

export const secondsOf = (pcm: Uint8Array): number => pcm.length / BYTES_PER_SECOND

const SPLIT_SEARCH_S = 10
const SPLIT_STEP_S = 0.1

function quietestEnd(pcm: Uint8Array, from: number, to: number): number {
  const step = SPLIT_STEP_S * BYTES_PER_SECOND
  let best = to
  let bestPeak = Infinity
  for (let end = to; end - step >= from; end -= step) {
    const peak = peakOf(pcm.subarray(end - step, end))
    if (peak < bestPeak) [best, bestPeak] = [end - step / 2, peak]
  }
  return best
}

export function splitPcm(pcm: Uint8Array, maxSeconds: number): Uint8Array[] {
  const most = Math.floor(maxSeconds * SAMPLE_RATE) * 2
  const parts: Uint8Array[] = []
  let start = 0
  while (pcm.length - start > most) {
    const end = quietestEnd(pcm, start + most - SPLIT_SEARCH_S * BYTES_PER_SECOND, start + most)
    parts.push(pcm.subarray(start, end))
    start = end
  }
  parts.push(pcm.subarray(start))
  return parts
}

export function peakOf(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
  let peak = 0
  for (let at = 0; at < view.byteLength; at += 2) peak = Math.max(peak, Math.abs(view.getInt16(at, true)))
  return peak
}

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
export const QUIET = LEVELS[0]

export function levelOf(pcm: Uint8Array): string {
  const share = Math.log10(1 + peakOf(pcm) / 120) / Math.log10(1 + 32_768 / 120)
  return LEVELS[Math.round(Math.max(0, Math.min(1, share)) * (LEVELS.length - 1))]
}

export function problemWith(pcm: Uint8Array): 'short' | 'silent' | null {
  if (secondsOf(pcm) * 1000 < MIN_SPEECH_MS) return 'short'
  return peakOf(pcm) < SILENCE_PEAK ? 'silent' : null
}

export function toWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length)
  const view = new DataView(wav.buffer)
  const tag = (at: number, text: string) => [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  tag(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, BYTES_PER_SECOND, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, pcm.length, true)
  wav.set(pcm, 44)
  return wav
}
