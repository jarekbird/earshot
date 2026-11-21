import type { Action } from './action.js'

export interface Option {
  id: string
  say: string
}

export interface Question {
  words: string
  options: Option[]
}

export type Choice = { sure: string } | { unsure: string[] }

export interface NavigatorModel {
  choose(question: Question): Promise<Choice>
}

export interface Pick {
  action: string
  target?: string
  say: string
}

export type Verdict =
  | { kind: 'sure'; action: string; target?: string }
  | { kind: 'unsure'; candidates: Pick[] }
  | { kind: 'handled'; say?: string }
  | { kind: 'notMine' }
  | { kind: 'none' }

export interface Heard {
  words: string
  actions: readonly Action[]
  canGoBack: boolean
  hasNext: boolean
}

export type Agent = (heard: Heard) => Verdict | Promise<Verdict>

// Jev takes at most 255 options in one question.
export const MAX_OPTIONS = 255
export const BACK = 'earshot.back'
export const HOME = 'earshot.home'
const PASS = 'earshot.pass'
const NONE = 'earshot.none'
const UNSURE_AT_MOST = 3

type Meaning = Pick | typeof PASS | typeof NONE

export function questionFor(heard: Heard): { question: Question; meanings: Map<string, Meaning> } {
  const offered: Meaning[] = []
  if (heard.canGoBack) offered.push({ action: BACK, say: 'Go back' }, { action: HOME, say: 'Go home' })
  if (heard.hasNext) offered.push(PASS)
  offered.push(NONE)
  for (const action of heard.actions) offered.push({ action: action.id, say: action.say })
  for (const action of heard.actions) {
    for (const target of action.targets() ?? []) {
      if (!target.private) offered.push({ action: action.id, target: target.id, say: `${action.say}: ${target.say}` })
    }
  }
  const meanings = new Map(offered.slice(0, MAX_OPTIONS).map((meaning, index) => [`o${index}`, meaning]))
  const say = (meaning: Meaning) => (meaning === PASS ? 'Not a navigation command' : meaning === NONE ? 'None of these' : meaning.say)
  return { question: { words: heard.words, options: [...meanings].map(([id, meaning]) => ({ id, say: say(meaning) })) }, meanings }
}

export function navigator(model: NavigatorModel): Agent {
  return async heard => {
    const { question, meanings } = questionFor(heard)
    const choice = await model.choose(question)
    const chosen = ('sure' in choice ? [choice.sure] : choice.unsure).map(id => meanings.get(id))
    if ('sure' in choice) {
      const [meaning] = chosen
      if (meaning === PASS) return { kind: 'notMine' }
      if (!meaning || meaning === NONE) return { kind: 'none' }
      return { kind: 'sure', action: meaning.action, ...(meaning.target === undefined ? {} : { target: meaning.target }) }
    }
    const candidates = chosen.filter(meaning => meaning !== undefined && meaning !== PASS && meaning !== NONE)
    if (candidates.length === 0) return { kind: 'none' }
    if (candidates.length === 1)
      return { kind: 'sure', action: candidates[0].action, ...(candidates[0].target === undefined ? {} : { target: candidates[0].target }) }
    return { kind: 'unsure', candidates }
  }
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

export const matchWords: NavigatorModel = {
  async choose({ words, options }) {
    const said = new Set(tokens(words))
    const fallback =
      options.find(option => option.say === 'Not a navigation command') ?? options.find(option => option.say === 'None of these')
    const scored = options
      .filter(option => option.say !== 'Not a navigation command' && option.say !== 'None of these')
      .map(option => {
        const wanted = tokens(option.say)
        const matched = wanted.filter(token => said.has(token)).length
        return { id: option.id, matched, share: wanted.length ? matched / wanted.length : 0 }
      })
      .filter(score => score.matched > 0)
      .sort((a, b) => b.share - a.share || b.matched - a.matched)
    const best = scored.filter(score => score.share === scored[0].share && score.matched === scored[0].matched)
    if (best.length === 0) return { sure: fallback?.id ?? '' }
    if (best.length === 1) return { sure: best[0].id }
    return { unsure: best.slice(0, UNSURE_AT_MOST).map(score => score.id) }
  },
}
