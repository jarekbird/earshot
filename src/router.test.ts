import { describe, expect, it, vi } from 'vitest'
import { action } from './action.js'
import type { Lifetime } from './lifetime.js'
import { Router, type Screen } from './router.js'

const screen = (id: string, more: Partial<Screen> = {}): Screen => ({ id, ...more })

describe('the screen stack', () => {
  it('starts at home', () => {
    const router = new Router({ home: screen('list') })
    expect(router.current.id).toBe('list')
    expect(router.depth).toBe(1)
  })

  it('opens a screen over the current one, and back returns to it', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread'))
    router.open(screen('menu'))
    expect(router.current.id).toBe('menu')
    expect(router.back()).toBe(true)
    expect(router.current.id).toBe('thread')
    expect(router.back()).toBe(true)
    expect(router.current.id).toBe('list')
  })

  it('back at home changes nothing and says so, for the app to exit', () => {
    const router = new Router({ home: screen('list') })
    expect(router.back()).toBe(false)
    expect(router.current.id).toBe('list')
  })

  it('replace swaps the current screen without growing the stack', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread:1'))
    router.replace(screen('thread:2'))
    expect(router.current.id).toBe('thread:2')
    expect(router.depth).toBe(2)
    router.back()
    expect(router.current.id).toBe('list')
  })

  it('replace at home keeps one screen', () => {
    const router = new Router({ home: screen('pinned') })
    router.replace(screen('chats'))
    expect(router.current.id).toBe('chats')
    expect(router.depth).toBe(1)
  })

  it('goHome leaves every screen above home', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread'))
    router.open(screen('menu'))
    router.goHome()
    expect(router.current.id).toBe('list')
    expect(router.depth).toBe(1)
  })

  it('tells the app each time the current screen changes, and only then', () => {
    const seen: string[] = []
    const router = new Router({ home: screen('list'), onChange: s => seen.push(s.id) })
    router.open(screen('thread'))
    router.replace(screen('other'))
    router.back()
    router.back()
    router.goHome()
    expect(seen).toEqual(['thread', 'other', 'list'])
  })
})

describe('E7: what a screen starts ends with it', () => {
  it("ends a screen's lifetime when it leaves the stack, not when another covers it", () => {
    let life: Lifetime | undefined
    const router = new Router({ home: screen('list') })
    router.open(screen('thread', { enter: entered => void (life = entered) }))
    expect(life?.ended).toBe(false)
    router.open(screen('menu'))
    expect(life?.ended).toBe(false)
    router.back()
    expect(life?.ended).toBe(false)
    router.back()
    expect(life?.ended).toBe(true)
    expect(life?.signal.aborted).toBe(true)
  })

  it('ends a replaced screen before the next one enters, and every screen goHome leaves', () => {
    const lives: Lifetime[] = []
    const seen: boolean[][] = []
    const enter = (life: Lifetime) => {
      seen.push(lives.map(l => l.ended))
      lives.push(life)
    }
    const router = new Router({ home: screen('list') })
    router.open(screen('a', { enter }))
    router.replace(screen('b', { enter }))
    router.open(screen('c', { enter }))
    expect(seen).toEqual([[], [true], [true, false]])
    router.goHome()
    expect(lives.map(l => l.ended)).toEqual([true, true, true])
  })

  it('close ends every screen, home included', () => {
    const lives: Lifetime[] = []
    const enter = (life: Lifetime) => void lives.push(life)
    const router = new Router({ home: screen('list', { enter }) })
    router.open(screen('thread', { enter }))
    expect(lives.map(l => l.ended)).toEqual([false, false])
    router.close()
    expect(lives.map(l => l.ended)).toEqual([true, true])
  })

  it('still leaves every screen and reports the change when a cleanup throws, then passes the failure on', () => {
    const ended: string[] = []
    const failing = (id: string) =>
      screen(id, {
        enter: life => {
          life.own(() => ended.push(id))
          life.own(() => {
            throw new Error(`${id} failed`)
          })
        },
      })
    const onChange = vi.fn()
    const router = new Router({ home: screen('list'), onChange })
    router.open(failing('a'))
    router.open(failing('b'))
    onChange.mockClear()
    expect(() => router.goHome()).toThrow(AggregateError)
    expect(ended).toEqual(['b', 'a'])
    expect(router.current.id).toBe('list')
    expect(onChange).toHaveBeenCalledOnce()
  })
})

describe('the actions possible now', () => {
  const app = () => [action({ id: 'pages', say: 'Pages', run: () => {} }), action({ id: 'refresh', say: 'Refresh all', run: () => {} })]

  it("are the current screen's, then the app's", () => {
    const router = new Router({ home: screen('list'), actions: app })
    router.open(screen('thread', { actions: () => [action({ id: 'stop', say: 'Stop', run: () => {} })] }))
    expect(router.actions().map(a => a.id)).toEqual(['stop', 'pages', 'refresh'])
    router.back()
    expect(router.actions().map(a => a.id)).toEqual(['pages', 'refresh'])
  })

  it("let a screen's action replace the app's action of the same id", () => {
    const router = new Router({ home: screen('list'), actions: app })
    router.open(screen('usage', { actions: () => [action({ id: 'refresh', say: 'Refresh usage', run: () => {} })] }))
    expect(router.actions().map(a => a.say)).toEqual(['Refresh usage', 'Pages'])
  })

  it('refuse two actions of one id on a screen', () => {
    const twice = () => [action({ id: 'stop', say: 'Stop', run: () => {} }), action({ id: 'stop', say: 'Halt', run: () => {} })]
    const router = new Router({ home: screen('thread', { actions: twice }) })
    expect(() => router.actions()).toThrow('thread: two actions with id "stop"')
  })

  it('run one by id, with its target', async () => {
    const opened: number[] = []
    const open = action({
      id: 'open',
      say: 'Open',
      targets: () => [{ id: 'a', say: 'First', value: 1 }],
      run: n => void opened.push(n),
    })
    const router = new Router({ home: screen('list', { actions: () => [open] }) })
    expect(await router.run('open', 'a')).toEqual({ done: true })
    expect(opened).toEqual([1])
  })

  it('report an action the current screen does not have', async () => {
    const run = vi.fn()
    const router = new Router({ home: screen('list') })
    router.open(screen('thread', { actions: () => [action({ id: 'stop', say: 'Stop', run })] }))
    router.back()
    expect(await router.run('stop')).toEqual({ done: false, why: 'unknown' })
    expect(run).not.toHaveBeenCalled()
  })
})
