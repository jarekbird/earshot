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

describe('the frames a shell asked for', () => {
  it('keeps only those the glasses show, are being sent, or will be sent next, however many were asked while the glasses were behind', () => {
    const sent = { shown: 1, sending: 2 }
    const frames = new Frames(sent)
    const log = screen('log')
    for (let frame = 1; frame <= 500; frame++) frames.asked(frame, log, read(`text ${frame}`), null)
    expect(frames.kept).toBe(3)
    expect(frames.read(log)?.view.body).toBe('text 1')
    Object.assign(sent, { shown: 2, sending: 500 })
    expect(frames.read(log)?.view.body).toBe('text 2')
    Object.assign(sent, { shown: 500, sending: 0 })
    expect(frames.read(log)?.view.body).toBe('text 500')
    expect(frames.kept).toBe(1)
  })

  it('counts a swipe from where the last swipe reached until a frame as new is on the glasses, then from what they show', () => {
    const sent = { shown: 1, sending: 0 }
    const frames = new Frames(sent)
    const log = screen('log')
    frames.asked(1, log, read('seen'), null)
    frames.asked(2, log, read('drawn after the swipe'), read('where the swipe reached'))
    frames.asked(3, log, read('more text'), null)
    expect(frames.read(log)?.view.body).toBe('where the swipe reached')
    sent.shown = 3
    expect(frames.read(log)?.view.body).toBe('more text')
  })

  it('says which screen the glasses show, and none before they show any', () => {
    const sent = { shown: 0, sending: 0 }
    const frames = new Frames(sent)
    const home = screen('home')
    frames.asked(1, home, null, null)
    expect(frames.screen).toBeUndefined()
    sent.shown = 1
    expect(frames.screen).toBe(home)
  })
})
