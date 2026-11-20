import { describe, expect, it, vi } from 'vitest'
import { action } from './action.js'

describe('an action without targets', () => {
  it('runs and reports done', async () => {
    const run = vi.fn()
    const refresh = action({ id: 'refresh', say: 'Refresh', run })
    expect(refresh.targets()).toBeNull()
    expect(refresh.risk).toBe('safe')
    expect(await refresh.run()).toEqual({ done: true })
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not run while blocked, and says why', async () => {
    const run = vi.fn()
    let running = false
    const stop = action({ id: 'stop', say: 'Stop', blocked: () => (running ? null : 'Not running.'), run })
    expect(await stop.run()).toEqual({ done: false, why: 'blocked', say: 'Not running.' })
    expect(run).not.toHaveBeenCalled()
    running = true
    expect(await stop.run()).toEqual({ done: true })
  })

  it('waits for an async run', async () => {
    const order: string[] = []
    const save = action({
      id: 'save',
      say: 'Save',
      run: async () => {
        await Promise.resolve()
        order.push('ran')
      },
    })
    await save.run()
    order.push('returned')
    expect(order).toEqual(['ran', 'returned'])
  })
})

describe('an action with targets', () => {
  const threads = [
    { id: 't1', title: 'Fix the checkout test' },
    { id: 't2', title: 'Release notes' },
  ]
  const make = (list = threads) => {
    const opened: string[] = []
    const open = action({
      id: 'open',
      say: 'Open a thread',
      targets: () => list.map(t => ({ id: t.id, say: t.title, value: t })),
      run: thread => void opened.push(thread.title),
    })
    return { open, opened }
  }

  it('lists what it could mean', () => {
    expect(make().open.targets()).toEqual([
      { id: 't1', say: 'Fix the checkout test', private: false },
      { id: 't2', say: 'Release notes', private: false },
    ])
  })

  it('runs on the target chosen by id', async () => {
    const { open, opened } = make()
    expect(await open.run('t2')).toEqual({ done: true })
    expect(opened).toEqual(['Release notes'])
  })

  it('E5: reports a target that left since it was chosen, and runs nothing', async () => {
    const list = [...threads]
    const { open, opened } = make(list)
    const chosen = open.targets()![1].id
    list.pop()
    expect(await open.run(chosen)).toEqual({ done: false, why: 'gone' })
    expect(opened).toEqual([])
  })

  it('asks for a target when none is given', async () => {
    const { open, opened } = make()
    expect(await open.run()).toEqual({ done: false, why: 'target' })
    expect(opened).toEqual([])
  })

  it('E6: carries the private mark of a target', () => {
    const call = action({
      id: 'call',
      say: 'Call someone',
      targets: () => [{ id: 'c1', say: 'Alex', value: 1, private: true }],
      run: () => {},
    })
    expect(call.targets()).toEqual([{ id: 'c1', say: 'Alex', private: true }])
  })

  it('keeps the risk it was given', () => {
    expect(action({ id: 'archive', say: 'Archive', risk: 'confirm', run: () => {} }).risk).toBe('confirm')
  })
})
