import { describe, expect, it, vi } from 'vitest'
import { action, unless, type Action } from './action.js'
import type { Lifetime } from './lifetime.js'
import { Router, showingsOf, type Screen } from './router.js'

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

  it('tells every listener of a change, and stops telling one that left', () => {
    const router = new Router({ home: screen('list') })
    const first: string[] = []
    const second: string[] = []
    const leave = router.onChange(s => first.push(s.id))
    router.onChange(s => second.push(s.id))
    router.open(screen('thread'))
    leave()
    router.back()
    expect(first).toEqual(['thread'])
    expect(second).toEqual(['thread', 'list'])
  })

  it('tells the app each time the current screen changes, and only then', () => {
    const seen: string[] = []
    const router = new Router({ home: screen('list') })
    router.onChange(s => seen.push(s.id))
    router.open(screen('thread'))
    router.replace(screen('other'))
    router.back()
    router.back()
    router.goHome()
    expect(seen).toEqual(['thread', 'other', 'list'])
  })
})

describe('E10: double tap goes up', () => {
  const ids = (router: Router) => {
    const path: string[] = []
    for (let current = router.current; ; current = router.current) {
      path.unshift(current.id)
      if (!router.back()) return path
    }
  }

  it('a jump replaces the path: back goes to the parent, never to where you were', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread a'))
    router.jump(screen('thread b'))
    expect(router.current.id).toBe('thread b')
    expect(router.back()).toBe(true)
    expect(router.current.id).toBe('list')
  })

  it('a jump opens its whole path under home, in order', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('usage'))
    router.jump(screen('parent'), screen('child'))
    expect(ids(router)).toEqual(['list', 'parent', 'child'])
  })

  it('keeps the screens a jump shares with the old path: they do not leave and enter again', () => {
    const ended: string[] = []
    const entered: string[] = []
    const made = (id: string) =>
      screen(id, {
        enter: life => {
          entered.push(id)
          life.own(() => void ended.push(id))
        },
      })
    const page = made('page')
    const router = new Router({ home: screen('list') })
    router.open(page)
    router.open(made('thread a'))
    entered.length = 0
    router.jump(page, made('thread b'))
    expect(entered).toEqual(['thread b'])
    expect(ended).toEqual(['thread a'])
    expect(router.depth).toBe(3)
  })

  it('a jump to a screen already on the path leaves what was above it', () => {
    const parent = screen('parent')
    const router = new Router({ home: screen('list') })
    router.open(parent)
    router.open(screen('child'))
    const changed: string[] = []
    router.onChange(current => changed.push(current.id))
    router.jump(parent)
    expect(router.current).toBe(parent)
    expect(router.depth).toBe(2)
    expect(changed).toEqual(['parent'])
  })

  it('a jump with no screens goes home', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread'))
    router.jump()
    expect(router.depth).toBe(1)
  })

  it('while a jump runs, each screen opened is the next step of the path from home, even after an await', async () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread a'))
    await router.jumping(async () => {
      await Promise.resolve()
      router.open(screen('parent'))
      router.open(screen('child'))
    })
    expect(ids(router)).toEqual(['list', 'parent', 'child'])
  })

  it('leaves the path alone when what ran opened nothing, and opens a child again once it ended', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread'))
    router.jumping(() => {})
    expect(router.depth).toBe(2)
    router.open(screen('menu'))
    expect(router.depth).toBe(3)
  })

  it('ends the jump when what ran throws', () => {
    const router = new Router({ home: screen('list') })
    router.open(screen('thread'))
    expect(() =>
      router.jumping(() => {
        throw new Error('no')
      }),
    ).toThrow('no')
    router.open(screen('menu'))
    expect(router.depth).toBe(3)
  })

  it("knows an action of the app from the screen's own, by id", () => {
    const refresh = action({ id: 'refresh', say: 'Refresh', run: () => {} })
    const stop = action({ id: 'stop', say: 'Stop', run: () => {} })
    const router = new Router({ home: screen('list', { actions: () => [stop] }), actions: () => [refresh, stop] })
    expect(router.anywhere(refresh)).toBe(true)
    expect(router.anywhere(stop)).toBe(false)
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
    const router = new Router({ home: screen('list') })
    router.onChange(onChange)
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
    expect(router.actions().map(a => a.id)).toEqual(['stop', 'pages', 'refresh', 'back', 'home'])
    router.back()
    expect(router.actions().map(a => a.id)).toEqual(['pages', 'refresh', 'back', 'home'])
  })

  it("let a screen's action replace the app's action of the same id", () => {
    const router = new Router({ home: screen('list'), actions: app })
    router.open(screen('usage', { actions: () => [action({ id: 'refresh', say: 'Refresh usage', run: () => {} })] }))
    expect(router.actions().map(a => a.say)).toEqual(['Refresh usage', 'Pages', 'Go back', 'Go home'])
  })

  it('include going back and going home, which say why not at the home screen', async () => {
    const router = new Router({ home: screen('list') })
    expect(await router.run('back')).toEqual({ done: false, why: 'blocked', say: 'Nothing to go back to' })
    expect(await router.run('home')).toEqual({ done: false, why: 'blocked', say: 'Already at the start' })
    router.open(screen('a'))
    router.open(screen('b'))
    expect(await router.run('back')).toEqual({ done: true })
    expect(router.current.id).toBe('a')
    router.open(screen('b'))
    expect(await router.run('home')).toEqual({ done: true })
    expect(router.current.id).toBe('list')
  })

  it('let an app replace going back or home with an action of the same id', async () => {
    const mine = action({ id: 'back', say: 'Close', run: () => {} })
    const router = new Router({ home: screen('list'), actions: () => [mine] })
    expect(router.actions().map(a => a.say)).toEqual(['Close', 'Go home'])
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

describe('what the shell is told of the showings on the path', () => {
  const screen = (id: string): Screen => ({ id })

  it('tells one showing of a screen from another, and counts each for as long as it is on the path, top or not', () => {
    const log = screen('log')
    const router = new Router({ home: screen('home') })
    router.open(log)
    const first = showingsOf(router).current
    router.open(log)
    const second = showingsOf(router).current
    expect(second).not.toBe(first)
    expect([first, second].map(showingsOf(router).onPath)).toEqual([true, true])
    router.back()
    expect([first, second].map(showingsOf(router).onPath)).toEqual([true, false])
    router.replace(log)
    expect(showingsOf(router).onPath(first)).toBe(false)
  })

  it('tells of every leaving, also when the router is closed, and then counts no showing as on the path', () => {
    const router = new Router({ home: screen('home') })
    router.open(screen('log'))
    const showing = showingsOf(router).current
    let told = 0
    const stop = showingsOf(router).onLeave(() => void told++)
    router.close()
    expect(told).toBe(1)
    expect(showingsOf(router).onPath(showing)).toBe(false)
    stop()
  })
})

describe('what the framework keeps to itself', () => {
  it('adds no member to a router or to an action that an app could see, copy or have to name', () => {
    const made = action({ id: 'a', say: 'A', run: () => {} })
    const router = new Router({ home: { id: 'home' } })
    const named: Record<keyof Action, true> = {
      id: true,
      say: true,
      hint: true,
      risk: true,
      blocked: true,
      targets: true,
      choose: true,
      run: true,
    }
    expect(Object.keys(named)).toHaveLength(8)
    expect([made, router, Router.prototype].flatMap(of => Object.getOwnPropertySymbols(of))).toEqual([])
    expect([typeof unless(made), unless({ ...made }), typeof showingsOf(router).onPath]).toEqual(['function', undefined, 'function'])
  })
})
