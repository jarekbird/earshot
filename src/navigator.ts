import type { Action, Risk, TargetInfo } from './action.js'
import type { Audio } from './audio.js'
import type { Lifetime } from './lifetime.js'
import type { RollingItem } from './rolling.js'

export interface Option {
  id: string
  say: string
  context?: string
  role?: 'pass' | 'none'
  action?: string
  target?: string
  same?: string
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
export const SAME = Symbol('what an action stands for: a row of a list, as it is shown')
export interface Meant {
  listed: Action
  action: string
  target: string
  say: string
  label: string
  hint: string | undefined
  risk: Risk
}
type Standing = Action & { [SAME]?: () => Meant | undefined }
interface Source {
  action: Action
  row?: TargetInfo
}
const PASS = 'pass'
const LIST = ' (show the list)'
const NONE = 'none'

type Meaning = Pick | typeof PASS | typeof NONE

const rowSay = (action: string, row: string) => `${action}: ${row}`

export function questionFor(heard: Heard): { question: Question; meanings: Map<string, Meaning>; stood: Map<string, Meant> } {
  const meanings = new Map<string, Meaning>()
  const options: Option[] = []
  let length = heard.words.length + (heard.screen?.length ?? 0)
  const sources = new Map<Option, Source>()
  const offer = (meaning: Meaning, option: Omit<Option, 'id' | 'action' | 'target' | 'same'>, source?: Source) => {
    const id = `o${options.length}`
    const runs =
      typeof meaning === 'object' ? { action: meaning.action, ...(meaning.target === undefined ? {} : { target: meaning.target }) } : {}
    const made = { id, ...option, ...runs }
    meanings.set(id, meaning)
    options.push(made)
    if (source) sources.set(made, source)
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
      const say = rowSay(action.say, target.say)
      const rolled = heard.rolling.find(item => item.action.id === action.id && item.target === target.id)
      offered.add(`${action.id}\n${target.id}`)
      offer(
        { action: action.id, target: target.id, say },
        { say, ...(rolled?.context ? { context: rolled.context } : hint) },
        { action, row: target },
      )
    }
  }

  for (const id of STANDARD) heard.actions.filter(action => action.id === id).forEach(offerAction)
  if (heard.hasNext) offer(PASS, { say: heard.otherwise ?? 'Not a navigation command', role: 'pass' })
  offer(NONE, { say: 'None of these', role: 'none' })
  heard.actions.filter(action => !STANDARD.includes(action.id)).forEach(offerAction)

  let full = false
  const rolling = heard.rolling.filter(item => !offered.has(`${item.action.id}\n${item.target}`))
  for (const item of rolling.slice(0, Math.max(0, MAX_OPTIONS - options.length))) {
    const context = item.context || item.action.hint || ''
    full ||= length + item.say.length + context.length > QUESTION_LIMIT
    offer(
      { action: item.action.id, target: item.target, say: item.say },
      { say: item.say, ...(context && !full ? { context } : {}) },
      { action: item.action },
    )
  }
  const offering = (action: string, target?: string) => options.find(option => option.action === action && option.target === target)
  const stood = new Map<string, Meant>()
  for (const action of heard.actions as readonly Standing[]) {
    const stands = action[SAME]?.()
    const from = stands && offering(action.id)
    if (!stands || !from) continue
    const to = offering(stands.action, stands.target)
    const named = to && sources.get(to)
    stood.set(from.id, stands)
    if (to && named && oneChoice(to, named, stands)) from.same = to.id
  }
  return { question: { words: heard.words, ...(heard.screen ? { screen: heard.screen } : {}), options }, meanings, stood }
}

function oneChoice(to: Option, named: Source, { listed, say, label, hint, risk }: Meant): boolean {
  if (to.say !== rowSay(label, say)) return false
  if (named.action === listed) return true
  return named.row !== undefined && to.context === hint && (named.row.risk ?? named.action.risk) === risk
}

const verdictOf = (meaning: Meaning): Verdict => {
  if (meaning === PASS) return { kind: 'notMine' }
  if (meaning === NONE) return { kind: 'none' }
  return { kind: 'sure', action: meaning.action, ...(meaning.target === undefined ? {} : { target: meaning.target }) }
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
const nameOf = (option: Option) => tokens(option.say.endsWith(LIST) ? option.say.slice(0, -LIST.length) : option.say)

function saidByName({ words, options }: Question, actions: readonly Action[]): { id: string; by: string[] } | undefined {
  const said = tokens(words).join(' ')
  if (!said) return undefined
  const alone = (option: Option) => (option.target === undefined ? actions.find(action => action.id === option.action)?.say : undefined)
  const fits = (text: string | undefined) => text !== undefined && tokens(text).join(' ') === said
  const named = options.filter(option => option.role === undefined && (fits(option.say) || fits(alone(option))))
  const meant = new Set(named.map(option => option.same ?? option.id))
  return meant.size === 1 ? { id: [...meant][0], by: named.map(option => option.id) } : undefined
}

export function navigator(model: NavigatorModel): Agent {
  return navigatorNoting(model, () => {})
}

export function navigatorNoting(model: NavigatorModel, meant: (stood: Meant, as: Pick) => void): Agent {
  return async heard => {
    const { question, meanings, stood } = questionFor(heard)
    const tell = (from: string, as: Pick) => {
      const chosen = stood.get(from)
      if (chosen) meant(chosen, as)
    }
    const said = saidByName(question, heard.actions)
    const named = said && meanings.get(said.id)
    if (said && named !== undefined) {
      if (named !== PASS && named !== NONE && said.by.every(by => stood.has(by))) for (const by of said.by) tell(by, named)
      return verdictOf(named)
    }
    const same = question.options.flatMap(option => (option.same === undefined ? [] : [[option.id, option.same]]))
    const chances = { ...(await model.choose(question, heard.life)) }
    const needed = new Map<string, string>()
    for (const [from, to] of same) {
      if (!Object.hasOwn(chances, from)) continue
      const named = Object.hasOwn(chances, to) ? chances[to] : 0
      if (named < SURE_AT && chances[from] > 0) needed.set(to, from)
      chances[to] = named + chances[from]
      delete chances[from]
    }
    const ranked = Object.entries(chances)
      .flatMap(([id, chance]) => {
        const meaning = meanings.get(id)
        return meaning === undefined ? [] : [{ id, meaning, chance }]
      })
      .sort((a, b) => b.chance - a.chance)
    if (ranked.length === 0) return { kind: 'none' }
    if (ranked[0].chance >= SURE_AT) {
      const { id, meaning } = ranked[0]
      if (meaning !== PASS && meaning !== NONE) tell(needed.get(id) ?? id, meaning)
      return verdictOf(meaning)
    }
    const candidates = ranked
      .filter(({ chance }) => chance >= UNSURE_FROM)
      .flatMap(({ id, meaning }) => (meaning === PASS || meaning === NONE ? [] : [{ id, meaning }]))
      .slice(0, UNSURE_AT_MOST)
      .map(({ id, meaning }) => (tell(needed.get(id) ?? id, meaning), meaning))
    if (candidates.length) return { kind: 'unsure', candidates }
    return ranked[0].meaning === PASS ? { kind: 'notMine' } : { kind: 'none' }
  }
}

export const matchWords: NavigatorModel = {
  async choose({ words, options }) {
    const said = new Set(tokens(words))
    const scored = options
      .filter(option => option.role === undefined)
      .map(option => {
        const wanted = nameOf(option)
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
