import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from './context.js'
import { Lifetime } from './lifetime.js'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

const settle = async (ms = 0) => void (await vi.advanceTimersByTimeAsync(ms))
const long = (label: string, length = 30) => label.repeat(Math.ceil(length / label.length)).slice(0, length)

function compactor() {
  const asked: string[] = []
  const answers: ((result: string | Error) => void)[] = []
  const compact = (text: string, limit: number) => {
    asked.push(`${text.slice(0, 4)}:${limit}`)
    return new Promise<string>((done, fail) => answers.push(result => (result instanceof Error ? fail(result) : done(result))))
  }
  return { asked, compact, answer: (result: string | Error) => answers.shift()!(result) }
}

describe('context', () => {
  it('gives short text back as it is, and nothing for a key it was never given', () => {
    const context = new Context(new Lifetime(), { limit: 10 })
    context.set('a', 'short')
    expect(context.get('a')).toBe('short')
    expect(context.get('b')).toBe('')
  })

  it('gives the last characters of long text when nobody compacts', () => {
    const context = new Context(new Lifetime(), { limit: 10 })
    context.set('a', 'the beginning and the end')
    expect(context.get('a')).toBe('nd the end')
  })

  it('compacts long text at once, and uses its last characters until the compaction is back', async () => {
    const { asked, compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', long('abcd'))
    expect(asked).toEqual(['abcd:10'])
    expect(context.get('a')).toBe(long('abcd').slice(-10))
    answer('summary')
    await settle()
    expect(context.get('a')).toBe('summary')
  })

  it('does not ask for a compaction of text that fits, or of the same text twice', async () => {
    const { asked, compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', 'short')
    context.set('b', long('abcd'))
    answer('summary')
    await settle()
    context.set('b', long('abcd'))
    expect(asked).toEqual(['abcd:10'])
    expect(context.get('b')).toBe('summary')
  })

  it('cuts a compaction that came back too long', async () => {
    const { compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', long('abcd'))
    answer('a summary that is far too long')
    await settle()
    expect(context.get('a')).toBe('a summary ')
  })

  it('keeps the last characters when a compaction fails', async () => {
    const { compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', long('abcd'))
    answer(new Error('offline'))
    await settle()
    expect(context.get('a')).toBe(long('abcd').slice(-10))
  })

  it('drops a compaction of text that has changed since, and starts again only once the text is still', async () => {
    const { asked, compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, settleMs: 5_000, compact })
    context.set('a', long('abcd'))
    context.set('a', long('efgh'))
    await settle(3_000)
    context.set('a', long('ijkl'))
    answer('old summary')
    await settle(4_999)
    expect(asked).toEqual(['abcd:10'])
    expect(context.get('a')).toBe(long('ijkl').slice(-10))
    await settle(1)
    expect(asked).toEqual(['abcd:10', 'ijkl:10'])
    answer('new summary')
    await settle()
    expect(context.get('a')).toBe('new summar')
  })

  it('waits for a compaction on its way before it starts the next, even after the text is still', async () => {
    const { asked, compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, settleMs: 5_000, compact })
    context.set('a', long('abcd'))
    context.set('a', long('efgh'))
    await settle(6_000)
    expect(asked).toEqual(['abcd:10'])
    answer('old summary')
    await settle()
    expect(asked).toEqual(['abcd:10', 'efgh:10'])
  })

  it('compacts each key on its own', () => {
    const { asked, compact } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', long('abcd'))
    context.set('b', long('efgh'))
    expect(asked).toEqual(['abcd:10', 'efgh:10'])
  })

  it('forgets a key, and ignores a compaction that comes back for it', async () => {
    const { compact, answer } = compactor()
    const context = new Context(new Lifetime(), { limit: 10, compact })
    context.set('a', long('abcd'))
    context.forget('a')
    answer('summary')
    await settle()
    expect(context.get('a')).toBe('')
  })

  it('asks for nothing after its lifetime ends', async () => {
    const { asked, compact } = compactor()
    const life = new Lifetime()
    const context = new Context(life, { limit: 10, compact })
    life.end()
    context.set('a', long('abcd'))
    await settle(10_000)
    expect(asked).toEqual([])
    expect(context.get('a')).toBe(long('abcd').slice(-10))
  })
})
