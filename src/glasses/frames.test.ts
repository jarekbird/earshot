import { describe, expect, it } from 'vitest'
import type { Screen } from '../router.js'
import { text } from '../view.js'
import { copied, Frames, type Read } from './frames.js'

const screen = (id: string): Screen => ({ id })
const read = (body: string): Read => {
  const view = text({ body })
  if (view.kind !== 'text') throw new Error('not a text')
  return { view, state: { top: 0 } }
}
const body = (frames: Frames, of: Screen) => frames.read(of)?.view.body

describe('the frames a shell asked for', () => {
  it('keeps only those the glasses show, are being sent, or will be sent next, however many were asked while the glasses were behind', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 2 }
    const frames = new Frames(progress)
    const log = screen('log')
    for (let frame = 1; frame <= 500; frame++) frames.asked(frame, log, read(`text ${frame}`))
    expect(frames.kept).toBe(3)
    expect(body(frames, log)).toBe('text 1')
    Object.assign(progress, { shown: 2, menu: 2, text: 2, sending: 500 })
    expect(body(frames, log)).toBe('text 2')
    Object.assign(progress, { shown: 500, menu: 500, text: 500, sending: 0 })
    expect(body(frames, log)).toBe('text 500')
    expect(frames.kept).toBe(1)
  })

  it('counts a swipe from where the last swipe reached until a frame as new is on the glasses, then from what they show', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.swiping(log, read('where the swipe reached'))
    frames.asked(2, log, read('drawn after the swipe'))
    frames.asked(3, log, read('more text'))
    expect(body(frames, log)).toBe('where the swipe reached')
    Object.assign(progress, { shown: 3, menu: 3, text: 3 })
    expect(body(frames, log)).toBe('more text')
  })

  it('lets go of where a swipe reached once a frame as new is on the glasses, also when no swipe follows', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.swiping(log, read('where the swipe reached'))
    frames.asked(2, log, read('after the swipe'))
    expect(frames.kept).toBe(3)
    Object.assign(progress, { shown: 2, menu: 2, text: 2 })
    frames.asked(3, log, read('more text'))
    expect(frames.kept).toBe(2)
  })

  it('counts a swipe from text the glasses have written in place, though the frame it came with is not whole yet', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.asked(2, log, read('written, its menu still to come'))
    progress.text = 2
    expect(body(frames, log)).toBe('written, its menu still to come')
    expect(frames.screen).toBe(log)
    expect(frames.kept).toBe(2)
  })

  it('takes frames in the order of their numbers, also when a later one was told of first', () => {
    const progress = { shown: 0, menu: 0, text: 0, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(2, log, read('second'))
    frames.asked(1, log, read('first'))
    expect(body(frames, log)).toBe('second')
    Object.assign(progress, { shown: 2, menu: 2, text: 2 })
    expect(body(frames, log)).toBe('second')
  })

  it('lets go of what the glasses have moved past as soon as it is told so, with no swipe or draw in between', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.swiping(log, read('where the swipe reached'))
    frames.asked(2, log, read('after the swipe'))
    expect(frames.kept).toBe(3)
    Object.assign(progress, { shown: 2, menu: 2, text: 2 })
    frames.forget()
    expect(frames.kept).toBe(1)
  })

  it('keeps nothing once it is ended', () => {
    const frames = new Frames({ shown: 1, menu: 1, text: 1, sending: 0 })
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.swiping(log, read('where the swipe reached'))
    frames.asked(2, log, read('after the swipe'))
    frames.end()
    expect(frames.kept).toBe(0)
    expect(frames.read(log)).toBeNull()
  })

  it('copies of a view only what is drawn, so nothing else an app hung on it is kept', () => {
    const view = Object.assign(text({ title: 'Log', body: 'words', end: true }), { record: { private: true } })
    if (view.kind !== 'text') throw new Error('not a text')
    expect(copied(view)).toStrictEqual({ kind: 'text', title: 'Log', body: 'words', end: true })
    expect(copied(text({ body: 'words' }) as Read['view'])).toStrictEqual({ kind: 'text', body: 'words' })
  })

  it('lets go of where a swipe reached on a screen that has left the path, though the glasses have drawn nothing since', () => {
    const frames = new Frames({ shown: 1, menu: 1, text: 1, sending: 0 })
    const home = screen('home')
    const log = screen('log')
    frames.asked(1, home, null)
    frames.asked(2, log, read('log'))
    frames.swiping(log, read('where the swipe reached'))
    frames.asked(3, log, read('after the swipe'))
    frames.asked(4, home, null)
    const before = frames.kept
    frames.left(gone => gone === log)
    expect(frames.kept).toBe(before - 1)
    expect(body(frames, log)).not.toBe('where the swipe reached')
  })

  it('keeps of the frame whose menu shows only which screen it was, once newer words are on the glasses', () => {
    const progress = { shown: 1, menu: 1, text: 1, sending: 0 }
    const frames = new Frames(progress)
    const log = screen('log')
    frames.asked(1, log, read('the old words'))
    frames.asked(2, log, read('the words written in place'))
    progress.text = 2
    frames.forget()
    expect(frames.screen).toBe(log)
    expect(frames.texts).toBe(1)
    expect(body(frames, log)).toBe('the words written in place')
  })

  it('counts a second swipe from where the first reached, also when it comes before the first was given its frame', () => {
    const frames = new Frames({ shown: 1, menu: 1, text: 1, sending: 0 })
    const log = screen('log')
    frames.asked(1, log, read('seen'))
    frames.swiping(log, read('where the first reached'))
    expect(body(frames, log)).toBe('where the first reached')
    frames.swiping(log, read('where the second reached'))
    frames.asked(3, log, read('second'))
    frames.asked(2, log, read('first'))
    expect(body(frames, log)).toBe('where the second reached')
  })

  it('says which screen the glasses show, and none before they show any', () => {
    const progress = { shown: 0, menu: 0, text: 0, sending: 0 }
    const frames = new Frames(progress)
    const home = screen('home')
    frames.asked(1, home, null)
    expect(frames.screen).toBeUndefined()
    Object.assign(progress, { shown: 1, menu: 1 })
    expect(frames.screen).toBe(home)
  })
})
