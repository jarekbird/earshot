import type { Action } from './action.js'
import type { Box, Picture } from './glasses/frame.js'

export type Bound = Action | { action: Action; target: string }

export interface Gestures {
  tap?: Bound
  up?: Bound
  down?: Bound
}

export type View =
  | { kind: 'list'; title?: string; action: Action; empty?: string }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'boxes'; boxes: Box[]; pictures?: Picture[]; on?: Gestures }

export const list = (spec: { title?: string; action: Action; empty?: string }): View => ({ kind: 'list', ...spec })

export const text = (spec: { title?: string; body: string }): View => ({ kind: 'text', ...spec })

export const boxes = (items: Box[], more: { on?: Gestures; pictures?: Picture[] } = {}): View => ({ kind: 'boxes', boxes: items, ...more })
