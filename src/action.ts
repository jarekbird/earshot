export type Risk = 'safe' | 'confirm'

export interface Target<T> {
  id: string
  say: string
  value: T
  private?: boolean
}

export interface TargetInfo {
  readonly id: string
  readonly say: string
  readonly private: boolean
}

export type Outcome =
  | { done: true }
  | { done: false; why: 'blocked'; say: string }
  | { done: false; why: 'target' }
  | { done: false; why: 'gone' }
  | { done: false; why: 'unknown' }

export interface Action {
  readonly id: string
  readonly say: string
  readonly hint?: string
  readonly risk: Risk
  blocked(): string | null
  targets(): readonly TargetInfo[] | null
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
  run: (value: T) => void | Promise<void>
}

export function action<T = never>(spec: PlainSpec | TargetSpec<T>): Action {
  const blocked = () => spec.blocked?.() ?? null
  return {
    id: spec.id,
    say: spec.say,
    ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    risk: spec.risk ?? 'safe',
    blocked,
    targets: () => (spec.targets ? spec.targets().map(t => ({ id: t.id, say: t.say, private: t.private ?? false })) : null),
    run: async targetId => {
      const why = blocked()
      if (why !== null) return { done: false, why: 'blocked', say: why }
      if (!spec.targets) {
        await spec.run()
        return { done: true }
      }
      if (targetId === undefined) return { done: false, why: 'target' }
      const target = spec.targets().find(t => t.id === targetId)
      if (!target) return { done: false, why: 'gone' }
      await spec.run(target.value)
      return { done: true }
    },
  }
}
