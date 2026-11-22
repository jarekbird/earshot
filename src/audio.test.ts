import { describe, expect, it } from 'vitest'
import { joinPcm, levelOf, peakOf, problemWith, scriptedSpeech, secondsOf, splitPcm, SAMPLE_RATE, toWav } from './audio.js'

const tone = (ms: number, loudness: number) => {
  const samples = new Int16Array((16_000 * ms) / 1000)
  for (let at = 0; at < samples.length; at++) samples[at] = Math.round(loudness * Math.sin(at / 5))
  return new Uint8Array(samples.buffer)
}

describe('a recording', () => {
  it('is joined from its pieces, in order', () => {
    expect([...joinPcm([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])])]).toEqual([1, 2, 3])
    expect(joinPcm([]).length).toBe(0)
  })

  it('has a bar for how loud a piece of it is, from the lowest for silence to the highest', () => {
    expect(levelOf(new Uint8Array(320))).toBe('▁')
    expect(levelOf(tone(20, 300))).toBe('▃')
    expect(levelOf(tone(20, 32_000))).toBe('█')
  })

  it('knows how long and how loud it is', () => {
    expect(secondsOf(tone(750, 8_000))).toBe(0.75)
    expect(peakOf(tone(100, 8_000))).toBeGreaterThan(7_900)
    expect(peakOf(new Uint8Array([0x00, 0x80]))).toBe(32_768)
    expect(peakOf(new Uint8Array([0x10, 0x00, 0x7f]))).toBe(16)
    expect(peakOf(new Uint8Array(0))).toBe(0)
  })

  it('is too short under half a second, and silent when nothing in it is loud', () => {
    expect(problemWith(tone(499, 8_000))).toBe('short')
    expect(problemWith(tone(600, 100))).toBe('silent')
    expect(problemWith(tone(600, 8_000))).toBeNull()
    expect(problemWith(new Uint8Array(0))).toBe('short')
  })

  it('becomes a sound file any transcriber reads: 16 kHz, 16 bits, one channel', () => {
    const pcm = tone(100, 8_000)
    const wav = toWav(pcm)
    const view = new DataView(wav.buffer)
    const text = (at: number, length: number) => String.fromCharCode(...wav.subarray(at, at + length))
    expect([text(0, 4), text(8, 8), text(36, 4)]).toEqual(['RIFF', 'WAVEfmt ', 'data'])
    expect([view.getUint32(4, true), view.getUint32(40, true)]).toEqual([36 + pcm.length, pcm.length])
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([
      1, 1, 16_000, 16,
    ])
    expect([...wav.subarray(44, 54)]).toEqual([...pcm.subarray(0, 10)])
  })
})

describe('a long recording', () => {
  const loud = (seconds: number) => new Uint8Array(new Int16Array(seconds * SAMPLE_RATE).map((_, at) => 8_000 * Math.sin(at / 5)).buffer)
  const hush = (seconds: number) => new Uint8Array(seconds * SAMPLE_RATE * 2)

  it('stays whole when it is short enough', () => {
    const pcm = loud(3)
    expect(splitPcm(pcm, 60)).toEqual([pcm])
  })

  it('is cut into parts no longer than the limit, at its quietest moment, with nothing lost', () => {
    const pcm = joinPcm([loud(52), hush(1), loud(30), hush(1), loud(46)])
    const parts = splitPcm(pcm, 60)
    expect(parts.length).toBe(3)
    for (const part of parts) expect(secondsOf(part)).toBeLessThanOrEqual(60)
    expect(secondsOf(parts[0])).toBeGreaterThan(52)
    expect(secondsOf(parts[0])).toBeLessThan(53)
    expect(Buffer.compare(joinPcm(parts), pcm)).toBe(0)
  })

  it('is cut at the limit when it never goes quiet, on a whole sample', () => {
    const parts = splitPcm(loud(130), 60)
    expect(parts.map(part => part.length % 2)).toEqual([0, 0, 0])
    for (const part of parts) expect(secondsOf(part)).toBeLessThanOrEqual(60)
  })
})

describe('scripted speech', () => {
  it('E4: hears the lines it was given, one a recording, then nothing, and calls no service', async () => {
    const lines = ['open voice', 'go back']
    const transcribe = scriptedSpeech(lines)
    const audio = { pcm: new Uint8Array(2), seconds: 1 }
    expect([await transcribe(audio), await transcribe(audio), await transcribe(audio)]).toEqual(['open voice', 'go back', ''])
    expect(lines).toEqual(['open voice', 'go back'])
  })
})
