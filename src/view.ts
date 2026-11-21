import type { Action } from './action.js'
import type { Box } from './glasses/frame.js'
import type { Input } from './glasses/input.js'

export type View =
  | { kind: 'list'; title?: string; action: Action; empty?: string }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'boxes'; boxes: Box[]; input?: (input: Input) => void }

export const list = (spec: { title?: string; action: Action; empty?: string }): View => ({ kind: 'list', ...spec })

export const text = (spec: { title?: string; body: string }): View => ({ kind: 'text', ...spec })

export const boxes = (items: Box[], input?: (input: Input) => void): View => ({ kind: 'boxes', boxes: items, input })
