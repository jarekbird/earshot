export type Risk = 'safe' | 'confirm' | 'voice'

export interface Target<T> {
  id: string
  say: string
  value: T
  private?: boolean
  risk?: Risk
}

export interface TargetInfo {
  readonly id: string
  readonly say: string
  readonly private: boolean
  readonly risk?: Risk
}

export type Outcome =
  | { done: true }
  | { done: false; why: 'blocked'; say: string }
  | { done: false; why: 'target' }
  | { done: false; why: 'gone' }
  | { done: false; why: 'unknown' }

type Unless = (targetId: string | undefined, still: () => boolean) => Promise<Outcome>

const UNLESS = new WeakMap<Action, Unless>()

export const unless = (made: Action): Unless | undefined => UNLESS.get(made)

export interface Action {
  readonly id: string
  readonly say: string
  readonly hint?: string
  readonly risk: Risk
  blocked(): string | null
  targets(): readonly TargetInfo[] | null
  choose?(): void
  run(targetId?: string): Promise<Outcome>
}

interface Common {
  id: string
  say: string
  hint?: string
  risk?: Risk
  blocked?: () => string | null
}

export interface PlainSpec extends Common {
  targets?: undefined
  run: () => void | Promise<void>
}

export interface TargetSpec<T> extends Common {
  targets: () => readonly Target<T>[]
  choose?: () => void
  run: (value: T) => void | Promise<void>
}

export function action<T = never>(spec: PlainSpec | TargetSpec<T>): Action {
  const blocked = () => spec.blocked?.() ?? null
  const made: Action = {
    id: spec.id,
    say: spec.say,
    ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    risk: spec.risk ?? 'safe',
    blocked,
    targets: () =>
      spec.targets
        ? spec
            .targets()
            .map(t => ({ id: t.id, say: t.say, private: t.private ?? false, ...(t.risk === undefined ? {} : { risk: t.risk }) }))
        : null,
    ...(spec.targets && spec.choose ? { choose: spec.choose } : {}),
    run: targetId => run(targetId, () => true),
  }
  UNLESS.set(made, run)
  return made

  async function run(targetId: string | undefined, still: () => boolean): Promise<Outcome> {
    const why = blocked()
    if (why !== null) return { done: false, why: 'blocked', say: why }
    if (!spec.targets) {
      const work = spec.run
      if (!still()) return { done: false, why: 'gone' }
      await work.call(spec)
      return { done: true }
    }
    if (targetId === undefined) return { done: false, why: 'target' }
    const target = spec.targets().find(t => t.id === targetId)
    if (!target) return { done: false, why: 'gone' }
    const { value } = target
    const work = spec.run
    if (!still()) return { done: false, why: 'gone' }
    await work.call(spec, value)
    return { done: true }
  }
}
