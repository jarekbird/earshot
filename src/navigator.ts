import type { Action } from './action.js'
import type { Audio } from './audio.js'
import type { Lifetime } from './lifetime.js'
import type { RollingItem } from './rolling.js'

export interface Option {
  id: string
  say: string
  context?: string
  role?: 'pass' | 'none'
}

export interface Question {
  words: string
  screen?: string
  options: Option[]
}

export interface NavigatorModel {
  choose(question: Question, life?: Lifetime): Promise<Record<string, number>>
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
  audio?: Audio
  life?: Lifetime
  actions: readonly Action[]
  rolling: readonly RollingItem[]
  hasNext: boolean
  otherwise?: string
  screen?: string
}

export type Agent = (heard: Heard) => Verdict | Promise<Verdict>

// Jev takes at most 255 options in one question.
export const MAX_OPTIONS = 255
export const QUESTION_LIMIT = 240_000
export const SURE_AT = 0.7
const UNSURE_FROM = 0.15
const UNSURE_AT_MOST = 3
const STANDARD = ['back', 'home']
const PASS = 'pass'
const LIST = ' (show the list)'
const NONE = 'none'

type Meaning = Pick | typeof PASS | typeof NONE

export function questionFor(heard: Heard): { question: Question; meanings: Map<string, Meaning> } {
  const meanings = new Map<string, Meaning>()
  const options: Option[] = []
  let length = heard.words.length + (heard.screen?.length ?? 0)
  const offer = (meaning: Meaning, option: Omit<Option, 'id'>) => {
    const id = `o${options.length}`
    meanings.set(id, meaning)
    options.push({ id, ...option })
    length += option.say.length + (option.context?.length ?? 0)
  }
  const offered = new Set<string>()
  const offerAction = (action: Action) => {
    const hint = action.hint === undefined ? {} : { context: action.hint }
    const targets = action.targets() ?? []
    const named = targets.filter(target => !target.private)
    const alone = named.length ? `${action.say}${LIST}` : action.say
    if (targets.length !== 1 || named.length !== 1) offer({ action: action.id, say: action.say }, { say: alone, ...hint })
    for (const target of named) {
      if (options.length >= MAX_OPTIONS) return
      const say = `${action.say}: ${target.say}`
      const rolled = heard.rolling.find(item => item.action.id === action.id && item.target === target.id)
      offered.add(`${action.id}\n${target.id}`)
      offer({ action: action.id, target: target.id, say }, { say, ...(rolled?.context ? { context: rolled.context } : hint) })
    }
  }

  for (const id of STANDARD) heard.actions.filter(action => action.id === id).forEach(offerAction)
  if (heard.hasNext) offer(PASS, { say: heard.otherwise ?? 'Not a navigation command', role: 'pass' })
  offer(NONE, { say: 'None of these', role: 'none' })
  heard.actions.filter(action => !STANDARD.includes(action.id)).forEach(offerAction)

  let full = false
  const rolling = heard.rolling.filter(item => !offered.has(`${item.action.id}\n${item.target}`))
  for (const item of rolling.slice(0, Math.max(0, MAX_OPTIONS - options.length))) {
    full ||= length + item.say.length + item.context.length > QUESTION_LIMIT
    offer(
      { action: item.action.id, target: item.target, say: item.say },
      { say: item.say, ...(item.context && !full ? { context: item.context } : {}) },
    )
  }
  return { question: { words: heard.words, ...(heard.screen ? { screen: heard.screen } : {}), options }, meanings }
}

const verdictOf = (meaning: Meaning): Verdict => {
  if (meaning === PASS) return { kind: 'notMine' }
  if (meaning === NONE) return { kind: 'none' }
  return { kind: 'sure', action: meaning.action, ...(meaning.target === undefined ? {} : { target: meaning.target }) }
}

export function navigator(model: NavigatorModel): Agent {
  return async heard => {
    const { question, meanings } = questionFor(heard)
    const ranked = Object.entries(await model.choose(question, heard.life))
      .flatMap(([id, chance]) => {
        const meaning = meanings.get(id)
        return meaning === undefined ? [] : [{ meaning, chance }]
      })
      .sort((a, b) => b.chance - a.chance)
    if (ranked.length === 0) return { kind: 'none' }
    if (ranked[0].chance >= SURE_AT) return verdictOf(ranked[0].meaning)
    const candidates = ranked
      .filter(({ chance }) => chance >= UNSURE_FROM)
      .flatMap(({ meaning }) => (meaning === PASS || meaning === NONE ? [] : [meaning]))
      .slice(0, UNSURE_AT_MOST)
    if (candidates.length) return { kind: 'unsure', candidates }
    return ranked[0].meaning === PASS ? { kind: 'notMine' } : { kind: 'none' }
  }
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

export const matchWords: NavigatorModel = {
  async choose({ words, options }) {
    const said = new Set(tokens(words))
    const scored = options
      .filter(option => option.role === undefined)
      .map(option => {
        const wanted = tokens(option.say.endsWith(LIST) ? option.say.slice(0, -LIST.length) : option.say)
        const matched = wanted.filter(token => said.has(token)).length
        return { id: option.id, matched, share: wanted.length ? matched / wanted.length : 0 }
      })
      .filter(score => score.matched > 0)
      .sort((a, b) => b.share - a.share || b.matched - a.matched)
    const best = scored.filter(score => score.share === scored[0].share && score.matched === scored[0].matched).slice(0, UNSURE_AT_MOST)
    if (best.length) return Object.fromEntries(best.map(score => [score.id, 1 / best.length]))
    const fallback = options.find(option => option.role === 'pass') ?? options.find(option => option.role === 'none')
    return fallback ? { [fallback.id]: 1 } : {}
  },
}
