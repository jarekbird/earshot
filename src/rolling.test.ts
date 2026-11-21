import { describe, expect, it } from 'vitest'
import { action } from './action.js'
import { Lifetime } from './lifetime.js'
import { Rolling } from './rolling.js'

const notes = [
  { id: 'a', say: 'Alpha', value: 1 },
  { id: 'b', say: 'Beta', value: 2 },
  { id: 'c', say: 'Gamma', value: 3 },
  { id: 'secret', say: 'Diary', value: 4, private: true },
]
const open = action({ id: 'open', say: 'Open', targets: () => notes, run: () => {} })
const send = action({ id: 'send', say: 'Send to', targets: () => notes, run: () => {} })
const says = (rolling: Rolling) => rolling.items().map(item => item.say)

describe('the rolling set', () => {
  it('gives its items newest first, each an action on one of its targets', () => {
    const rolling = new Rolling(new Lifetime())
    rolling.add(open, 'a')
    rolling.add(open, 'b')
    rolling.add(send, 'a')
    expect(rolling.items().map(({ action, target, say }) => [action.id, target, say])).toEqual([
      ['send', 'a', 'Send to: Alpha'],
      ['open', 'b', 'Open: Beta'],
      ['open', 'a', 'Open: Alpha'],
    ])
  })

  it('makes an item that is added again the newest, without holding it twice', () => {
    const rolling = new Rolling(new Lifetime())
    rolling.add(open, 'a')
    rolling.add(open, 'b')
    rolling.add(open, 'a')
    expect(says(rolling)).toEqual(['Open: Alpha', 'Open: Beta'])
  })

  it('lets the oldest item go when it is full', () => {
    const rolling = new Rolling(new Lifetime(), { capacity: 2 })
    rolling.add(open, 'a')
    rolling.add(open, 'b')
    rolling.add(open, 'c')
    expect(says(rolling)).toEqual(['Open: Gamma', 'Open: Beta'])
  })

  it('never takes a private target (E6), or one the action does not have', () => {
    const rolling = new Rolling(new Lifetime())
    rolling.add(open, 'secret', 'my diary')
    rolling.add(open, 'missing')
    expect(rolling.items()).toEqual([])
  })

  it('names a target as it is called now, and drops one that has left', () => {
    const live = [...notes]
    const edit = action({ id: 'edit', say: 'Edit', targets: () => live, run: () => {} })
    const rolling = new Rolling(new Lifetime())
    rolling.add(edit, 'a')
    rolling.add(edit, 'b')
    live[0] = { ...live[0], say: 'Renamed' }
    live.splice(1, 1)
    expect(says(rolling)).toEqual(['Edit: Renamed'])
    live.push(notes[1])
    expect(says(rolling)).toEqual(['Edit: Renamed'])
  })

  it('carries context for an item, fitted to the limit, and keeps it when the item is added again without any', () => {
    const rolling = new Rolling(new Lifetime(), { limit: 10 })
    rolling.add(open, 'a', 'the latest text of the note')
    rolling.add(open, 'b')
    rolling.add(open, 'a')
    expect(rolling.items().map(item => item.context)).toEqual(['f the note', ''])
    rolling.add(open, 'a', 'new')
    expect(rolling.items()[0].context).toBe('new')
  })
})
