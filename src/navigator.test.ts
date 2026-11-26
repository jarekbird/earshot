import { describe, expect, it } from 'vitest'
import { action } from './action.js'
import { Lifetime } from './lifetime.js'
import { MAX_OPTIONS, matchWords, navigator, questionFor, QUESTION_LIMIT, SAME, SURE_AT, type Heard, type Question } from './navigator.js'
import type { RollingItem } from './rolling.js'

const back = action({ id: 'back', say: 'Go back', run: () => {} })
const home = action({ id: 'home', say: 'Go home', run: () => {} })
const notes = [
  { id: 'welcome', say: 'Welcome', value: 1 },
  { id: 'voice', say: 'Voice', value: 2 },
]
const open = action({ id: 'open', say: 'Open note', hint: 'To read a note', targets: () => notes, run: () => {} })
const remove = action({ id: 'delete', say: 'Delete note', targets: () => notes, run: () => {} })
const refresh = action({ id: 'refresh', say: 'Refresh', run: () => {} })
const item = (from: typeof open, target: string, context = ''): RollingItem => ({
  action: from,
  target,
  say: `${from.say}: ${notes.find(note => note.id === target)!.say}`,
  context,
})
const heard = (words: string, more: Partial<Heard> = {}): Heard => ({
  words,
  actions: [open, remove, refresh, back, home],
  rolling: [item(open, 'voice', 'About hold to talk'), item(remove, 'welcome')],
  hasNext: true,
  ...more,
})
const says = (question: Question) => question.options.map(option => option.say)

describe('the question', () => {
  it("offers Earshot's own options, then the actions in the app's order, each with its choices, then the rolling items", () => {
    const elsewhere = action({ id: 'thread', say: 'Open thread', targets: () => [{ id: 't1', say: 'Billing', value: 1 }], run: () => {} })
    const rolling = [
      { action: elsewhere, target: 't1', say: 'Open thread: Billing', context: '' },
      item(open, 'voice', 'About hold to talk'),
    ]
    expect(says(questionFor(heard('x', { rolling })).question)).toEqual([
      'Go back',
      'Go home',
      'Not a navigation command',
      'None of these',
      'Open note (show the list)',
      'Open note: Welcome',
      'Open note: Voice',
      'Delete note (show the list)',
      'Delete note: Welcome',
      'Delete note: Voice',
      'Refresh',
      'Open thread: Billing',
    ])
  })

  it('offers a choice once: one that is also a rolling item keeps the text that tells it from the others', () => {
    const { question } = questionFor(heard('x'))
    expect(says(question).filter(say => say === 'Open note: Voice')).toHaveLength(1)
    expect(question.options.find(option => option.say === 'Open note: Voice')!.context).toBe('About hold to talk')
    expect(question.options.find(option => option.say === 'Open note: Welcome')!.context).toBe('To read a note')
  })

  it('E6: never offers a private choice, and leaves the action for touch to pick it', () => {
    const secret = action({
      id: 'unlock',
      say: 'Unlock',
      targets: () => [{ id: 'k', say: 'The spare key', value: 1, private: true }],
      run: () => {},
    })
    expect(says(questionFor(heard('x', { actions: [secret], rolling: [] })).question)).toEqual([
      'Not a navigation command',
      'None of these',
      'Unlock',
    ])
  })

  it('names the one choice of an action that has a single choice, and not the action alone', () => {
    const allow = action({ id: 'allow', say: 'Allow', targets: () => [{ id: 'r1', say: 'Run the migration', value: 1 }], run: () => {} })
    const none = action({ id: 'deny', say: 'Deny', targets: () => [], run: () => {} })
    expect(says(questionFor(heard('x', { actions: [allow, none], rolling: [] })).question).slice(2)).toEqual([
      'Allow: Run the migration',
      'Deny',
    ])
  })

  it('offers passing the words on only when another agent follows, in the words the app gives', () => {
    expect(says(questionFor(heard('x', { hasNext: false })).question)).not.toContain('Not a navigation command')
    expect(says(questionFor(heard('x', { otherwise: 'A note to remember' })).question)[2]).toBe('A note to remember')
  })

  it('carries the words, what is on the screen, and the context of an action and of an item', () => {
    const { question } = questionFor(heard('open voice', { screen: 'A list of two notes' }))
    expect(question.words).toBe('open voice')
    expect(question.screen).toBe('A list of two notes')
    const context = (say: string) => question.options.find(option => option.say === say)!.context
    expect(context('Open note (show the list)')).toBe('To read a note')
    expect(context('Open note: Voice')).toBe('About hold to talk')
    expect(context('Refresh')).toBeUndefined()
  })

  it('tells the model what an item from another screen does, when the item has no text of its own', () => {
    const elsewhere = action({
      id: 'thread',
      say: 'Open thread',
      hint: 'Shows one conversation',
      targets: () => [
        { id: 't1', say: 'Billing', value: 1 },
        { id: 't2', say: 'Ana', value: 2 },
      ],
      run: () => {},
    })
    const rolling = [
      { action: elsewhere, target: 't1', say: 'Open thread: Billing', context: '' },
      { action: elsewhere, target: 't2', say: 'Open thread: Ana', context: 'She asked about Friday' },
      item(remove, 'welcome'),
    ]
    const { question } = questionFor(heard('x', { actions: [refresh, back, home], rolling }))
    const context = (say: string) => question.options.find(option => option.say === say)!.context
    expect(context('Open thread: Billing')).toBe('Shows one conversation')
    expect(context('Open thread: Ana')).toBe('She asked about Friday')
    expect(context('Delete note: Welcome')).toBeUndefined()
  })

  it('names the action and the target each option would run, so a model of the app tells options apart without reading their words', () => {
    const { question } = questionFor(heard('x'))
    const runs = (say: string) => {
      const { action, target } = question.options.find(option => option.say === say)!
      return [action, target]
    }
    expect(runs('Open note: Voice')).toEqual(['open', 'voice'])
    expect(runs('Open note (show the list)')).toEqual(['open', undefined])
    expect(runs('Refresh')).toEqual(['refresh', undefined])
    expect(runs('Go back')).toEqual(['back', undefined])
    expect(runs('Delete note: Welcome')).toEqual(['delete', 'welcome'])
    expect(runs('None of these')).toEqual([undefined, undefined])
    expect(runs('Not a navigation command')).toEqual([undefined, undefined])
  })

  it('names them for an item from another screen too', () => {
    const elsewhere = action({ id: 'thread', say: 'Open thread', targets: () => [{ id: 't1', say: 'Billing', value: 1 }], run: () => {} })
    const rolling = [{ action: elsewhere, target: 't1', say: 'Open thread: Billing', context: '' }]
    const { question } = questionFor(heard('x', { rolling }))
    expect(question.options.find(option => option.say === 'Open thread: Billing')).toMatchObject({ action: 'thread', target: 't1' })
  })

  it('gives every option its own id', () => {
    const { question } = questionFor(heard('x'))
    expect(new Set(question.options.map(option => option.id)).size).toBe(question.options.length)
  })

  it('leaves out the oldest rolling items when the model can take no more options', () => {
    const many = Array.from({ length: 400 }, (_, n) => ({ ...item(open, 'voice'), say: `Open note: ${n}` }))
    const { question } = questionFor(heard('x', { actions: [refresh, back, home], rolling: many }))
    expect(question.options.length).toBe(MAX_OPTIONS)
    expect(question.options.at(-1)!.say).toBe(`Open note: ${MAX_OPTIONS - 5 - 1}`)
  })

  it('sends only the name of the oldest items once the question is as long as it may be', () => {
    const text = 'x'.repeat(100_000)
    const rolling = [0, 1, 2, 3].map(n => ({ ...item(open, 'voice', text), say: `Open note: ${n}` }))
    const { question } = questionFor(heard('x', { actions: [refresh, back, home], rolling }))
    const sent = question.options.filter(option => option.say.startsWith('Open note: ')).map(option => option.context?.length ?? 0)
    expect(sent).toEqual([100_000, 100_000, 0, 0])
    expect(sent.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(QUESTION_LIMIT)
  })

  it('counts what an action does toward that length too, when it stands in for the text of an item', () => {
    const wordy = action({ id: 'wordy', say: 'Open', hint: 'x'.repeat(100_000), targets: () => notes, run: () => {} })
    const rolling = [0, 1, 2, 3].map(n => ({ action: wordy, target: 'voice', say: `Open: ${n}`, context: '' }))
    const { question } = questionFor(heard('x', { actions: [refresh, back, home], rolling }))
    const sent = question.options.filter(option => option.say.startsWith('Open: ')).map(option => option.context?.length ?? 0)
    expect(sent).toEqual([100_000, 100_000, 0, 0])
  })
})

describe('the navigator', () => {
  const answering = (pick: (question: Question) => Record<string, number>) => navigator({ choose: async question => pick(question) })

  it("hands the model the turn's lifetime, so what it asks for can end with the turn", async () => {
    const life = new Lifetime()
    const got: unknown[] = []
    const agent = navigator({
      choose: async (_question, turn) => {
        got.push(turn)
        return {}
      },
    })
    await agent({ words: 'go back', actions: [], rolling: [], hasNext: false, life })
    expect(got).toEqual([life])
  })
  const idOf = (question: Question, say: string) =>
    question.options.find(option => option.say === say || option.say === `${say} (show the list)`)!.id

  it('is sure of the option the model gives a high enough chance', async () => {
    expect(await answering(q => ({ [idOf(q, 'Open note: Voice')]: SURE_AT, [idOf(q, 'Refresh')]: 1 - SURE_AT }))(heard('x'))).toEqual({
      kind: 'sure',
      action: 'open',
      target: 'voice',
    })
    expect(await answering(q => ({ [idOf(q, 'Refresh')]: 0.9 }))(heard('x'))).toEqual({ kind: 'sure', action: 'refresh' })
    expect(await answering(q => ({ [idOf(q, 'Go back')]: 0.9 }))(heard('x'))).toEqual({ kind: 'sure', action: 'back' })
  })

  it('passes the words on, or stops, when the model says so', async () => {
    expect(await answering(q => ({ [idOf(q, 'Not a navigation command')]: 0.9 }))(heard('x'))).toEqual({ kind: 'notMine' })
    expect(await answering(q => ({ [idOf(q, 'None of these')]: 0.9 }))(heard('x'))).toEqual({ kind: 'none' })
  })

  it('gives the likeliest few to choose from when no option is likely enough', async () => {
    const verdict = await answering(q => ({
      [idOf(q, 'Open note: Voice')]: 0.4,
      [idOf(q, 'Delete note: Welcome')]: 0.3,
      [idOf(q, 'Refresh')]: 0.2,
      [idOf(q, 'Open note')]: 0.16,
      [idOf(q, 'Delete note')]: 0.05,
    }))(heard('x'))
    expect(verdict).toEqual({
      kind: 'unsure',
      candidates: [
        { action: 'open', target: 'voice', say: 'Open note: Voice' },
        { action: 'delete', target: 'welcome', say: 'Delete note: Welcome' },
        { action: 'refresh', say: 'Refresh' },
      ],
    })
  })

  describe('two options that would do the same thing', () => {
    const standingFor = (target: string | undefined) =>
      Object.assign(action({ id: 'this', say: 'Choose this one', run: () => {} }), {
        [SAME]: () => (target === undefined ? undefined : { action: 'open', target }),
      })
    const withThis = (target: string | undefined) => heard('x', { actions: [open, remove, refresh, standingFor(target), back, home] })

    it('count as one: a vote the model split between them is one vote, and what runs is the option that names it', async () => {
      const split = answering(q => ({
        [idOf(q, 'Choose this one')]: 0.45,
        [idOf(q, 'Open note: Welcome')]: 0.45,
        [idOf(q, 'Refresh')]: 0.1,
      }))
      expect(await split(withThis('welcome'))).toEqual({ kind: 'sure', action: 'open', target: 'welcome' })
    })

    it('count as one when the model voted for the one that stands for the other alone', async () => {
      const one = answering(q => ({ [idOf(q, 'Choose this one')]: 0.9 }))
      expect(await one(withThis('welcome'))).toEqual({ kind: 'sure', action: 'open', target: 'welcome' })
    })

    it('are never both in the list to choose from', async () => {
      const unsure = answering(q => ({
        [idOf(q, 'Choose this one')]: 0.3,
        [idOf(q, 'Open note: Welcome')]: 0.3,
        [idOf(q, 'Refresh')]: 0.3,
      }))
      expect(await unsure(withThis('welcome'))).toEqual({
        kind: 'unsure',
        candidates: [
          { action: 'open', target: 'welcome', say: 'Open note: Welcome' },
          { action: 'refresh', say: 'Refresh' },
        ],
      })
    })

    it('are both still put to the model, each in its own words', () => {
      expect(says(questionFor(withThis('welcome')).question).filter(say => /Choose this one|Open note: Welcome/.test(say))).toEqual([
        'Open note: Welcome',
        'Choose this one',
      ])
    })

    it('are told to the model: the one names the other it counts toward, so a wrapper of the model can add them up as the navigator does', () => {
      const { options } = questionFor(withThis('welcome')).question
      const named = options.find(option => option.say === 'Open note: Welcome')!
      expect(options.find(option => option.say === 'Choose this one')!.same).toBe(named.id)
      expect(options.filter(option => option.same !== undefined)).toHaveLength(1)
      expect(questionFor(withThis('gone')).question.options.filter(option => option.same !== undefined)).toEqual([])
    })

    it('stay one when the model it asked changed the question it was handed', async () => {
      const meddling = navigator({
        choose: async question => {
          const chosen = { [idOf(question, 'Choose this one')]: 0.45, [idOf(question, 'Open note: Welcome')]: 0.45 }
          for (const option of question.options) delete option.same
          return chosen
        },
      })
      expect(await meddling(withThis('welcome'))).toEqual({ kind: 'sure', action: 'open', target: 'welcome' })
    })

    it('are two when the other is not in the question: an action that stands for nothing offered runs as itself', async () => {
      const one = answering(q => ({ [idOf(q, 'Choose this one')]: 0.9 }))
      expect(await one(withThis('gone'))).toEqual({ kind: 'sure', action: 'this' })
      expect(await one(withThis(undefined))).toEqual({ kind: 'sure', action: 'this' })
    })

    it('are two for another row: only the row an action stands for is counted with it', async () => {
      const split = answering(q => ({ [idOf(q, 'Choose this one')]: 0.45, [idOf(q, 'Open note: Voice')]: 0.45 }))
      expect((await split(withThis('welcome'))).kind).toBe('unsure')
    })
  })

  it('asks even about a single candidate that is not likely enough, and never lists its own two answers', async () => {
    expect(await answering(q => ({ [idOf(q, 'Refresh')]: 0.5, [idOf(q, 'None of these')]: 0.3 }))(heard('x'))).toEqual({
      kind: 'unsure',
      candidates: [{ action: 'refresh', say: 'Refresh' }],
    })
  })

  it('follows the likeliest of its own two answers when nothing else is likely at all', async () => {
    expect(await answering(q => ({ [idOf(q, 'Not a navigation command')]: 0.5, [idOf(q, 'None of these')]: 0.45 }))(heard('x'))).toEqual({
      kind: 'notMine',
    })
    expect(await answering(q => ({ [idOf(q, 'None of these')]: 0.5, [idOf(q, 'Refresh')]: 0.1 }))(heard('x'))).toEqual({ kind: 'none' })
  })

  it('treats an option that was not offered, or no answer, as no match', async () => {
    expect(await answering(() => ({ o999: 1 }))(heard('x'))).toEqual({ kind: 'none' })
    expect(await answering(() => ({}))(heard('x'))).toEqual({ kind: 'none' })
  })
})

describe('the offline stand-in', () => {
  const offline = navigator(matchWords)

  it('picks the option whose words were said', async () => {
    expect(await offline(heard('open voice'))).toEqual({ kind: 'sure', action: 'open', target: 'voice' })
    expect(await offline(heard('Please REFRESH now'))).toEqual({ kind: 'sure', action: 'refresh' })
    expect(await offline(heard('open note'))).toEqual({ kind: 'sure', action: 'open' })
    expect(await offline(heard('go back'))).toEqual({ kind: 'sure', action: 'back' })
  })

  it('is unsure between options that match as well as each other', async () => {
    const verdict = await offline(heard('note'))
    expect(verdict.kind === 'unsure' && verdict.candidates.map(candidate => candidate.say)).toEqual(['Open note', 'Delete note'])
  })

  it('matches the name of an action, not the words that say it shows a list', async () => {
    const { question } = questionFor(heard('show the list'))
    expect(await matchWords.choose(question)).toEqual({ [question.options.find(option => option.role === 'pass')!.id]: 1 })
  })

  it('passes on words that match nothing, or stops when no agent follows', async () => {
    expect(await offline(heard('what is the weather'))).toEqual({ kind: 'notMine' })
    expect(await offline(heard('what is the weather', { hasNext: false }))).toEqual({ kind: 'none' })
  })
})
