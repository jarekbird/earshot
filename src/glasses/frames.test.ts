import { describe, expect, it } from 'vitest'
import type { Screen } from '../router.js'
import { text } from '../view.js'
import { Frames, type Read } from './frames.js'

const screen = (id: string): Screen => ({ id })
const read = (body: string): Read => {
  const view = text({ body })
  if (view.kind !== 'text') throw new Error('not a text')
  return { view, state: { top: 0 } }
}
const body = (frames: Frames, of: Screen) => frames.read(of)?.view.body

describe('the frames a shell asked for', () => {
  it('keeps only those the glasses show, are being sent, or will be sent next, however many were asked while the glasses were behind', () => {
    const progress = { shown: 1, text: 1, sending: 2 }
    const frames = new Frames(progress)
    const log = screen('log')
    for (let frame = 1; frame <= 500; frame++) frames.asked(frame, log, read(`text ${frame}`), null)
    expect(frames.kept).toBe(3)
    expect(body(frames, log)).toBe('text 1')
    Object.assign(progress, { shown: 2, text: 2, sending: 500 })
    expect(body(frames, log)).toBe('text 2')
    Object.assign(progress, { shown: 500, text: 500, sending: 0 })
    expect(body(frames, log)).toBe('text 500')
    expect(frames.kept).toBe(1)
  })

  it('counts a swipe from where the last swipe reached until a frame as new is on the glasses, then from what they show', () => {
    const progress = { shown: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'), null)
    frames.asked(2, log, read('drawn after the swipe'), read('where the swipe reached'))
    frames.asked(3, log, read('more text'), null)
    expect(body(frames, log)).toBe('where the swipe reached')
    Object.assign(progress, { shown: 3, text: 3 })
    expect(body(frames, log)).toBe('more text')
  })

  it('lets go of where a swipe reached once a frame as new is on the glasses, also when no swipe follows', () => {
    const progress = { shown: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'), null)
    frames.asked(2, log, read('after the swipe'), read('where the swipe reached'))
    expect(frames.kept).toBe(3)
    Object.assign(progress, { shown: 2, text: 2 })
    frames.asked(3, log, read('more text'), null)
    expect(frames.kept).toBe(2)
  })

  it('counts a swipe from text the glasses have written in place, though the frame it came with is not whole yet', () => {
    const progress = { shown: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'), null)
    frames.asked(2, log, read('written, its menu still to come'), null)
    progress.text = 2
    expect(body(frames, log)).toBe('written, its menu still to come')
    expect(frames.screen).toBe(log)
    expect(frames.kept).toBe(2)
  })

  it('takes frames in the order of their numbers, also when a later one was told of first', () => {
    const progress = { shown: 0, text: 0, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(2, log, read('second'), null)
    frames.asked(1, log, read('first'), null)
    expect(body(frames, log)).toBe('second')
    Object.assign(progress, { shown: 2, text: 2 })
    expect(body(frames, log)).toBe('second')
  })

  it('says which screen the glasses show, and none before they show any', () => {
    const progress = { shown: 0, text: 0, sending: 0 }
    const frames = new Frames(progress)
    const home = screen('home')
    frames.asked(1, home, null, null)
    expect(frames.screen).toBeUndefined()
    progress.shown = 1
    expect(frames.screen).toBe(home)
  })
})
