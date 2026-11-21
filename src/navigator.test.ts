import { describe, expect, it } from 'vitest'
import { action } from './action.js'
import { BACK, HOME, MAX_OPTIONS, matchWords, navigator, questionFor, type Choice, type Heard, type Question } from './navigator.js'

const notes = [
  { id: 'welcome', say: 'Welcome', value: 1 },
  { id: 'voice', say: 'Voice', value: 2 },
  { id: 'diary', say: 'Diary', value: 3, private: true },
]
const open = action({ id: 'open', say: 'Open note', targets: () => notes, run: () => {} })
const remove = action({ id: 'delete', say: 'Delete note', targets: () => notes, run: () => {} })
const refresh = action({ id: 'refresh', say: 'Refresh', run: () => {} })
const heard = (words: string, more: Partial<Heard> = {}): Heard => ({
  words,
  actions: [open, remove, refresh],
  canGoBack: true,
  hasNext: true,
  ...more,
})
const says = (question: Question) => question.options.map(option => option.say)

describe('the question', () => {
  it("offers Earshot's own options, then the actions, then each action on each target", () => {
    expect(says(questionFor(heard('x')).question)).toEqual([
      'Go back',
      'Go home',
      'Not a navigation command',
      'None of these',
      'Open note',
      'Delete note',
      'Refresh',
      'Open note: Welcome',
      'Open note: Voice',
      'Delete note: Welcome',
      'Delete note: Voice',
    ])
  })

  it('offers going back only when there is somewhere to go, and passing on only when another agent follows', () => {
    expect(says(questionFor(heard('x', { canGoBack: false, hasNext: false })).question).slice(0, 2)).toEqual(['None of these', 'Open note'])
  })

  it('never offers a private target (E6)', () => {
    expect(says(questionFor(heard('x')).question).join(' ')).not.toContain('Diary')
  })

  it('carries the words and gives every option its own id', () => {
    const { question } = questionFor(heard('open voice'))
    expect(question.words).toBe('open voice')
    expect(new Set(question.options.map(option => option.id)).size).toBe(question.options.length)
  })

  it('stops at the most options the model takes', () => {
    const many = action({
      id: 'many',
      say: 'Pick',
      targets: () => Array.from({ length: 400 }, (_, n) => ({ id: `t${n}`, say: `Item ${n}`, value: n })),
      run: () => {},
    })
    expect(questionFor(heard('x', { actions: [many] })).question.options.length).toBe(MAX_OPTIONS)
  })
})

describe('the navigator', () => {
  const answering = (pick: (question: Question) => Choice) => navigator({ choose: async question => pick(question) })
  const idOf = (question: Question, say: string) => question.options.find(option => option.say === say)!.id

  it('turns a sure choice into an action, with its target', async () => {
    expect(await answering(q => ({ sure: idOf(q, 'Open note: Voice') }))(heard('x'))).toEqual({
      kind: 'sure',
      action: 'open',
      target: 'voice',
    })
    expect(await answering(q => ({ sure: idOf(q, 'Refresh') }))(heard('x'))).toEqual({ kind: 'sure', action: 'refresh' })
    expect(await answering(q => ({ sure: idOf(q, 'Go back') }))(heard('x'))).toEqual({ kind: 'sure', action: BACK })
    expect(await answering(q => ({ sure: idOf(q, 'Go home') }))(heard('x'))).toEqual({ kind: 'sure', action: HOME })
  })

  it('passes the words on, or stops, when the model says so', async () => {
    expect(await answering(q => ({ sure: idOf(q, 'Not a navigation command') }))(heard('x'))).toEqual({ kind: 'notMine' })
    expect(await answering(q => ({ sure: idOf(q, 'None of these') }))(heard('x'))).toEqual({ kind: 'none' })
  })

  it('treats an option that was not offered as no match', async () => {
    expect(await answering(() => ({ sure: 'o999' }))(heard('x'))).toEqual({ kind: 'none' })
    expect(await answering(() => ({ unsure: ['o999', 'made-up'] }))(heard('x'))).toEqual({ kind: 'none' })
  })

  it('gives the few candidates when the model is unsure, and is sure when only one of them is real', async () => {
    const two = await answering(q => ({ unsure: [idOf(q, 'Open note: Voice'), idOf(q, 'Delete note: Voice'), idOf(q, 'None of these')] }))(
      heard('x'),
    )
    expect(two).toEqual({
      kind: 'unsure',
      candidates: [
        { action: 'open', target: 'voice', say: 'Open note: Voice' },
        { action: 'delete', target: 'voice', say: 'Delete note: Voice' },
      ],
    })
    expect(await answering(q => ({ unsure: [idOf(q, 'Refresh'), 'o999'] }))(heard('x'))).toEqual({ kind: 'sure', action: 'refresh' })
  })
})

describe('the offline stand-in', () => {
  const offline = navigator(matchWords)

  it('picks the option whose words were said', async () => {
    expect(await offline(heard('open voice'))).toEqual({ kind: 'sure', action: 'open', target: 'voice' })
    expect(await offline(heard('Please REFRESH now'))).toEqual({ kind: 'sure', action: 'refresh' })
    expect(await offline(heard('open note'))).toEqual({ kind: 'sure', action: 'open' })
    expect(await offline(heard('go back'))).toEqual({ kind: 'sure', action: BACK })
  })

  it('is unsure between options that match as well as each other', async () => {
    const verdict = await offline(heard('welcome'))
    expect(verdict.kind).toBe('unsure')
    expect(verdict.kind === 'unsure' && verdict.candidates.map(candidate => candidate.say)).toEqual([
      'Open note: Welcome',
      'Delete note: Welcome',
    ])
  })

  it('passes on words that match nothing, or stops when no agent follows', async () => {
    expect(await offline(heard('what is the weather'))).toEqual({ kind: 'notMine' })
    expect(await offline(heard('what is the weather', { hasNext: false }))).toEqual({ kind: 'none' })
  })
})
